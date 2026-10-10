import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  type SkillUpdateEntry,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSkillSource from "./GitHubSkillSource.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { RegisteredProjects } from "./SkillLibrary.ts";
import { computedHash } from "./SkillLockFiles.ts";
import * as SkillUpdates from "./SkillUpdates.ts";

const SOURCE = "acme/skills";

const skillFile = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}`;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return (yield* runner.run({
      command: "git",
      args: [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "core.fileMode=true",
        ...args,
      ],
    })).stdout;
  }).pipe(Effect.provide(ProcessRunner.layer));

/** A response GitHub's REST API gives, as recorded: status, the headers that matter, and a body. */
interface Recorded {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

/** GitHub's answer to an anonymous request once the hourly limit is used up, as it sends it. */
const RATE_LIMITED: Recorded = {
  status: 403,
  headers: {
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "4102444800",
    "x-ratelimit-used": "60",
    "x-ratelimit-resource": "core",
  },
  body: {
    message:
      "API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)",
    documentation_url:
      "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
  },
};
const NOT_FOUND: Recorded = {
  status: 404,
  body: {
    message: "Not Found",
    documentation_url: "https://docs.github.com/rest/git/trees#get-a-tree",
    status: "404",
  },
};

/**
 * A stand-in for api.github.com that answers from a real git repository, in the shape GitHub's
 * REST API answers: `git/trees/<ref or sha>?recursive=1` and `git/blobs/<sha>` for `acme/skills`.
 * `snapshot` records what the repository holds now; `override` answers every request instead.
 */
const makeFakeGitHub = (repo: string) => {
  const responses = new Map<string, Recorded>();
  const requests: string[] = [];
  let override: Recorded | undefined;
  const listing = (tree: string) =>
    Effect.gen(function* () {
      const lines = (yield* git(repo, ["ls-tree", "-r", "-t", "-l", tree])).trim().split("\n");
      return lines
        .filter((line) => line !== "")
        .map((line) => {
          const [meta = "", path = ""] = line.split("\t");
          const [mode = "", type = "", sha = "", size = "-"] = meta.split(/\s+/);
          return {
            path,
            mode,
            type,
            sha,
            ...(type === "blob" ? { size: Number(size) } : {}),
            url: `https://api.github.com/repos/${SOURCE}/git/${type}s/${sha}`,
          };
        });
    });
  const snapshot = Effect.gen(function* () {
    const commits = (yield* git(repo, ["rev-list", "--all"])).trim().split("\n");
    const trees = new Set<string>();
    for (const commit of commits) {
      const root = (yield* git(repo, ["rev-parse", `${commit}^{tree}`])).trim();
      trees.add(root);
      for (const entry of yield* listing(root)) {
        if (entry.type === "tree") trees.add(entry.sha);
        if (entry.type === "blob" && !responses.has(`blobs/${entry.sha}`)) {
          const content = yield* git(repo, ["cat-file", "blob", entry.sha]);
          responses.set(`blobs/${entry.sha}`, {
            status: 200,
            body: {
              sha: entry.sha,
              node_id: "B_kwDOAAAAAA",
              size: entry.size,
              url: entry.url,
              // GitHub wraps the base64 at 60 characters.
              content: Buffer.from(content)
                .toString("base64")
                .replace(/(.{60})/g, "$1\n"),
              encoding: "base64",
            },
          });
        }
      }
    }
    const treeResponse = (sha: string) =>
      Effect.map(listing(sha), (tree) => ({
        status: 200,
        body: {
          sha,
          url: `https://api.github.com/repos/${SOURCE}/git/trees/${sha}`,
          tree,
          truncated: false,
        },
      }));
    for (const sha of trees) responses.set(`trees/${sha}`, yield* treeResponse(sha));
    const head = (yield* git(repo, ["rev-parse", "HEAD^{tree}"])).trim();
    responses.set("trees/HEAD", yield* treeResponse(head));
  });
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    const match = /\/repos\/acme\/skills\/git\/((?:trees|blobs)\/[^?/]+)/.exec(request.url);
    const recorded = override ?? (match ? responses.get(match[1] ?? "") : undefined) ?? NOT_FOUND;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(recorded.body), {
          status: recorded.status,
          headers: { "content-type": "application/json", ...recorded.headers },
        }),
      ),
    );
  });
  return {
    snapshot,
    requests,
    layer: Layer.succeed(HttpClient.HttpClient, client),
    answerEverything: (response: Recorded | undefined) => {
      override = response;
    },
  };
};

