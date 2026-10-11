/**
 * SkillUpdates - compares the skills the `skills` CLI installed from GitHub with their source, and
 * updates them without losing your edits.
 *
 * The CLI's lock is the only record: it names each skill's repository and the version the local
 * copy was installed from (the baseline). A global record holds the folder's git tree SHA, which
 * GitHub can list again; a project record holds a hash of the files, which can only be matched.
 * With the baseline, a difference from the source is either the source's change, yours, or both:
 *
 * - Only the source changed it: updating replaces the folder with the source's files.
 * - Both changed it: each file only one side changed takes that side, and a file both changed is
 *   merged with `git merge-file`. A merge that clashes, or a file with no baseline to tell, is
 *   never written with conflict markers: nothing is written until each such file is settled as
 *   yours or theirs.
 *
 * `npx skills update` reinstalls over local edits; this is what it would do for an unedited skill,
 * and it leaves the lock the way that command does, so the CLI then sees the skill as current.
 *
 * Writes are all or nothing. The new folder is built beside the old one under a hidden name no
 * agent reads, checked file by file against the plan, and swapped in with two renames, so links
 * to the folder keep working and other skills are never touched. An update applies exactly the
 * versions the person was shown (`upstreamSha`, `localSha`), or nothing.
 *
 * @module SkillUpdates
 */
import {
  SkillUpdateError,
  type SkillChangedFile,
  type SkillChangesInput,
  type SkillChangesResult,
  type SkillRequestError,
  type SkillUpdateCheckInput,
  type SkillUpdateCheckResult,
  type SkillUpdateEntry,
  type SkillUpdateInput,
  type SkillUpdateProblem,
  type SkillUpdateResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSkillSource from "./GitHubSkillSource.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import {
  computedHash,
  readFolder,
  readLockedSkills,
  recordBaseline,
  type HashedEntry,
  type LockedSkill,
} from "./SkillLockFiles.ts";
import {
  SKIPPED_DIRECTORIES,
  comparedSide,
  gitBlobSha,
  isBinary,
  isIgnoredPath,
  isScript,
  planFiles,
  sameFiles,
  treeShaOfEntries,
  type PlannedFile,
  type Side,
  type TreeItem,
} from "./SkillUpdatePlan.ts";

/** Changed files whose texts are read for showing; the rest are only counted. */
const SHOWN_FILES = 20;
const SHOWN_FILE_BYTES = 200 * 1024;
const SHOWN_TOTAL_BYTES = 1024 * 1024;
/** A file larger than this is never merged; both sides changing it is a conflict. */
const MAX_MERGE_BYTES = 4 * 1024 * 1024;
/**
 * Files a check may download to tell whether an edited project skill's source moved, since a
 * project record holds only a hash of the files. Reading the changes may download more.
 */
const CHECK_DOWNLOADS = 5;
const CHANGES_DOWNLOADS = 50;
const CONCURRENCY = 4;

export class SkillUpdates extends Context.Service<
  SkillUpdates,
  {
    /**
     * Compares every skill the CLI recorded, Global ones and, with `cwd`, the project's, with its
     * source. One GitHub request per repository; a project skill you edited may cost a few more.
     */
    readonly check: (
      input: SkillUpdateCheckInput,
    ) => Effect.Effect<SkillUpdateCheckResult, SkillRequestError>;
    /** What updating one skill would change, file by file. Nothing is written. */
    readonly changes: (
      input: SkillChangesInput,
    ) => Effect.Effect<SkillChangesResult, SkillRequestError>;
    /** Updates one skill, or records your copy as based on the source's version. */
    readonly update: (
      input: SkillUpdateInput,
    ) => Effect.Effect<SkillUpdateResult, SkillRequestError | SkillUpdateError>;
  }
>()("t3/skills/SkillUpdates") {}

