/**
 * GitHubSkillSource - reads the repositories skills were installed from, anonymously, through
 * the server's HTTP client.
 *
 * Everything is read by git's own content addresses: a repository's tree once per check, a folder
 * tree by its SHA, and each file by its blob SHA, which is checked against the bytes. A tree or
 * file named by its SHA never changes, so those are kept; a repository's tree at a branch is kept
 * for a while so opening a skill after a check costs nothing.
 *
 * GitHub allows 60 requests an hour without signing in, shared by everyone on the same network.
 * When it says the limit is used up, nothing more is asked until the time it gives, so a busy
 * page can't keep spending it. Renamed repositories answer with a redirect, which is followed.
 *
 * @module GitHubSkillSource
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientResponse } from "effect/http";

import { gitBlobSha, treeShaOfEntries } from "./SkillUpdatePlan.ts";

const API = "https://api.github.com";
const REQUEST_TIMEOUT = Duration.seconds(20);
/** How long a repository's tree at a branch is reused before it is asked for again. */
const REPO_TREE_TTL_MS = 15 * 60_000;
/** A check asked for again this soon reuses the answer, so the button can't spend the limit. */
const REFRESH_FLOOR_MS = 10_000;
const MAX_REPO_TREES = 20;
const MAX_FOLDER_TREES = 50;
const MAX_CACHED_BLOB_BYTES = 8 * 1024 * 1024;
/** Used when GitHub says the limit is used up but not until when. */
const DEFAULT_PAUSE_MS = 60_000;

export class SkillSourceError extends Schema.TaggedError<SkillSourceError>()("SkillSourceError", {
  /**
   * `rateLimited`: GitHub won't take more requests from this network until `retryAt`.
   * `notFound`: no such repository, branch or object, or a private repository.
   * `unavailable`: GitHub couldn't be reached or answered with something unexpected.
   */
  problem: Schema.Literals(["rateLimited", "notFound", "unavailable"]),
  /** Epoch milliseconds, for `rateLimited`. */
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.problem === "rateLimited"
      ? "GitHub's request limit is used up."
      : this.problem === "notFound"
        ? "GitHub doesn't have that repository or object."
        : "GitHub couldn't be read.";
  }
}

/** One entry of a GitHub tree listing. */
export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  /** `blob` for a file or link, `tree` for a folder, `commit` for a submodule. */
  readonly type: string;
  readonly sha: string;
  readonly size?: number | undefined;
}

export interface RepoTree {
  /** The listed tree's own SHA. */
  readonly sha: string;
  readonly entries: ReadonlyArray<TreeEntry>;
  /** GitHub cut the listing short, so something missing from it may still exist. */
  readonly truncated: boolean;
}

const TreeResponse = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
      size: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeTree = Schema.decodeUnknownEffect(TreeResponse);

const BlobResponse = Schema.Struct({
  sha: Schema.String,
  content: Schema.String,
  encoding: Schema.String,
});
const decodeBlob = Schema.decodeUnknownEffect(BlobResponse);

const OBJECT_SHA = /^[0-9a-f]{40}$/;
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Characters a branch or tag name may hold, which keeps it one path in the URL. */
const REF = /^(?!.*\.\.)[A-Za-z0-9._/@+-]{1,200}$/;

export class GitHubSkillSource extends Context.Service<
  GitHubSkillSource,
  {
    /**
     * The repository's whole tree at `ref`, or at its default branch. One request, reused for a
     * while; `refresh` asks again unless the last answer is only seconds old.
     */
    readonly repoTree: (input: {
      readonly repo: string;
      readonly ref?: string | undefined;
      readonly refresh?: boolean | undefined;
    }) => Effect.Effect<RepoTree, SkillSourceError>;
    /**
     * Every file under the tree with this SHA, or undefined when GitHub no longer has it. The
     * listing is checked against the SHA, so it is exactly that version.
     */
    readonly treeBySha: (input: {
      readonly repo: string;
      readonly sha: string;
    }) => Effect.Effect<RepoTree | undefined, SkillSourceError>;
    /** A file's bytes by its blob SHA, checked against it. */
    readonly blob: (input: {
      readonly repo: string;
      readonly sha: string;
    }) => Effect.Effect<Uint8Array, SkillSourceError>;
  }
>()("t3/skills/GitHubSkillSource") {}

