import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillBatchResult,
  type Project,
  type SkillRef,
  type SkillScope,
  type SkillSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { EXCLUDE_BLOCK_START } from "./SkillGitExclude.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { RegisteredProjects } from "./SkillLibrary.ts";
import * as SkillManager from "./SkillManager.ts";

const encodeResult = Schema.encodeUnknownEffect(SkillBatchResult);
const agent = ProviderInstanceId.make;

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/** The skill folder whose hashes the real skills CLI and git agree on (see SkillLockFiles.test). */
const GOLDEN = {
  computedHash: "a7f77818fb1962dfbb40da69550e2c9c0c035e97a11012946465db99bad816c0",
  treeSha: "18071366eef226103eef569e462d6a3e8e11fac7",
};
const GOLDEN_SKILL_FILE =
  "---\nname: db-migrations\ndescription: Plan and run database migrations.\n---\n\n# Migrations\n";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner.run({
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
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

/**
 * A made-up machine: three projects that are real git repositories, one project that isn't, an
 * untracked project skill, a Global skill in Claude's own folder, and a synced library whose skill
 * is linked into the shared Global folder.
 */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3code-placement-" }),
  );
  const web = path.join(home, "repos/acme-web");
  const api = path.join(home, "repos/acme-api");
  const marketing = path.join(home, "repos/marketing-site");
  const loose = path.join(home, "repos/scratch");
  const write = (relative: string, contents: string, mode?: number) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
      if (mode !== undefined) yield* fs.chmod(target, mode);
    });
  for (const repo of [web, api, marketing]) {
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* git(repo, ["init", "-q", "-b", "main"]);
    yield* fs.writeFileString(path.join(repo, "README.md"), `# ${path.basename(repo)}\n`);
    yield* git(repo, ["add", "-A"]);
    yield* git(repo, ["commit", "-q", "-m", "init"]);
  }
  yield* fs.makeDirectory(loose, { recursive: true });

  yield* write("repos/acme-web/.agents/skills/db-migrations/SKILL.md", skillFile("db-migrations"));
  yield* write("repos/acme-web/.agents/skills/db-migrations/run.sh", "echo ok");
  yield* write(".claude/skills/solo/SKILL.md", skillFile("solo"));
  yield* write("library/skills/alpha/SKILL.md", skillFile("alpha"));
  yield* fs.makeDirectory(path.join(home, ".agents/skills"), { recursive: true });
  yield* fs.symlink(
    path.join(home, "library/skills/alpha"),
    path.join(home, ".agents/skills/alpha"),
  );
  return {
    fs,
    path,
    home,
    web,
    api,
    marketing,
    loose,
    write,
    library: path.join(home, ".agents/skill-library"),
  };
});

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make(`project-${workspaceRoot.replaceAll("/", "-")}`),
  title: "App",
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

/** The manager and catalog on a machine whose home is `home`; only `registered` folders are projects. */
const withManager = <A, E, R>(
  home: string,
  registered: readonly string[],
  use: (services: {
    readonly manager: SkillManager.SkillManager["Service"];
    readonly catalog: SkillCatalog.SkillCatalog["Service"];
  }) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv = {},
) =>
  Effect.gen(function* () {
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: () => Effect.succeed([]),
      refreshWorkspaceSnapshot: () => Effect.succeed([]),
    });
    const projects = Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(registered.includes(root) ? Option.some(makeProject(root)) : Option.none()),
      listShells: () =>
        Effect.succeed(registered.map((workspaceRoot) => ({ workspaceRoot }) as never)),
    });
    const catalog = SkillCatalog.layer.pipe(
      Layer.provide(
        Settings.layerTest({
          providerInstances: Object.fromEntries(
            ["cursor", "grok", "opencode", "antigravity", "pi"].map((driver) => [
              ProviderInstanceId.make(driver),
              { driver: ProviderDriverKind.make(driver), enabled: true },
            ]),
          ),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* use({
        manager: yield* SkillManager.SkillManager,
        catalog: yield* SkillCatalog.SkillCatalog,
      });
    }).pipe(
      Effect.provide(
        SkillManager.layer.pipe(
          Layer.provideMerge(catalog),
          Layer.provide(projects),
          Layer.provide(registry),
          Layer.provide(VcsProcess.layer),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home, ...environment }),
    Effect.provideService(RegisteredProjects, Effect.succeed(registered)),
  );

const refOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string): SkillRef => {
  const skill = skills.find((item) => item.scope === scope && item.name === name);
  if (!skill) throw new Error(`No ${scope} skill ${name} in the list`);
  return { scope, name, home: skill.home };
};

const summaryOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string) =>
  skills.find((item) => item.scope === scope && item.name === name);

const stateOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string) =>
  Object.fromEntries(
    (summaryOf(skills, scope, name)?.access ?? []).map((entry) => [entry.instanceId, entry.state]),
  );

/** What git shows as changed, file by file. */
const status = (repo: string) =>
  git(repo, ["status", "--porcelain", "-uall"]).pipe(Effect.map((result) => result.stdout));

const exclude = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(`${repo}/.git/info/exclude`)
      .pipe(Effect.orElseSucceed(() => ""));
  });

/** Only the lines T3 Code put in an exclude file. */
const blockLines = (text: string) => {
  const lines = text.split("\n");
  const start = lines.indexOf(EXCLUDE_BLOCK_START);
  return start < 0
    ? []
    : lines.slice(start + 1, lines.indexOf("# End T3 Code: skills used from Global"));
};

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillPlacement", (it) => {
  describe("into only some projects", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps one copy in the library and links it into each project, out of git's sight",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, marketing, library } = yield* makeMachine;
          yield* withManager(home, [web, api, marketing], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({
                cwd: web,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });
              expect(yield* status(web)).toContain("?? .agents/skills/db-migrations/SKILL.md");

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              expect(result.outcomes).toEqual([
                { skill: verify, status: "changed", blocked: [], affected: [] },
              ]);
              yield* encodeResult(result);
              // One copy, in the library.
              const entry = path.join(library, "db-migrations");
              expect(yield* fs.readFileString(path.join(entry, "run.sh"))).toBe("echo ok");
              // An absolute link in each project, and Claude's own where Claude had it on.
              for (const project of [web, api]) {
                expect(yield* fs.readLink(path.join(project, ".agents/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(yield* fs.readLink(path.join(project, ".claude/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(blockLines(yield* exclude(project))).toEqual([
                  "/.agents/skills/db-migrations",
                  "/.claude/skills/db-migrations",
                ]);
                expect(yield* status(project)).toBe("");
              }
              expect(yield* fs.exists(path.join(marketing, ".agents"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "lists the skill once as Global, with the projects it is used in, from every view",
      () =>
        Effect.gen(function* () {
          const { home, web, api, marketing } = yield* makeMachine;
          yield* withManager(home, [web, api, marketing], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });
              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              for (const cwd of [undefined, web, api, marketing]) {
                const { skills } = yield* catalog.list(cwd === undefined ? {} : { cwd });
                const rows = skills.filter((skill) => skill.name === "db-migrations");
                // No project row for the link: it is the Global skill.
                expect(rows.map((row) => [row.scope, row.home, row.projects])).toEqual([
                  ["global", "~/.agents/skill-library/db-migrations", [web, api]],
                ]);
                expect(rows[0]?.realFolder).toBe(true);
              }

              // Used in web: the agents that read its folders have it. Not used in marketing.
              const inWeb = stateOf(
                (yield* catalog.list({ cwd: web })).skills,
                "global",
                "db-migrations",
              );
              expect(inWeb).toMatchObject({ claudeAgent: "link", codex: "direct", pi: "direct" });
              const elsewhere = stateOf(
                (yield* catalog.list({ cwd: marketing })).skills,
                "global",
                "db-migrations",
              );
              expect(new Set(Object.values(elsewhere))).toEqual(new Set(["none"]));
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes a project's tracked skill show in git only as the files that left",
      () =>
        Effect.gen(function* () {
          const { home, web, api } = yield* makeMachine;
          yield* git(web, ["add", "-A"]);
          yield* git(web, ["commit", "-q", "-m", "add the skill"]);
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              // The tracked files are gone from where git expects them; the link adds no noise.
              expect(yield* status(web)).toBe(
                " D .agents/skills/db-migrations/SKILL.md\n D .agents/skills/db-migrations/run.sh\n",
              );
              expect(yield* status(api)).toBe("");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "takes a Global skill out of every project but the chosen ones, and its agents keep it there",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const solo = refOf((yield* catalog.list({})).skills, "global", "solo");

              const result = yield* manager.place({
                skills: [solo],
                to: { kind: "projects", cwds: [api] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              // Claude, Cursor and OpenCode read Claude's folder; they lose it everywhere else.
              expect(result.outcomes[0]?.affected.toSorted()).toEqual(
                [agent("claudeAgent"), agent("cursor"), agent("opencode")].toSorted(),
              );
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo"))).toBe(false);
              expect(yield* fs.exists(path.join(library, "solo/SKILL.md"))).toBe(true);
              expect(yield* fs.readLink(path.join(api, ".agents/skills/solo"))).toBe(
                path.join(library, "solo"),
              );
              expect(yield* fs.readLink(path.join(api, ".claude/skills/solo"))).toBe(
                path.join(library, "solo"),
              );
              expect(yield* status(api)).toBe("");
              expect(yield* fs.exists(path.join(web, ".agents/skills/solo"))).toBe(false);

              const inApi = stateOf((yield* catalog.list({ cwd: api })).skills, "global", "solo");
              expect(inApi).toMatchObject({ claudeAgent: "link", codex: "direct" });
              const inWeb = stateOf((yield* catalog.list({ cwd: web })).skills, "global", "solo");
              expect(new Set(Object.values(inWeb))).toEqual(new Set(["none"]));
              expect(
                summaryOf((yield* catalog.list({})).skills, "global", "solo")?.projects,
              ).toEqual([api]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a synced library's folder where it is and links the library entry to it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, library } = yield* makeMachine;
          yield* withManager(home, [web], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const alpha = refOf((yield* catalog.list({})).skills, "global", "alpha");

              const result = yield* manager.place({
                skills: [alpha],
                to: { kind: "projects", cwds: [web] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              const synced = path.join(home, "library/skills/alpha");
              expect(yield* fs.exists(path.join(synced, "SKILL.md"))).toBe(true);
              // The library holds a link, not a copy, and the Global link is gone.
              expect(yield* fs.readLink(path.join(library, "alpha"))).toBe(synced);
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(false);
              expect(yield* fs.readLink(path.join(web, ".agents/skills/alpha"))).toBe(
                path.join(library, "alpha"),
              );
              expect(yield* status(web)).not.toContain("alpha");
              const row = summaryOf((yield* catalog.list({})).skills, "global", "alpha");
              expect(row).toMatchObject({ home: "~/library/skills/alpha", projects: [web] });
              expect(row?.realFolder).toBeUndefined();

              // And back to Global: the same real folder, linked from the shared folder again.
              const back = yield* manager.place({
                skills: [refOf((yield* catalog.list({})).skills, "global", "alpha")],
                to: { kind: "global" },
              });
              expect(back.outcomes[0]).toMatchObject({ status: "changed" });
              expect(yield* fs.readLink(path.join(home, ".agents/skills/alpha"))).toBe(synced);
              expect(yield* fs.exists(path.join(library, "alpha"))).toBe(false);
              expect(yield* fs.exists(path.join(web, ".agents/skills/alpha"))).toBe(false);
              expect(blockLines(yield* exclude(web))).toEqual([]);
              expect(yield* fs.exists(path.join(synced, "SKILL.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "adds and removes project links when the projects change",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, marketing, library } = yield* makeMachine;
          yield* withManager(home, [web, api, marketing], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });
              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });
              const inLibrary = () =>
                Effect.map(catalog.list({}), ({ skills }) =>
                  refOf(skills, "global", "db-migrations"),
                );

              const result = yield* manager.place({
                skills: [yield* inLibrary()],
                to: { kind: "projects", cwds: [api, marketing] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              const entry = path.join(library, "db-migrations");
              expect(yield* fs.exists(path.join(web, ".agents/skills/db-migrations"))).toBe(false);
              expect(yield* fs.exists(path.join(web, ".claude/skills/db-migrations"))).toBe(false);
              expect(blockLines(yield* exclude(web))).toEqual([]);
              // Marketing gets the same links the other project has, Claude's included.
              for (const project of [api, marketing]) {
                expect(yield* fs.readLink(path.join(project, ".agents/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(yield* fs.readLink(path.join(project, ".claude/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(blockLines(yield* exclude(project))).toEqual([
                  "/.agents/skills/db-migrations",
                  "/.claude/skills/db-migrations",
                ]);
              }
              for (const project of [web, api, marketing]) expect(yield* status(project)).toBe("");
              expect(
                summaryOf((yield* catalog.list({})).skills, "global", "db-migrations")?.projects,
              ).toEqual([api, marketing]);

              // The same set again changes nothing.
              const again = yield* manager.place({
                skills: [yield* inLibrary()],
                to: { kind: "projects", cwds: [marketing, api] },
              });
              expect(again.outcomes[0]).toMatchObject({ status: "unchanged", blocked: [] });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "tells which agent's own link couldn't be made, and links the rest",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, write, library } = yield* makeMachine;
          // Something of api's is in Claude's folder under the name; it is left as it is.
          yield* write("repos/acme-api/.claude/skills/db-migrations/SKILL.md", skillFile("theirs"));
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "changed",
                blocked: [{ instanceId: agent("claudeAgent"), reason: "entryTaken" }],
              });
              yield* encodeResult(result);
              expect(yield* fs.readLink(path.join(api, ".agents/skills/db-migrations"))).toBe(
                path.join(library, "db-migrations"),
              );
              expect(
                yield* fs.readFileString(path.join(api, ".claude/skills/db-migrations/SKILL.md")),
              ).toBe(skillFile("theirs"));
              expect(blockLines(yield* exclude(api))).toEqual(["/.agents/skills/db-migrations"]);
              expect(blockLines(yield* exclude(web))).toEqual([
                "/.agents/skills/db-migrations",
                "/.claude/skills/db-migrations",
              ]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes a project that isn't a git repository just a link, with no exclude file",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, loose, library } = yield* makeMachine;
          yield* withManager(home, [loose], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const solo = refOf((yield* catalog.list({})).skills, "global", "solo");

              const result = yield* manager.place({
                skills: [solo],
                to: { kind: "projects", cwds: [loose] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              expect(yield* fs.readLink(path.join(loose, ".agents/skills/solo"))).toBe(
                path.join(library, "solo"),
              );
              expect(yield* fs.exists(path.join(loose, ".git"))).toBe(false);
            }),
          );
        }),
    );
  });

  describe("out of the library", () => {
    /** The db-migrations skill used in web and api, with Claude on in web. */
    const usedInTwo = (
      manager: SkillManager.SkillManager["Service"],
      catalog: SkillCatalog.SkillCatalog["Service"],
      web: string,
      api: string,
    ) =>
      Effect.gen(function* () {
        const verify = refOf(
          (yield* catalog.list({ cwd: web })).skills,
          "project",
          "db-migrations",
        );
        yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });
        yield* manager.place({
          cwd: web,
          skills: [verify],
          to: { kind: "projects", cwds: [web, api] },
        });
        return refOf((yield* catalog.list({})).skills, "global", "db-migrations");
      });

    it.effect.skipIf(!symlinksSupported)(
      "makes it Global again: the folder moves back, the links and their exclude lines go",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const used = yield* usedInTwo(manager, catalog, web, api);

              const result = yield* manager.place({ skills: [used], to: { kind: "global" } });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              yield* encodeResult(result);
              const moved = path.join(home, ".agents/skills/db-migrations");
              expect(yield* fs.readFileString(path.join(moved, "run.sh"))).toBe("echo ok");
              expect(yield* fs.exists(path.join(library, "db-migrations"))).toBe(false);
              for (const project of [web, api]) {
                expect(yield* fs.exists(path.join(project, ".agents/skills/db-migrations"))).toBe(
                  false,
                );
                expect(yield* fs.exists(path.join(project, ".claude/skills/db-migrations"))).toBe(
                  false,
                );
                expect(yield* exclude(project)).not.toContain("T3 Code");
                expect(yield* status(project)).toBe("");
              }
              // Claude had it in a project, so it has it Global now; Codex reads the folder.
              expect(yield* fs.readLink(path.join(home, ".claude/skills/db-migrations"))).toBe(
                moved,
              );
              const global = (yield* catalog.list({})).skills;
              expect(summaryOf(global, "global", "db-migrations")?.projects).toBeUndefined();
              expect(stateOf(global, "global", "db-migrations")).toMatchObject({
                claudeAgent: "link",
                codex: "direct",
              });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes it one project's own skill, and every other project's link goes",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, marketing, library } = yield* makeMachine;
          yield* withManager(home, [web, api, marketing], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const used = yield* usedInTwo(manager, catalog, web, api);

              const result = yield* manager.place({
                skills: [used],
                to: { kind: "project", cwd: marketing },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              const moved = path.join(marketing, ".agents/skills/db-migrations");
              expect(yield* fs.readFileString(path.join(moved, "run.sh"))).toBe("echo ok");
              // A project's link to its own skill is relative, so it survives a clone.
              expect(yield* fs.readLink(path.join(marketing, ".claude/skills/db-migrations"))).toBe(
                "../../.agents/skills/db-migrations",
              );
              expect(yield* fs.exists(path.join(library, "db-migrations"))).toBe(false);
              for (const project of [web, api]) {
                expect(yield* fs.exists(path.join(project, ".agents/skills/db-migrations"))).toBe(
                  false,
                );
                expect(yield* exclude(project)).not.toContain("T3 Code");
              }
              const inMarketing = (yield* catalog.list({ cwd: marketing })).skills;
              expect(summaryOf(inMarketing, "project", "db-migrations")?.realFolder).toBe(true);
              expect(summaryOf(inMarketing, "global", "db-migrations")).toBeUndefined();
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves a project skill into a project other than the one the list was read for",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api } = yield* makeMachine;
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "project", cwd: api },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(
                yield* fs.readFileString(path.join(api, ".agents/skills/db-migrations/run.sh")),
              ).toBe("echo ok");
              expect(yield* fs.exists(path.join(web, ".agents/skills/db-migrations"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "deletes the library copy and every project's link to it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const used = yield* usedInTwo(manager, catalog, web, api);

              const result = yield* manager.delete({ skills: [used] });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              expect(yield* fs.exists(path.join(library, "db-migrations"))).toBe(false);
              for (const project of [web, api]) {
                expect(yield* fs.readDirectory(path.join(project, ".agents/skills"))).toEqual([]);
                expect(yield* exclude(project)).not.toContain("T3 Code");
              }
            }),
          );
        }),
    );
  });

  describe("never replacing what is in the way", () => {
    it.effect.skipIf(!symlinksSupported)(
      "refuses when the library already has something under the name",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          yield* fs.makeDirectory(path.join(library, "db-migrations"), { recursive: true });
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                reason: "destinationTaken",
              });
              expect(
                yield* fs.readFileString(path.join(web, ".agents/skills/db-migrations/run.sh")),
              ).toBe("echo ok");
              expect(yield* fs.readDirectory(path.join(library, "db-migrations"))).toEqual([]);
              expect(yield* fs.exists(path.join(api, ".agents"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses when a chosen project has a different skill under the name, and changes nothing",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, write, library } = yield* makeMachine;
          yield* write("repos/acme-api/.agents/skills/db-migrations/SKILL.md", skillFile("theirs"));
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                reason: "destinationTaken",
              });
              expect(
                yield* fs.readFileString(path.join(api, ".agents/skills/db-migrations/SKILL.md")),
              ).toBe(skillFile("theirs"));
              expect(
                yield* fs.readFileString(path.join(web, ".agents/skills/db-migrations/run.sh")),
              ).toBe("echo ok");
              expect(yield* fs.readLink(path.join(web, ".claude/skills/db-migrations"))).toBe(
                "../../.agents/skills/db-migrations",
              );
              expect(yield* fs.exists(library)).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses to make a library skill Global or a project's when that place has one already",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, marketing, write, library } = yield* makeMachine;
          yield* withManager(home, [web, api, marketing], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });
              const used = refOf((yield* catalog.list({})).skills, "global", "db-migrations");
              yield* write(".agents/skills/db-migrations/SKILL.md", skillFile("theirs"));
              yield* write(
                "repos/marketing-site/.agents/skills/db-migrations/SKILL.md",
                skillFile("theirs"),
              );

              const global = yield* manager.place({ skills: [used], to: { kind: "global" } });
              const project = yield* manager.place({
                skills: [used],
                to: { kind: "project", cwd: marketing },
              });

              for (const result of [global, project]) {
                expect(result.outcomes[0]).toMatchObject({
                  status: "skipped",
                  reason: "destinationTaken",
                });
              }
              // Still used where it was.
              const entry = path.join(library, "db-migrations");
              expect(yield* fs.readFileString(path.join(entry, "run.sh"))).toBe("echo ok");
              for (const repo of [web, api]) {
                expect(yield* fs.readLink(path.join(repo, ".agents/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(blockLines(yield* exclude(repo))).toEqual(["/.agents/skills/db-migrations"]);
              }
            }),
          );
        }),
    );
  });

  describe("when a step fails", () => {
    /** A write to this repository's exclude file fails, as with a read-only `.git`. */
    const failingExclude = (fs: FileSystem.FileSystem, repo: string) =>
      FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (target, ...rest) =>
          target.startsWith(`${repo}/.git/info/`)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: target,
                }),
              )
            : fs.writeFileString(target, ...rest),
      });

    it.effect.skipIf(!symlinksSupported)(
      "puts everything back: the folder, Claude's link, and the links and lines already made",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.enable({ cwd: web, skills: [verify], agents: [agent("claudeAgent")] });
              const before = yield* status(web);

              // web's links and lines are made first, then api's exclude file can't be written.
              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "failed" });
              yield* encodeResult(result);
              expect(
                yield* fs.readFileString(path.join(web, ".agents/skills/db-migrations/run.sh")),
              ).toBe("echo ok");
              expect(yield* fs.readLink(path.join(web, ".claude/skills/db-migrations"))).toBe(
                "../../.agents/skills/db-migrations",
              );
              expect(yield* fs.exists(path.join(library, "db-migrations"))).toBe(false);
              expect(yield* fs.exists(path.join(api, ".agents/skills/db-migrations"))).toBe(false);
              expect(yield* fs.exists(path.join(api, ".claude/skills/db-migrations"))).toBe(false);
              for (const repo of [web, api]) expect(yield* exclude(repo)).not.toContain("T3 Code");
              expect(yield* status(web)).toBe(before);
              // Still the project's own skill, as the list says.
              expect(
                summaryOf((yield* catalog.list({ cwd: web })).skills, "project", "db-migrations")
                  ?.realFolder,
              ).toBe(true);
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, failingExclude(fs, api)));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "puts a library skill's links back when taking them away fails halfway",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          // Writes to api's exclude file fail once armed, as with a read-only `.git`.
          let armed = false;
          const flaky = FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (target, ...rest) =>
              armed && target.startsWith(`${api}/.git/info/`)
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "writeFileString",
                      pathOrDescriptor: target,
                    }),
                  )
                : fs.writeFileString(target, ...rest),
          });
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );
              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [web, api] },
              });
              const used = refOf((yield* catalog.list({})).skills, "global", "db-migrations");
              armed = true;

              // Making it Global drops web's link and exclude line first; then api's can't change.
              const result = yield* manager.place({ skills: [used], to: { kind: "global" } });

              expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "failed" });
              const entry = path.join(library, "db-migrations");
              expect(yield* fs.readFileString(path.join(entry, "run.sh"))).toBe("echo ok");
              expect(yield* fs.exists(path.join(home, ".agents/skills/db-migrations"))).toBe(false);
              for (const repo of [web, api]) {
                expect(yield* fs.readLink(path.join(repo, ".agents/skills/db-migrations"))).toBe(
                  entry,
                );
                expect(blockLines(yield* exclude(repo))).toEqual(["/.agents/skills/db-migrations"]);
                expect(yield* status(repo)).toBe("");
              }
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, flaky));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves the skill alone when a copy across disks fails",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, library } = yield* makeMachine;
          const from = path.join(web, ".agents/skills/db-migrations");
          const failing = FileSystem.FileSystem.of({
            ...fs,
            rename: (oldPath, newPath) =>
              oldPath === from
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: oldPath,
                      cause: Object.assign(new Error("EXDEV"), { code: "EXDEV" }),
                    }),
                  )
                : fs.rename(oldPath, newPath),
            copyFile: (source) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "copyFile",
                  pathOrDescriptor: source,
                  cause: Object.assign(new Error("EIO"), { code: "EIO" }),
                }),
              ),
          });
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [api] },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "failed" });
              expect(yield* fs.readFileString(path.join(from, "run.sh"))).toBe("echo ok");
              expect(yield* fs.exists(path.join(library, "db-migrations"))).toBe(false);
              expect(yield* fs.exists(path.join(api, ".agents"))).toBe(false);
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, failing));
        }),
    );
  });

  describe("the skill's source record", () => {
    const lockFile = (skills: Record<string, unknown>) =>
      `${JSON.stringify({ version: 1, skills }, null, 2)}\n`;
    const record = {
      source: "acme/skills",
      sourceType: "github",
      skillPath: "skills/db-migrations/SKILL.md",
      computedHash: "0".repeat(64),
    };

    it.effect.skipIf(!symlinksSupported)(
      "goes with a project skill into Global, and shows as the skill's source in both places",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, write } = yield* makeMachine;
          yield* write("repos/acme-web/skills-lock.json", lockFile({ "db-migrations": record }));
          yield* withManager(
            home,
            [web],
            ({ manager, catalog }) =>
              Effect.gen(function* () {
                const before = (yield* catalog.list({ cwd: web })).skills;
                expect(summaryOf(before, "project", "db-migrations")?.source).toBe("acme/skills");

                yield* manager.place({
                  cwd: web,
                  skills: [refOf(before, "project", "db-migrations")],
                  to: { kind: "global" },
                });

                const lock = JSON.parse(
                  yield* fs.readFileString(path.join(home, "state/skills/.skill-lock.json")),
                );
                expect(lock.skills["db-migrations"]).toMatchObject({
                  source: "acme/skills",
                  sourceUrl: "https://github.com/acme/skills.git",
                  skillFolderHash: "",
                });
                expect(yield* fs.readFileString(path.join(web, "skills-lock.json"))).toBe(
                  lockFile({}),
                );
                const after = (yield* catalog.list({ cwd: web })).skills;
                expect(summaryOf(after, "global", "db-migrations")?.source).toBe("acme/skills");
              }),
            { XDG_STATE_HOME: `${home}/state` },
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "goes with a project skill into the library, as a Global skill",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, api, write } = yield* makeMachine;
          yield* write("repos/acme-web/skills-lock.json", lockFile({ "db-migrations": record }));
          yield* withManager(home, [web, api], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "projects", cwds: [api] },
              });

              expect(
                JSON.parse(yield* fs.readFileString(path.join(home, ".agents/.skill-lock.json")))
                  .skills["db-migrations"].skillFolderHash,
              ).toBe("");
              expect(yield* fs.readFileString(path.join(web, "skills-lock.json"))).toBe(
                lockFile({}),
              );
              expect(
                summaryOf((yield* catalog.list({ cwd: api })).skills, "global", "db-migrations")
                  ?.source,
              ).toBe("acme/skills");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "goes with a Global skill into a project when the folder is exactly what was recorded",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, write } = yield* makeMachine;
          // The skill whose git tree and CLI hash are known, as the CLI would have installed it.
          yield* write(".agents/skills/exact/SKILL.md", GOLDEN_SKILL_FILE);
          yield* write(".agents/skills/exact/references/x.md", "Read this first.\n");
          yield* write(".agents/skills/exact/scripts/run.sh", "#!/bin/sh\necho migrate\n", 0o755);
          yield* write(
            ".agents/.skill-lock.json",
            JSON.stringify({
              version: 3,
              skills: {
                exact: {
                  source: "acme/skills",
                  sourceType: "github",
                  sourceUrl: "https://github.com/acme/skills.git",
                  skillPath: "skills/db-migrations/SKILL.md",
                  skillFolderHash: GOLDEN.treeSha,
                  installedAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
              dismissed: {},
            }),
          );
          yield* withManager(home, [web], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const global = refOf((yield* catalog.list({ cwd: web })).skills, "global", "exact");

              yield* manager.place({
                cwd: web,
                skills: [global],
                to: { kind: "project", cwd: web },
              });

              expect(
                JSON.parse(yield* fs.readFileString(path.join(web, "skills-lock.json"))),
              ).toEqual({
                version: 1,
                skills: {
                  exact: {
                    source: "acme/skills",
                    sourceType: "github",
                    skillPath: "skills/db-migrations/SKILL.md",
                    computedHash: GOLDEN.computedHash,
                  },
                },
              });
              const globalLock = yield* fs.readFileString(
                path.join(home, ".agents/.skill-lock.json"),
              );
              expect(JSON.parse(globalLock).skills).toEqual({});
              expect(
                summaryOf((yield* catalog.list({ cwd: web })).skills, "project", "exact")?.source,
              ).toBe("acme/skills");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "is dropped, and the skill becomes ungrouped, when the Global folder was edited",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, write } = yield* makeMachine;
          yield* write(".agents/skills/exact/SKILL.md", GOLDEN_SKILL_FILE);
          yield* write(".agents/skills/exact/references/x.md", "Edited by hand.\n");
          yield* write(
            ".agents/.skill-lock.json",
            JSON.stringify({
              version: 3,
              skills: {
                exact: {
                  source: "acme/skills",
                  sourceType: "github",
                  sourceUrl: "https://github.com/acme/skills.git",
                  skillFolderHash: GOLDEN.treeSha,
                  installedAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
            }),
          );
          yield* withManager(home, [web], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const global = refOf((yield* catalog.list({ cwd: web })).skills, "global", "exact");
              expect(
                summaryOf((yield* catalog.list({ cwd: web })).skills, "global", "exact")?.source,
              ).toBe("acme/skills");

              const result = yield* manager.place({
                cwd: web,
                skills: [global],
                to: { kind: "project", cwd: web },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              expect(yield* fs.exists(path.join(web, "skills-lock.json"))).toBe(false);
              expect(
                summaryOf((yield* catalog.list({ cwd: web })).skills, "project", "exact")?.source,
              ).toBeUndefined();
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "is left exactly as it is when a lock doesn't parse, and the skill still moves",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, web, write } = yield* makeMachine;
          const original = lockFile({ "db-migrations": record });
          const broken = '<<<<<<< HEAD\n{"version":3,"skills":{}}\n=======\n';
          yield* write("repos/acme-web/skills-lock.json", original);
          yield* write(".agents/.skill-lock.json", broken);
          yield* withManager(home, [web], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: web })).skills,
                "project",
                "db-migrations",
              );

              const result = yield* manager.place({
                cwd: web,
                skills: [verify],
                to: { kind: "global" },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              expect(
                yield* fs.exists(path.join(home, ".agents/skills/db-migrations/SKILL.md")),
              ).toBe(true);
              expect(yield* fs.readFileString(path.join(web, "skills-lock.json"))).toBe(original);
              expect(yield* fs.readFileString(path.join(home, ".agents/.skill-lock.json"))).toBe(
                broken,
              );
            }),
          );
        }),
    );
  });
});