/** A skill's own folder, read. */
interface Local {
  readonly entries: ReadonlyArray<HashedEntry>;
  readonly side: Side;
  /** The compared files. */
  readonly items: ReadonlyArray<TreeItem>;
  /** The compared files' tree SHA, which `localSha` pins. */
  readonly sha: string;
  /** Every file's tree SHA, which is the recorded `skillFolderHash` for an unedited copy. */
  readonly rawSha: string;
  readonly contentHash: string;
  readonly hasLinks: boolean;
  readonly byPath: ReadonlyMap<string, HashedEntry>;
  readonly bySha: ReadonlyMap<string, Uint8Array>;
}

/** The source's folder at one version. */
interface Upstream {
  /** The folder's git tree SHA, what a global record stores. */
  readonly sha: string;
  /** Every file under the folder, by path relative to it. */
  readonly files: ReadonlyArray<GitHubSkillSource.TreeEntry>;
  readonly side: Side;
  /** It holds links or submodules, which aren't updated. */
  readonly unsupported: boolean;
}

/** Where the comparison came out, with what it read. */
interface Comparison {
  readonly entry: SkillUpdateEntry;
  readonly local?: Local;
  readonly upstream?: Upstream;
  /** The version the local copy was installed from, as files; absent when not known. */
  readonly base?: Side;
}

const itemsOf = (entries: ReadonlyArray<HashedEntry>): TreeItem[] =>
  entries.map((entry) => ({
    path: entry.relative,
    mode: entry.kind === "link" ? "120000" : entry.executable ? "100755" : "100644",
    sha: gitBlobSha(entry.bytes),
  }));

const toLocal = (entries: ReadonlyArray<HashedEntry>): Local => {
  const items = itemsOf(entries);
  const compared = items.filter((item) => !isIgnoredPath(item.path));
  return {
    entries,
    side: comparedSide(items),
    items: compared,
    sha: treeShaOfEntries(compared),
    rawSha: treeShaOfEntries(items),
    contentHash: computedHash(entries),
    hasLinks: entries.some((entry) => entry.kind === "link"),
    byPath: new Map(entries.map((entry) => [entry.relative, entry])),
    bySha: new Map(entries.map((entry, index) => [items[index]?.sha ?? "", entry.bytes])),
  };
};

const toUpstream = (sha: string, files: ReadonlyArray<GitHubSkillSource.TreeEntry>): Upstream => ({
  sha,
  files,
  side: comparedSide(files.map(({ path, mode, sha: blob }) => ({ path, mode, sha: blob }))),
  unsupported: files.some(
    (file) => !isIgnoredPath(file.path) && (file.type !== "blob" || file.mode === "120000"),
  ),
});

/** The repository folder a record's skill is in, with its tree SHA. */
const folderOf = (tree: GitHubSkillSource.RepoTree, lock: LockedSkill) => {
  const folderSha = (folder: string) =>
    folder === ""
      ? tree.sha
      : tree.entries.find((entry) => entry.type === "tree" && entry.path === folder)?.sha;
  if (lock.skillPath !== undefined) {
    const folder = lock.skillPath
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/(?:^|\/)skill\.md$/i, "");
    const sha = folderSha(folder);
    return sha === undefined ? undefined : { path: folder, sha };
  }
  // Older records have no path: a folder named like the skill with a SKILL.md, shallowest first.
  const folder = tree.entries
    .filter((entry) => entry.type === "blob" && /(?:^|\/)skill\.md$/i.test(entry.path))
    .map((entry) => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))))
    .filter((dir) => dir.split("/").pop() === lock.name)
    .toSorted((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))[0];
  const sha = folder === undefined ? undefined : folderSha(folder);
  return folder === undefined || sha === undefined ? undefined : { path: folder, sha };
};