/**
 * A machine with an upstream repository `acme/skills`, its skills installed from the first commit
 * into the home folder and recorded in the global lock as the skills CLI writes it.
 */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-updates-" }));
  const home = path.join(root, "home");
  const upstream = path.join(root, "upstream");
  const write = (file: string, contents: string, mode?: number) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, contents);
      if (mode !== undefined) yield* fs.chmod(file, mode);
    });
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git(upstream, ["add", "-A"]);
      yield* git(upstream, ["commit", "-q", "-m", message]);
    });
  yield* fs.makeDirectory(upstream, { recursive: true });
  yield* git(upstream, ["init", "-q", "."]);
  yield* write(
    path.join(upstream, "skills/tdd/SKILL.md"),
    skillFile("tdd", "Red.\nGreen.\nRefactor.\n\nKeep tests small.\n"),
  );
  yield* write(path.join(upstream, "skills/tdd/notes.md"), "First note.\n");
  yield* write(path.join(upstream, "skills/tdd/metadata.json"), '{"version":"1"}\n');
  yield* write(
    path.join(upstream, "skills/prd/SKILL.md"),
    skillFile("prd", "Ask three questions.\n"),
  );
  yield* write(path.join(upstream, "README.md"), "Skills.\n");
  yield* commit("first");
  const folderSha = (folder: string) =>
    Effect.map(git(upstream, ["rev-parse", `HEAD:${folder}`]), (out) => out.trim());

  /** Copies a folder of the repository the way the CLI installs it: without `metadata.json`. */
  const install = (folder: string, target: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(target, { recursive: true });
      for (const name of yield* fs.readDirectory(path.join(upstream, folder))) {
        if (name === "metadata.json") continue;
        yield* fs.copy(path.join(upstream, folder, name), path.join(target, name));
      }
    });

  const globalSkills = path.join(home, ".agents/skills");
  yield* install("skills/tdd", path.join(globalSkills, "tdd"));
  yield* install("skills/prd", path.join(globalSkills, "prd"));
  const lock = {
    version: 3,
    skills: {
      tdd: {
        source: SOURCE,
        sourceType: "github",
        sourceUrl: `https://github.com/${SOURCE}.git`,
        skillPath: "skills/tdd/SKILL.md",
        skillFolderHash: yield* folderSha("skills/tdd"),
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pluginName: "acme",
      },
      prd: {
        source: SOURCE,
        sourceType: "github",
        sourceUrl: `https://github.com/${SOURCE}.git`,
        skillPath: "skills/prd/SKILL.md",
        skillFolderHash: yield* folderSha("skills/prd"),
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    dismissed: {},
    lastSelectedAgents: ["opencode"],
  };
  const lockPath = path.join(home, ".agents/.skill-lock.json");
  // The CLI writes the global lock with no trailing newline.
  yield* write(lockPath, JSON.stringify(lock, null, 2));
  const github = makeFakeGitHub(upstream);
  yield* github.snapshot;
  return {
    fs,
    path,
    home,
    upstream,
    globalSkills,
    lockPath,
    write,
    commit,
    folderSha,
    install,
    github,
    /** Commits a change upstream and lets the fake GitHub serve it. */
    push: <E>(message: string, change: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        yield* change;
        yield* commit(message);
        yield* github.snapshot;
      }),
  };
});