/** Epoch milliseconds GitHub asks to wait until, when a response says the limit is used up. */
const rateLimitedUntil = (response: HttpClientResponse.HttpClientResponse, now: number) => {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const header = (name: string): string | undefined => response.headers[name];
  const retryAfter = Number(header("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  if (header("x-ratelimit-remaining") !== "0") {
    // A 429 is always a rate limit; a 403 without the header is a refusal of another kind.
    return response.status === 429 ? now + DEFAULT_PAUSE_MS : undefined;
  }
  const reset = Number(header("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset * 1000 > now ? reset * 1000 : now + DEFAULT_PAUSE_MS;
};

/** Keeps a map to `max` entries by dropping the oldest. */
const remember = <K, V>(map: Map<K, V>, key: K, value: V, max: number) => {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
};

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  let pausedUntil = 0;
  const repoTrees = new Map<string, { readonly at: number; readonly tree: RepoTree }>();
  const folderTrees = new Map<string, RepoTree>();
  const blobs = new Map<string, Uint8Array>();
  let blobBytes = 0;

  /** A GET of the API, as JSON; undefined when GitHub says there is no such thing. */
  const getJson = Effect.fnUntraced(function* (endpoint: string) {
    const now = yield* Clock.currentTimeMillis;
    if (now < pausedUntil) {
      return yield* new SkillSourceError({ problem: "rateLimited", retryAt: pausedUntil });
    }
    const response = yield* httpClient
      .get(`${API}/${endpoint}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "t3code-skill-updates",
          "x-github-api-version": "2022-11-28",
        },
      })
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) => new SkillSourceError({ problem: "unavailable", cause })),
      );
    const limited = rateLimitedUntil(response, now);
    if (limited !== undefined) {
      pausedUntil = limited;
      return yield* new SkillSourceError({ problem: "rateLimited", retryAt: limited });
    }
    // A 422 is GitHub refusing a ref or SHA it doesn't know.
    if (response.status === 404 || response.status === 422) return undefined;
    if (response.status !== 200) {
      return yield* new SkillSourceError({ problem: "unavailable" });
    }
    return yield* response.json.pipe(
      Effect.mapError((cause) => new SkillSourceError({ problem: "unavailable", cause })),
    );
  });

  const readTree = Effect.fnUntraced(function* (repo: string, treeish: string) {
    const json = yield* getJson(
      `repos/${repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`,
    );
    if (json === undefined) return undefined;
    const decoded = yield* decodeTree(json).pipe(
      Effect.mapError((cause) => new SkillSourceError({ problem: "unavailable", cause })),
    );
    return {
      sha: decoded.sha,
      truncated: decoded.truncated === true,
      entries: decoded.tree,
    } satisfies RepoTree;
  });

  const checkRepo = (repo: string) =>
    SOURCE.test(repo) ? Effect.void : Effect.fail(new SkillSourceError({ problem: "notFound" }));

  const repoTree: GitHubSkillSource["Service"]["repoTree"] = Effect.fn(
    "GitHubSkillSource.repoTree",
  )(function* (input) {
    yield* checkRepo(input.repo);
    if (input.ref !== undefined && !REF.test(input.ref)) {
      return yield* new SkillSourceError({ problem: "notFound" });
    }
    // GitHub ignores case in names, but not in a branch's.
    const key = `${input.repo.toLowerCase()}@${input.ref ?? ""}`;
    const now = yield* Clock.currentTimeMillis;
    const kept = repoTrees.get(key);
    if (kept && now - kept.at < (input.refresh ? REFRESH_FLOOR_MS : REPO_TREE_TTL_MS)) {
      return kept.tree;
    }
    const tree = yield* readTree(input.repo, input.ref ?? "HEAD");
    if (tree === undefined) return yield* new SkillSourceError({ problem: "notFound" });
    remember(repoTrees, key, { at: now, tree }, MAX_REPO_TREES);
    return tree;
  });

  const treeBySha: GitHubSkillSource["Service"]["treeBySha"] = Effect.fn(
    "GitHubSkillSource.treeBySha",
  )(function* (input) {
    yield* checkRepo(input.repo);
    if (!OBJECT_SHA.test(input.sha)) return undefined;
    const key = `${input.repo.toLowerCase()}@${input.sha}`;
    const kept = folderTrees.get(key);
    if (kept) return kept;
    const tree = yield* readTree(input.repo, input.sha);
    if (tree === undefined) return undefined;
    const files = tree.entries.filter((entry) => entry.type !== "tree");
    if (tree.truncated || tree.sha !== input.sha || treeShaOfEntries(files) !== input.sha) {
      return yield* new SkillSourceError({ problem: "unavailable" });
    }
    remember(folderTrees, key, tree, MAX_FOLDER_TREES);
    return tree;
  });

  const blob: GitHubSkillSource["Service"]["blob"] = Effect.fn("GitHubSkillSource.blob")(
    function* (input) {
      yield* checkRepo(input.repo);
      if (!OBJECT_SHA.test(input.sha)) return yield* new SkillSourceError({ problem: "notFound" });
      const kept = blobs.get(input.sha);
      if (kept) return kept;
      const json = yield* getJson(`repos/${input.repo}/git/blobs/${input.sha}`);
      if (json === undefined) return yield* new SkillSourceError({ problem: "notFound" });
      const decoded = yield* decodeBlob(json).pipe(
        Effect.mapError((cause) => new SkillSourceError({ problem: "unavailable", cause })),
      );
      const bytes =
        decoded.encoding === "base64"
          ? new Uint8Array(Buffer.from(decoded.content, "base64"))
          : new TextEncoder().encode(decoded.content);
      // Content addressing: bytes that don't hash to the SHA asked for are never used.
      if (gitBlobSha(bytes) !== input.sha) {
        return yield* new SkillSourceError({ problem: "unavailable" });
      }
      if (bytes.byteLength <= MAX_CACHED_BLOB_BYTES) {
        blobs.set(input.sha, bytes);
        blobBytes += bytes.byteLength;
        for (const [sha, old] of blobs) {
          if (blobBytes <= MAX_CACHED_BLOB_BYTES) break;
          blobs.delete(sha);
          blobBytes -= old.byteLength;
        }
      }
      return bytes;
    },
  );

  return GitHubSkillSource.of({ repoTree, treeBySha, blob });
});

export const layer = Layer.effect(GitHubSkillSource, make);