/** The files under `folder` in a full listing, by path relative to it. */
const filesUnder = (tree: GitHubSkillSource.RepoTree, folder: string) => {
  const prefix = folder === "" ? "" : `${folder}/`;
  return tree.entries
    .filter((entry) => entry.type !== "tree" && entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
};

/** A path from a listing that stays inside the folder it is joined to. */
const isSafePath = (path: string) =>
  path !== "" &&
  !/[\\\0]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const retryAtOf = (error: GitHubSkillSource.SkillSourceError) =>
  error.retryAt === undefined
    ? {}
    : { retryAt: DateTime.formatIso(DateTime.makeUnsafe(error.retryAt)) };

const updateError = (error: GitHubSkillSource.SkillSourceError) =>
  new SkillUpdateError({ reason: error.problem, ...retryAtOf(error) });

const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const unknown = (
  entry: Omit<SkillUpdateEntry, "state">,
  problem: SkillUpdateProblem,
  extra: { readonly retryAt?: string } = {},
): Comparison => ({ entry: { ...entry, state: "unknown", problem, ...extra } });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const catalog = yield* SkillCatalog.SkillCatalog;
  const source = yield* GitHubSkillSource.GitHubSkillSource;
  const vcs = yield* VcsProcess.VcsProcess;
  // The lock reader and writer take the filesystem from their environment.
  const filesystemContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const writeLock = yield* Semaphore.make(1);

  const lockedSkills = (projectRoot: string | undefined) =>
    readLockedSkills({ environment, home: homeDirectory, projectRoot }).pipe(
      Effect.provide(filesystemContext),
    );

  const readLocal = (home: string) =>
    readFolder(home, SKIPPED_DIRECTORIES).pipe(
      Effect.provide(filesystemContext),
      Effect.map((entries) => (entries === undefined ? undefined : toLocal(entries))),
    );

  /** The source's folder for a record, from a listing of its repository. */
  const upstreamIn = Effect.fnUntraced(function* (
    tree: GitHubSkillSource.RepoTree,
    lock: LockedSkill,
  ) {
    const folder = folderOf(tree, lock);
    if (folder === undefined) return undefined;
    // A cut-off listing may miss some of the folder's files; its own listing has them all.
    if (!tree.truncated) return toUpstream(folder.sha, filesUnder(tree, folder.path));
    const own = yield* source.treeBySha({ repo: lock.source, sha: folder.sha });
    return own === undefined ? undefined : toUpstream(folder.sha, filesUnder(own, ""));
  });

  /**
   * The CLI's `computedHash` of the source's files, the way it hashes a download (with the files
   * an install leaves out) and the way it hashes an install (without them). Files the local copy
   * has are read from it; at most `downloads` others are fetched, else undefined.
   */
  const upstreamContentHashes = Effect.fnUntraced(function* (
    repo: string,
    upstream: Upstream,
    local: Local,
    downloads: number,
  ) {
    const regular = upstream.files.filter((file) => file.type === "blob" && file.mode !== "120000");
    const missing = regular.filter((file) => !local.bySha.has(file.sha));
    if (missing.length > downloads) return undefined;
    const fetched = new Map(
      yield* Effect.forEach(
        missing,
        (file) =>
          source
            .blob({ repo, sha: file.sha })
            .pipe(Effect.map((bytes) => [file.sha, bytes] as const)),
        { concurrency: CONCURRENCY },
      ),
    );
    const files = regular.map((file) => ({
      relative: file.path,
      kind: "file" as const,
      bytes: local.bySha.get(file.sha) ?? fetched.get(file.sha) ?? new Uint8Array(),
    }));
    return [
      computedHash(files),
      computedHash(files.filter((file) => !isIgnoredPath(file.relative))),
    ];
  });

  /**
   * Tells the source's changes from yours. `downloads` bounds what an edited project skill may
   * fetch to find out; a global skill's baseline is fetched only when `downloads` allows any
   * beyond a check's.
   */
  const compareWith = Effect.fnUntraced(function* (
    entry: Omit<SkillUpdateEntry, "state">,
    lock: LockedSkill,
    local: Local,
    upstream: Upstream,
    downloads: number,
  ) {
    const result = (
      state: SkillUpdateEntry["state"],
      base: Side | undefined,
      edited?: boolean,
    ): Comparison => ({
      entry: { ...entry, state, ...(edited === undefined ? {} : { edited }) },
      local,
      upstream,
      ...(base === undefined ? {} : { base }),
    });
    if (sameFiles(local.side, upstream.side)) return result("current", upstream.side);
    const baseline = lock.baseline;
    if (baseline === undefined) return result("differs", undefined);
    if (baseline.kind === "tree") {
      if (upstream.sha === baseline.sha) return result("edited", upstream.side);
      // An install lacks the files the CLI leaves out, so with the source's own copies of them
      // added back, an unedited copy hashes to the recorded version, as long as those files
      // didn't change. A matching hash proves it; a different one proves nothing.
      const leftOut = upstream.files
        .filter((file) => isIgnoredPath(file.path))
        .map(({ path: file, mode, sha }) => ({ path: file, mode, sha }));
      if (
        local.rawSha === baseline.sha ||
        treeShaOfEntries([...local.items, ...leftOut]) === baseline.sha
      ) {
        return result("update", local.side, false);
      }
      if (downloads <= CHECK_DOWNLOADS) return result("update", undefined);
      const baseTree = yield* source.treeBySha({ repo: lock.source, sha: baseline.sha });
      // GitHub no longer has the version it was installed from, so no file can be told apart.
      if (baseTree === undefined) return result("update", undefined, true);
      const base = comparedSide(
        filesUnder(baseTree, "").map(({ path: file, mode, sha }) => ({ path: file, mode, sha })),
      );
      return result("update", base, !sameFiles(base, local.side));
    }
    if (local.contentHash === baseline.hash) return result("update", local.side, false);
    const hashes = yield* upstreamContentHashes(lock.source, upstream, local, downloads);
    if (hashes === undefined) return result("differs", undefined);
    return hashes.includes(baseline.hash)
      ? result("edited", upstream.side)
      : result("update", undefined, true);
  });

  /** Compares one recorded skill with its source's listing. */
  const compareListed = Effect.fnUntraced(function* (
    entry: Omit<SkillUpdateEntry, "state">,
    skill: SkillCatalog.ResolvedSkill,
    lock: LockedSkill,
    tree: Result.Result<GitHubSkillSource.RepoTree, GitHubSkillSource.SkillSourceError>,
    downloads: number,
  ) {
    if (Result.isFailure(tree)) return yield* tree.failure;
    const upstream = yield* upstreamIn(tree.success, lock);
    if (upstream === undefined) {
      return tree.success.truncated
        ? unknown(entry, "tooLarge")
        : ({ entry: { ...entry, state: "removed" } } satisfies Comparison);
    }
    if (upstream.unsupported) return unknown(entry, "unsupported");
    const local = yield* readLocal(skill.home);
    if (local === undefined) return unknown(entry, "unreadable");
    return yield* compareWith(entry, lock, local, upstream, downloads);
  });

  /** Compares one recorded skill with its source; a source that can't be read is `unknown`. */
  const compare = (
    skill: SkillCatalog.ResolvedSkill,
    lock: LockedSkill,
    tree: Result.Result<GitHubSkillSource.RepoTree, GitHubSkillSource.SkillSourceError>,
    downloads: number,
  ) => {
    const entry = {
      scope: skill.scope,
      name: skill.name,
      home: skill.displayHome,
      source: lock.source,
    };
    return compareListed(entry, skill, lock, tree, downloads).pipe(
      Effect.catchTags({
        SkillSourceError: (error) =>
          Effect.succeed(unknown(entry, error.problem, retryAtOf(error))),
      }),
    );
  };

  /** The recorded skills found in the agents' folders, each with its record. */
  const recorded = Effect.fnUntraced(function* (cwd: string | undefined) {
    const locks = yield* lockedSkills(cwd);
    const resolved = yield* catalog.resolve({
      cwd,
      skills: locks.map((lock) => ({ scope: lock.scope.kind, name: lock.name })),
    });
    return resolved.flatMap((skill) => {
      const lock = locks.find(
        (item) => item.scope.kind === skill.scope && item.name === skill.name,
      );
      return lock === undefined ? [] : [{ skill, lock }];
    });
  });

  const repoKey = (lock: LockedSkill) => `${lock.source.toLowerCase()}@${lock.ref ?? ""}`;

  const check: SkillUpdates["Service"]["check"] = Effect.fn("SkillUpdates.check")(
    function* (input) {
      const pairs = yield* recorded(input.cwd);
      const repos = new Map(pairs.map(({ lock }) => [repoKey(lock), lock]));
      const trees = new Map(
        yield* Effect.forEach(
          [...repos],
          ([key, lock]) =>
            source.repoTree({ repo: lock.source, ref: lock.ref, refresh: input.refresh }).pipe(
              Effect.result,
              Effect.map((tree) => [key, tree] as const),
            ),
          { concurrency: CONCURRENCY },
        ),
      );
      const entries = yield* Effect.forEach(
        pairs,
        ({ skill, lock }) => {
          const tree = trees.get(repoKey(lock));
          return tree === undefined
            ? Effect.die("A repository's listing is missing.")
            : compare(skill, lock, tree, CHECK_DOWNLOADS);
        },
        { concurrency: CONCURRENCY },
      );
      return {
        entries: entries
          .map((item) => item.entry)
          .toSorted(
            (a, b) =>
              a.scope.localeCompare(b.scope) ||
              a.name.localeCompare(b.name) ||
              a.home.localeCompare(b.home),
          ),
      };
    },
  );

  /** The skill a request names, with its record, or undefined when either is gone. */
  const findOne = Effect.fnUntraced(function* (input: SkillChangesInput) {
    const pairs = yield* recorded(input.cwd);
    return pairs.find(
      ({ skill }) =>
        skill.scope === input.scope &&
        skill.name === input.name &&
        skill.displayHome === input.home,
    );
  });

  /** A file of the source, by its blob SHA, from the local copy when it has the same bytes. */
  const upstreamBytes = (repo: string, local: Local, sha: string) => {
    const kept = local.bySha.get(sha);
    return kept === undefined ? source.blob({ repo, sha }) : Effect.succeed(kept);
  };

  /** The base, yours and theirs merged by `git merge-file`, or undefined when they clash. */
  const mergeText = Effect.fnUntraced(function* (
    mine: Uint8Array,
    base: Uint8Array,
    theirs: Uint8Array,
  ) {
    const sides = [mine, base, theirs];
    if (sides.some((bytes) => bytes.byteLength > MAX_MERGE_BYTES || isBinary(bytes))) {
      return undefined;
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-skill-merge-",
        });
        const names = ["mine", "base", "theirs"];
        yield* Effect.forEach(names, (name, index) =>
          fileSystem.writeFile(path.join(folder, name), sides[index] ?? new Uint8Array()),
        );
        const result = yield* vcs.run({
          operation: "SkillUpdates.merge",
          command: "git",
          args: ["merge-file", "-p", "-q", ...names],
          cwd: folder,
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: MAX_MERGE_BYTES * 3,
        });
        // A non-zero exit is the number of conflicts; the output then has markers in it.
        return result.exitCode === 0 && !result.stdoutTruncated && result.stdoutInvalidUtf8 !== true
          ? result.stdout
          : undefined;
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
  });

  const changes: SkillUpdates["Service"]["changes"] = Effect.fn("SkillUpdates.changes")(
    function* (input) {
      const found = yield* findOne(input);
      if (found === undefined) return { entry: null, files: [], more: 0 };
      const { skill, lock } = found;
      const tree = yield* source.repoTree({ repo: lock.source, ref: lock.ref }).pipe(Effect.result);
      const comparison = yield* compare(skill, lock, tree, CHANGES_DOWNLOADS);
      const { entry, local, upstream, base } = comparison;
      if (
        local === undefined ||
        upstream === undefined ||
        (entry.state !== "update" && entry.state !== "differs")
      ) {
        return { entry, files: [], more: 0 };
      }
      const planned = planFiles(local.side, upstream.side, base);
      let budget = SHOWN_TOTAL_BYTES;
      const shown = yield* Effect.forEach(
        planned.slice(0, SHOWN_FILES),
        (file) =>
          describeFile(lock.source, file, local, upstream, base, (bytes) => {
            if (bytes > budget) return false;
            budget -= bytes;
            return true;
          }),
        // One at a time, so the text budget goes to the files in order.
        { concurrency: 1 },
      ).pipe(Effect.catchTags({ SkillSourceError: () => Effect.succeed(undefined) }));
      if (shown === undefined) {
        return {
          entry: { ...entry, state: "unknown", problem: "unavailable" },
          files: [],
          more: 0,
        };
      }
      return {
        entry,
        upstreamSha: upstream.sha,
        localSha: local.sha,
        files: shown,
        more: planned.length - shown.length,
      };
    },
  );

  /** One changed file as shown: both texts, and what a merge makes of it. */
  const describeFile = Effect.fnUntraced(function* (
    repo: string,
    file: PlannedFile,
    local: Local,
    upstream: Upstream,
    base: Side | undefined,
    spend: (bytes: number) => boolean,
  ) {
    const mineEntry = local.byPath.get(file.path);
    const theirsEntry = upstream.files.find((item) => item.path === file.path);
    const mineBytes = mineEntry?.bytes;
    const theirsSize = theirsEntry?.size ?? 0;
    const script = isScript(
      file.path,
      mineEntry?.executable === true || theirsEntry?.mode === "100755",
      mineBytes,
    );
    const fits = (mineBytes?.byteLength ?? 0) <= SHOWN_FILE_BYTES && theirsSize <= SHOWN_FILE_BYTES;
    // Showing a file, or merging it, needs the source's bytes.
    const needsTheirs = theirsEntry !== undefined && (fits || file.outcome === "merge");
    const theirsBytes = needsTheirs
      ? yield* upstreamBytes(repo, local, theirsEntry.sha)
      : undefined;
    let merge: SkillChangedFile["merge"] = file.outcome === "merge" ? "conflict" : file.outcome;
    let merged: string | undefined;
    const baseSha = base?.get(file.path)?.sha;
    if (file.outcome === "merge" && mineBytes && theirsBytes && baseSha) {
      const baseBytes = yield* upstreamBytes(repo, local, baseSha);
      merged = yield* mergeText(mineBytes, baseBytes, theirsBytes);
      if (merged !== undefined) merge = "merged";
    }
    const binary =
      (mineBytes !== undefined && isBinary(mineBytes)) ||
      (theirsBytes !== undefined && isBinary(theirsBytes));
    const cost =
      (mineBytes?.byteLength ?? 0) + (theirsBytes?.byteLength ?? 0) + (merged?.length ?? 0);
    const omitted = binary ? "binary" : !fits || !spend(cost) ? "tooLarge" : undefined;
    return {
      path: file.path,
      change: file.change,
      merge,
      mine: omitted || !mineBytes ? null : decodeText(mineBytes),
      theirs: omitted || !theirsBytes ? null : decodeText(theirsBytes),
      ...(merged !== undefined && omitted === undefined ? { merged } : {}),
      ...(omitted ? { omitted } : {}),
      script,
    } satisfies SkillChangedFile;
  });

  /** One file of the new folder: its bytes and mode, or undefined to remove it. */
  type Write = {
    readonly path: string;
    readonly bytes: Uint8Array | undefined;
    readonly mode?: number | undefined;
  };

  /**
   * Builds the new folder beside `home` and swaps it in. The old folder is renamed aside first
   * and put back if the new one can't take its place, so `home` is never left half written.
   */
  const stageAndSwap = Effect.fnUntraced(function* (
    home: string,
    writes: ReadonlyArray<Write>,
    expected: Side,
  ) {
    const failed = () => new SkillUpdateError({ reason: "writeFailed" });
    const info = yield* fileSystem.stat(home).pipe(Effect.mapError(failed));
    const box = yield* fileSystem
      .makeTempDirectory({ directory: path.dirname(home), prefix: ".t3-skill-update-" })
      .pipe(Effect.mapError(failed));
    const staged = path.join(box, "new");
    const old = path.join(box, "old");
    yield* Effect.gen(function* () {
      yield* fileSystem.copy(home, staged);
      yield* fileSystem.chmod(staged, info.mode & 0o7777);
      for (const write of writes) {
        const target = path.join(staged, ...write.path.split("/"));
        if (write.bytes === undefined) {
          yield* fileSystem.remove(target);
          // A folder the removal emptied goes too, as it would in a git checkout.
          for (
            let folder = path.dirname(target);
            folder !== staged;
            folder = path.dirname(folder)
          ) {
            if ((yield* fileSystem.readDirectory(folder)).length > 0) break;
            yield* fileSystem.remove(folder);
          }
          continue;
        }
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFile(target, write.bytes);
        if (write.mode !== undefined) yield* fileSystem.chmod(target, write.mode);
      }
    }).pipe(
      Effect.mapError(failed),
      Effect.andThen(
        Effect.gen(function* () {
          const written = yield* readFolder(staged, SKIPPED_DIRECTORIES).pipe(
            Effect.provide(filesystemContext),
          );
          if (written === undefined || !sameFiles(comparedSide(itemsOf(written)), expected)) {
            return yield* failed();
          }
          yield* fileSystem.rename(home, old).pipe(Effect.mapError(failed));
          yield* fileSystem
            .rename(staged, home)
            .pipe(
              Effect.catch(() =>
                fileSystem
                  .rename(old, home)
                  .pipe(Effect.ignore, Effect.andThen(Effect.fail(failed()))),
              ),
            );
        }),
      ),
      Effect.ensuring(fileSystem.remove(box, { recursive: true }).pipe(Effect.ignore)),
    );
  });

  const update: SkillUpdates["Service"]["update"] = Effect.fn("SkillUpdates.update")(
    function* (input) {
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const none = (status: SkillUpdateResult["status"]): SkillUpdateResult => ({
            status,
            conflicts: [],
          });
          const found = yield* findOne(input);
          if (found === undefined) return none("notFound");
          const { skill, lock } = found;
          if (!lock.writable) return yield* new SkillUpdateError({ reason: "lockUnsupported" });
          const local = yield* readLocal(skill.home);
          if (local === undefined) return yield* new SkillUpdateError({ reason: "unreadable" });
          if (local.sha !== input.localSha) return none("changed");
          if (local.hasLinks) return yield* new SkillUpdateError({ reason: "unsupported" });

          // The source's folder at exactly the version that was shown.
          const tree = yield* source
            .repoTree({ repo: lock.source, ref: lock.ref })
            .pipe(Effect.mapError(updateError));
          const listed = yield* upstreamIn(tree, lock).pipe(Effect.mapError(updateError));
          const pinned =
            listed?.sha === input.upstreamSha
              ? listed
              : yield* source.treeBySha({ repo: lock.source, sha: input.upstreamSha }).pipe(
                  Effect.mapError(updateError),
                  Effect.map((own) =>
                    own === undefined
                      ? undefined
                      : toUpstream(input.upstreamSha, filesUnder(own, "")),
                  ),
                );
          if (pinned === undefined) return none("changed");
          if (pinned.unsupported || !pinned.files.every((file) => isSafePath(file.path))) {
            return yield* new SkillUpdateError({ reason: "unsupported" });
          }
          const entry = {
            scope: skill.scope,
            name: skill.name,
            home: skill.displayHome,
            source: lock.source,
          };
          const { base } = yield* compareWith(entry, lock, local, pinned, CHANGES_DOWNLOADS).pipe(
            Effect.mapError(updateError),
          );

          const theirsOf = (file: string) => pinned.files.find((item) => item.path === file);
          const theirsWrite = Effect.fnUntraced(function* (file: string) {
            const theirs = theirsOf(file);
            if (theirs === undefined) return { path: file, bytes: undefined } satisfies Write;
            const bytes = yield* upstreamBytes(lock.source, local, theirs.sha);
            return {
              path: file,
              bytes,
              mode: theirs.mode === "100755" ? 0o755 : 0o644,
            } satisfies Write;
          });

          const planned = planFiles(local.side, pinned.side, base);
          const writes: Write[] = [];
          const conflicts: string[] = [];
          if (input.choice !== "mine") {
            for (const file of planned) {
              const outcome = input.choice === "theirs" ? "theirs" : file.outcome;
              if (outcome === "mine") continue;
              if (outcome === "theirs") {
                writes.push(yield* theirsWrite(file.path).pipe(Effect.mapError(updateError)));
                continue;
              }
              const mineBytes = local.byPath.get(file.path)?.bytes;
              const theirs = theirsOf(file.path);
              const baseSha = base?.get(file.path)?.sha;
              if (outcome === "merge" && mineBytes && theirs && baseSha) {
                const merged = yield* Effect.all([
                  upstreamBytes(lock.source, local, baseSha),
                  upstreamBytes(lock.source, local, theirs.sha),
                ]).pipe(
                  Effect.mapError(updateError),
                  Effect.flatMap(([baseBytes, theirsBytes]) =>
                    mergeText(mineBytes, baseBytes, theirsBytes),
                  ),
                );
                if (merged !== undefined) {
                  writes.push({ path: file.path, bytes: new TextEncoder().encode(merged) });
                  continue;
                }
              }
              const resolution = input.resolutions?.[file.path];
              if (resolution === "theirs") {
                writes.push(yield* theirsWrite(file.path).pipe(Effect.mapError(updateError)));
              } else if (resolution !== "mine") {
                conflicts.push(file.path);
              }
            }
          }
          if (conflicts.length > 0) {
            return { status: "conflicts", conflicts } satisfies SkillUpdateResult;
          }

          // What the lock records: the version taken, hashed the way its kind of record is. A
          // project record gets the hash `npx skills update` compares, over every file it
          // downloads, so the CLI then sees the skill as current.
          const contentHash =
            lock.scope.kind === "global"
              ? undefined
              : (yield* upstreamContentHashes(
                  lock.source,
                  pinned,
                  local,
                  Number.POSITIVE_INFINITY,
                ).pipe(Effect.mapError(updateError)))?.[0];
          const baseline =
            lock.scope.kind === "global"
              ? { skillFolderHash: pinned.sha }
              : contentHash === undefined
                ? undefined
                : { computedHash: contentHash };

          if (writes.length > 0) {
            const expected = new Map(local.side);
            for (const write of writes) {
              if (write.bytes === undefined) expected.delete(write.path);
              else if (!isIgnoredPath(write.path)) {
                expected.set(write.path, { sha: gitBlobSha(write.bytes), mode: "" });
              }
            }
            yield* stageAndSwap(skill.home, writes, expected);
          }
          const recorded =
            baseline !== undefined &&
            (yield* recordBaseline({
              scope: lock.scope,
              name: lock.name,
              source: lock.source,
              baseline,
              environment,
              home: homeDirectory,
            }).pipe(
              Effect.provide(filesystemContext),
              Effect.orElseSucceed(() => false),
            ));
          return {
            status: writes.length > 0 ? "updated" : "kept",
            conflicts: [],
            ...(recorded ? {} : { lockStale: true }),
          } satisfies SkillUpdateResult;
        }),
      );
    },
  );

  return SkillUpdates.of({ check, changes, update });
});

export const layer = Layer.effect(SkillUpdates, make);