type Machine = Effect.Success<typeof makeMachine>;

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-updates"),
  title: "acme-web",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const withUpdates = <A, E, R>(
  machine: Machine,
  registered: readonly string[],
  use: (updates: SkillUpdates.SkillUpdates["Service"]) => Effect.Effect<A, E, R>,
) => {
  const projects = Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: (root) =>
      Effect.succeed(registered.includes(root) ? Option.some(makeProject(root)) : Option.none()),
    listShells: () =>
      Effect.succeed(registered.map((workspaceRoot) => ({ workspaceRoot }) as never)),
  });
  const catalog = SkillCatalog.layer.pipe(
    Layer.provide(
      Settings.layerTest({
        providerInstances: {
          [ProviderInstanceId.make("opencode")]: {
            driver: ProviderDriverKind.make("opencode"),
            enabled: true,
          },
        },
      }),
    ),
    Layer.provide(projects),
  );
  return Effect.gen(function* () {
    return yield* use(yield* SkillUpdates.SkillUpdates);
  }).pipe(
    Effect.provide(
      SkillUpdates.layer.pipe(
        Layer.provide(catalog),
        Layer.provide(GitHubSkillSource.layer.pipe(Layer.provide(machine.github.layer))),
        Layer.provide(VcsProcess.layer),
      ),
    ),
    Effect.provideService(HostProcess.Environment, { HOME: machine.home }),
    Effect.provideService(HostProcess.HomeDirectory, machine.home),
    Effect.provideService(RegisteredProjects, Effect.succeed(registered)),
  );
};

const entryOf = (entries: readonly SkillUpdateEntry[], name: string) => {
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`No entry for ${name}`);
  return entry;
};

const ref = (name: string) => ({
  scope: "global" as const,
  name,
  home: `~/.agents/skills/${name}`,
});

const treeRequests = (machine: Machine) =>
  machine.github.requests.filter((url) => url.includes("/git/trees/")).length;

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillUpdates", (it) => {
  describe("check", () => {
    it.effect(
      "says an untouched install is current, even without the files the CLI leaves out",
      () =>
        Effect.gen(function* () {
          const machine = yield* makeMachine;
          yield* withUpdates(machine, [], (updates) =>
            Effect.gen(function* () {
              const { entries } = yield* updates.check({});
              expect(entries.map((entry) => [entry.name, entry.state])).toEqual([
                ["prd", "current"],
                ["tdd", "current"],
              ]);
              // Both skills come from one repository, which is asked once.
              expect(treeRequests(machine)).toBe(1);
            }),
          );
        }),
    );

    it.effect("tells the source's change from yours", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const { fs, path } = machine;
        // Upstream changes tdd; you edit prd, which upstream leaves alone.
        yield* machine.push(
          "tdd v2",
          fs.writeFileString(path.join(machine.upstream, "skills/tdd/notes.md"), "Second note.\n"),
        );
        yield* fs.writeFileString(
          path.join(machine.globalSkills, "prd/SKILL.md"),
          skillFile("prd", "Ask until the goal is clear.\n"),
        );
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const { entries } = yield* updates.check({});
            expect(entryOf(entries, "tdd")).toMatchObject({ state: "update", edited: false });
            expect(entryOf(entries, "prd").state).toBe("edited");
          }),
        );
      }),
    );

    it.effect("says when GitHub's limit is used up, and stops asking until it resets", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        machine.github.answerEverything(RATE_LIMITED);
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const first = yield* updates.check({ refresh: true });
            expect(entryOf(first.entries, "tdd")).toMatchObject({
              state: "unknown",
              problem: "rateLimited",
              retryAt: "2100-01-01T00:00:00.000Z",
            });
            const asked = machine.github.requests.length;
            yield* updates.check({ refresh: true });
            expect(machine.github.requests.length).toBe(asked);
          }),
        );
      }),
    );

    it.effect("says a repository GitHub doesn't have is not found", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        machine.github.answerEverything(NOT_FOUND);
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const { entries } = yield* updates.check({});
            expect(entryOf(entries, "tdd")).toMatchObject({
              state: "unknown",
              problem: "notFound",
            });
          }),
        );
      }),
    );
  });

  describe("update", () => {
    it.effect.skipIf(!symlinksSupported)(
      "replaces an unedited skill with the source's files and records the version like the CLI",
      () =>
        Effect.gen(function* () {
          const machine = yield* makeMachine;
          const { fs, path } = machine;
          // An agent reaches tdd through a link, which must keep working.
          yield* fs.makeDirectory(path.join(machine.home, ".claude/skills"), { recursive: true });
          yield* fs.symlink(
            path.join(machine.globalSkills, "tdd"),
            path.join(machine.home, ".claude/skills/tdd"),
          );
          yield* machine.push(
            "tdd v2",
            Effect.gen(function* () {
              yield* fs.writeFileString(
                path.join(machine.upstream, "skills/tdd/notes.md"),
                "Second note.\n",
              );
              yield* machine.write(
                path.join(machine.upstream, "skills/tdd/scripts/run.sh"),
                "#!/bin/sh\necho test\n",
                0o755,
              );
            }),
          );
          const lockBefore = yield* fs.readFileString(machine.lockPath);
          const prdBefore = yield* fs.readFileString(
            path.join(machine.globalSkills, "prd/SKILL.md"),
          );
          yield* withUpdates(machine, [], (updates) =>
            Effect.gen(function* () {
              const changes = yield* updates.changes(ref("tdd"));
              expect(changes.entry).toMatchObject({ state: "update", edited: false });
              expect(changes.files.map((file) => [file.path, file.change, file.merge])).toEqual([
                ["notes.md", "modified", "theirs"],
                ["scripts/run.sh", "added", "theirs"],
              ]);
              expect(changes.files[1]?.script).toBe(true);
              // Nothing is written by reading the changes.
              expect(
                yield* fs.readFileString(path.join(machine.globalSkills, "tdd/notes.md")),
              ).toBe("First note.\n");

              const result = yield* updates.update({
                ...ref("tdd"),
                upstreamSha: changes.upstreamSha ?? "",
                localSha: changes.localSha ?? "",
                choice: "merge",
              });
              expect(result).toEqual({ status: "updated", conflicts: [] });
              const { entries } = yield* updates.check({});
              expect(entryOf(entries, "tdd").state).toBe("current");
            }),
          );
          const skill = path.join(machine.globalSkills, "tdd");
          expect(yield* fs.readFileString(path.join(skill, "notes.md"))).toBe("Second note.\n");
          expect((yield* fs.stat(path.join(skill, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
          expect(
            yield* fs.readFileString(path.join(machine.home, ".claude/skills/tdd/notes.md")),
          ).toBe("Second note.\n");
          // Nothing is left beside the folder, and the other skill is untouched.
          expect((yield* fs.readDirectory(machine.globalSkills)).toSorted()).toEqual([
            "prd",
            "tdd",
          ]);
          expect(yield* fs.readFileString(path.join(machine.globalSkills, "prd/SKILL.md"))).toBe(
            prdBefore,
          );
          // Only the hash and the time changed, in place; the file keeps the CLI's formatting.
          const lockAfter = yield* fs.readFileString(machine.lockPath);
          const before = JSON.parse(lockBefore);
          const after = JSON.parse(lockAfter);
          expect(after.skills.tdd.skillFolderHash).toBe(yield* machine.folderSha("skills/tdd"));
          expect(after.skills.tdd.updatedAt).not.toBe(before.skills.tdd.updatedAt);
          expect(Object.keys(after.skills.tdd)).toEqual(Object.keys(before.skills.tdd));
          expect({ ...after, skills: { ...after.skills, tdd: undefined } }).toEqual({
            ...before,
            skills: { ...before.skills, tdd: undefined },
          });
          expect(lockAfter.endsWith("}")).toBe(true);
        }),
    );

    it.effect("merges your edits with the source's when they don't clash", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const { fs, path } = machine;
        const upstreamSkill = path.join(machine.upstream, "skills/tdd/SKILL.md");
        yield* machine.push(
          "tdd v2",
          fs.writeFileString(
            upstreamSkill,
            skillFile("tdd", "Red.\nGreen.\nRefactor.\n\nKeep tests small and fast.\n"),
          ),
        );
        const local = path.join(machine.globalSkills, "tdd/SKILL.md");
        yield* fs.writeFileString(
          local,
          skillFile("tdd", "Red, always first.\nGreen.\nRefactor.\n\nKeep tests small.\n"),
        );
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const { entries } = yield* updates.check({});
            // The check can't tell yet whether the copy was edited; reading the changes can.
            expect(entryOf(entries, "tdd").state).toBe("update");
            const changes = yield* updates.changes(ref("tdd"));
            expect(changes.entry).toMatchObject({ state: "update", edited: true });
            expect(changes.files).toHaveLength(1);
            expect(changes.files[0]).toMatchObject({ path: "SKILL.md", merge: "merged" });
            const result = yield* updates.update({
              ...ref("tdd"),
              upstreamSha: changes.upstreamSha ?? "",
              localSha: changes.localSha ?? "",
              choice: "merge",
            });
            expect(result.status).toBe("updated");
            // Your edit stays, so the skill reads as edited with nothing newer.
            expect(entryOf((yield* updates.check({})).entries, "tdd").state).toBe("edited");
          }),
        );
        expect(yield* fs.readFileString(local)).toBe(
          skillFile("tdd", "Red, always first.\nGreen.\nRefactor.\n\nKeep tests small and fast.\n"),
        );
      }),
    );

    it.effect("writes nothing when edits clash, until each clashing file is settled", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const { fs, path } = machine;
        yield* machine.push(
          "tdd v2",
          Effect.gen(function* () {
            yield* fs.writeFileString(
              path.join(machine.upstream, "skills/tdd/notes.md"),
              "Their note.\n",
            );
            yield* fs.writeFileString(path.join(machine.upstream, "skills/tdd/extra.md"), "New.\n");
          }),
        );
        const notes = path.join(machine.globalSkills, "tdd/notes.md");
        yield* fs.writeFileString(notes, "My note.\n");
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const changes = yield* updates.changes(ref("tdd"));
            expect(changes.files.map((file) => [file.path, file.merge])).toEqual([
              ["extra.md", "theirs"],
              ["notes.md", "conflict"],
            ]);
            const pins = {
              ...ref("tdd"),
              upstreamSha: changes.upstreamSha ?? "",
              localSha: changes.localSha ?? "",
            };
            const blocked = yield* updates.update({ ...pins, choice: "merge" });
            expect(blocked).toEqual({ status: "conflicts", conflicts: ["notes.md"] });
            expect(yield* fs.readFileString(notes)).toBe("My note.\n");
            expect(yield* fs.exists(path.join(machine.globalSkills, "tdd/extra.md"))).toBe(false);

            const settled = yield* updates.update({
              ...pins,
              choice: "merge",
              resolutions: { "notes.md": "mine" },
            });
            expect(settled.status).toBe("updated");
          }),
        );
        expect(yield* fs.readFileString(notes)).toBe("My note.\n");
        expect(yield* fs.readFileString(path.join(machine.globalSkills, "tdd/extra.md"))).toBe(
          "New.\n",
        );
      }),
    );

    it.effect(
      "keeps your copy and records the source's version, so it no longer shows an update",
      () =>
        Effect.gen(function* () {
          const machine = yield* makeMachine;
          const { fs, path } = machine;
          yield* machine.push(
            "tdd v2",
            fs.writeFileString(path.join(machine.upstream, "skills/tdd/notes.md"), "Their note.\n"),
          );
          yield* withUpdates(machine, [], (updates) =>
            Effect.gen(function* () {
              const changes = yield* updates.changes(ref("tdd"));
              const result = yield* updates.update({
                ...ref("tdd"),
                upstreamSha: changes.upstreamSha ?? "",
                localSha: changes.localSha ?? "",
                choice: "mine",
              });
              expect(result).toEqual({ status: "kept", conflicts: [] });
              expect(entryOf((yield* updates.check({})).entries, "tdd").state).toBe("edited");
            }),
          );
          expect(yield* fs.readFileString(path.join(machine.globalSkills, "tdd/notes.md"))).toBe(
            "First note.\n",
          );
        }),
    );

    it.effect("applies nothing when the skill changed after its changes were read", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const { fs, path } = machine;
        yield* machine.push(
          "tdd v2",
          fs.writeFileString(path.join(machine.upstream, "skills/tdd/notes.md"), "Their note.\n"),
        );
        const notes = path.join(machine.globalSkills, "tdd/notes.md");
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const changes = yield* updates.changes(ref("tdd"));
            yield* fs.writeFileString(notes, "Edited meanwhile.\n");
            const result = yield* updates.update({
              ...ref("tdd"),
              upstreamSha: changes.upstreamSha ?? "",
              localSha: changes.localSha ?? "",
              choice: "theirs",
            });
            expect(result.status).toBe("changed");
          }),
        );
        expect(yield* fs.readFileString(notes)).toBe("Edited meanwhile.\n");
      }),
    );

    it.effect("never writes a lock with a version it doesn't know", () =>
      Effect.gen(function* () {
        const machine = yield* makeMachine;
        const { fs, path } = machine;
        yield* machine.push(
          "tdd v2",
          fs.writeFileString(path.join(machine.upstream, "skills/tdd/notes.md"), "Their note.\n"),
        );
        const lock = JSON.parse(yield* fs.readFileString(machine.lockPath));
        const newer = JSON.stringify({ ...lock, version: 4 }, null, 2);
        yield* fs.writeFileString(machine.lockPath, newer);
        yield* withUpdates(machine, [], (updates) =>
          Effect.gen(function* () {
            const changes = yield* updates.changes(ref("tdd"));
            const error = yield* updates
              .update({
                ...ref("tdd"),
                upstreamSha: changes.upstreamSha ?? "",
                localSha: changes.localSha ?? "",
                choice: "theirs",
              })
              .pipe(Effect.flip);
            expect(error.reason).toBe("lockUnsupported");
          }),
        );
        expect(yield* fs.readFileString(machine.lockPath)).toBe(newer);
        expect(yield* fs.readFileString(path.join(machine.globalSkills, "tdd/notes.md"))).toBe(
          "First note.\n",
        );
      }),
    );

    it.effect(
      "updates a project skill and gives its record the hash `npx skills update` compares",
      () =>
        Effect.gen(function* () {
          const machine = yield* makeMachine;
          const { fs, path } = machine;
          const project = path.join(machine.home, "repos/acme-web");
          const skill = path.join(project, ".agents/skills/tdd");
          yield* machine.install("skills/tdd", skill);
          const entries = (yield* fs.readDirectory(skill)).toSorted();
          const files = yield* Effect.forEach(entries, (name) =>
            Effect.map(fs.readFile(path.join(skill, name)), (bytes) => ({
              relative: name,
              kind: "file" as const,
              bytes,
            })),
          );
          const projectLock = path.join(project, "skills-lock.json");
          // The CLI sorts a project lock's skills and ends it with a newline.
          yield* machine.write(
            projectLock,
            `${JSON.stringify(
              {
                version: 1,
                skills: {
                  alpha: {
                    source: "acme/other",
                    sourceType: "github",
                    computedHash: "0".repeat(64),
                  },
                  tdd: {
                    source: SOURCE,
                    sourceType: "github",
                    skillPath: "skills/tdd/SKILL.md",
                    computedHash: computedHash(files),
                  },
                },
              },
              null,
              2,
            )}\n`,
          );
          yield* machine.push(
            "tdd v2",
            fs.writeFileString(
              path.join(machine.upstream, "skills/tdd/notes.md"),
              "Second note.\n",
            ),
          );
          yield* withUpdates(machine, [project], (updates) =>
            Effect.gen(function* () {
              const input = {
                cwd: project,
                scope: "project" as const,
                name: "tdd",
                home: ".agents/skills/tdd",
              };
              const check = yield* updates.check({ cwd: project });
              expect(
                check.entries.find((entry) => entry.scope === "project" && entry.name === "tdd"),
              ).toMatchObject({ state: "update", edited: false });
              const changes = yield* updates.changes(input);
              const result = yield* updates.update({
                ...input,
                upstreamSha: changes.upstreamSha ?? "",
                localSha: changes.localSha ?? "",
                choice: "theirs",
              });
              expect(result.status).toBe("updated");
            }),
          );
          // What the CLI hashes when it checks a download: every file, `metadata.json` too.
          const upstreamFiles = yield* Effect.forEach(
            ["SKILL.md", "metadata.json", "notes.md"],
            (name) =>
              Effect.map(fs.readFile(path.join(machine.upstream, "skills/tdd", name)), (bytes) => ({
                relative: name,
                kind: "file" as const,
                bytes,
              })),
          );
          const text = yield* fs.readFileString(projectLock);
          expect(JSON.parse(text).skills.tdd.computedHash).toBe(computedHash(upstreamFiles));
          expect(JSON.parse(text).skills.alpha.computedHash).toBe("0".repeat(64));
          expect(text.endsWith("}\n")).toBe(true);
          expect(yield* fs.readFileString(path.join(skill, "notes.md"))).toBe("Second note.\n");
        }),
    );
  });
});
