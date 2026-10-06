import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillBatchResult,
  SkillDisableInput,
  SkillEnableInput,
  SkillRemoveInput,
  SkillRequestError,
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
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import * as SkillManager from "./SkillManager.ts";
import { planEnable } from "./SkillManager.ts";

const encodeResult = Schema.encodeUnknownEffect(SkillBatchResult);
const agent = ProviderInstanceId.make;
const ALL_AGENTS = ["claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity", "pi"].map(
  (id) => agent(id),
);

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/** A made-up machine: a synced library linked into the shared folder, and a project in a repo. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-manager-" }));
  const project = path.join(home, "repos/app");
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(path.join(home, target), path.join(home, from));
    });
  for (const name of ["alpha", "beta"]) {
    yield* write(`library/skills/${name}/SKILL.md`, skillFile(name));
    yield* write(`library/skills/${name}/notes.md`, `notes on ${name}`);
  }
  yield* link("library/skills/alpha", ".agents/skills/alpha");
  yield* write(".claude/skills/solo/SKILL.md", skillFile("solo"));
  yield* write("repos/app/.agents/skills/verify/SKILL.md", skillFile("verify"));
  yield* write("repos/app/.agents/skills/verify/run.sh", "echo ok");
  return { fs, path, home, project, write, link };
});

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-manager"),
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
) =>
  Effect.gen(function* () {
    return yield* use({
      manager: yield* SkillManager.SkillManager,
      catalog: yield* SkillCatalog.SkillCatalog,
    });
  }).pipe(
    Effect.provide(
      SkillManager.layer.pipe(
        Layer.provideMerge(
          SkillCatalog.layer.pipe(
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
          ),
        ),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) =>
              Effect.succeed(
                registered.includes(root) ? Option.some(makeProject(root)) : Option.none(),
              ),
          }),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

const refOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string): SkillRef => {
  const skill = skills.find((item) => item.scope === scope && item.name === name);
  if (!skill) throw new Error(`No ${scope} skill ${name} in the list`);
  return { scope, name, home: skill.home };
};

const stateOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string) =>
  Object.fromEntries(
    (skills.find((item) => item.scope === scope && item.name === name)?.access ?? []).map(
      (entry) => [entry.instanceId, entry.state],
    ),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillManager", (it) => {
  describe("enable", () => {
    it.effect.skipIf(!symlinksSupported)(
      "gives one agent a global skill through an absolute link in its own folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              expect(stateOf(skills, "global", "alpha").claudeAgent).toBe("none");

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes).toEqual([
                {
                  skill: refOf(skills, "global", "alpha"),
                  status: "changed",
                  blocked: [],
                  affected: [],
                },
              ]);
              yield* encodeResult(result);
              expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
                path.join(home, "library/skills/alpha"),
              );
              const after = (yield* catalog.list({})).skills;
              expect(stateOf(after, "global", "alpha")).toMatchObject({
                claudeAgent: "link",
                codex: "direct",
                antigravity: "none",
              });
              // Nobody else's folders changed.
              expect(yield* fs.exists(path.join(home, ".gemini"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives an agent a project skill through a relative link, creating the folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const verify = refOf(skills, "project", "verify");

              const result = yield* manager.enable({
                cwd: project,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]?.status).toBe("changed");
              const link = path.join(project, ".claude/skills/verify");
              expect(yield* fs.readLink(link)).toBe("../../.agents/skills/verify");
              expect(yield* fs.realPath(link)).toBe(path.join(project, ".agents/skills/verify"));
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a project's links working after the project folder is moved",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "project", "verify")],
                agents: [agent("claudeAgent")],
              });
            }),
          );

          const moved = path.join(home, "repos/app-renamed");
          yield* fs.rename(project, moved);

          expect(yield* fs.realPath(path.join(moved, ".claude/skills/verify"))).toBe(
            path.join(moved, ".agents/skills/verify"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns on for all agents, one link where agents share a folder, and names who else gained it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const solo = refOf(skills, "global", "solo");
              // `solo` only lives in Claude's folder, which Cursor and OpenCode read too.
              expect(stateOf(skills, "global", "solo")).toMatchObject({
                claudeAgent: "direct",
                cursor: "direct",
                opencode: "direct",
                codex: "none",
                grok: "none",
                pi: "none",
              });

              const result = yield* manager.enable({ skills: [solo], agents: ALL_AGENTS });

              // Codex, Grok and Pi share ~/.agents/skills, so a single link serves them.
              expect(yield* fs.readLink(path.join(home, ".agents/skills/solo"))).toBe(
                path.join(home, ".claude/skills/solo"),
              );
              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              // Antigravity reads neither folder, so it gets its own link.
              expect(yield* fs.readLink(path.join(home, ".gemini/config/skills/solo"))).toBe(
                path.join(home, ".claude/skills/solo"),
              );
              const states = stateOf((yield* catalog.list({})).skills, "global", "solo");
              expect(Object.values(states).every((state) => state !== "none")).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "says which agents that weren't asked for gained the skill from a shared folder",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "solo")],
                agents: [agent("codex")],
              });

              expect(result.outcomes[0]?.affected).toEqual([agent("grok"), agent("pi")]);
              yield* encodeResult(result);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("is a no-op the second time", () =>
      Effect.gen(function* () {
        const { home } = yield* makeMachine;
        yield* withManager(home, [], ({ manager, catalog }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({});
            const input = {
              skills: [refOf(skills, "global", "alpha")],
              agents: [agent("claudeAgent")],
            };

            const first = yield* manager.enable(input);
            const second = yield* manager.enable(input);

            expect(first.outcomes[0]?.status).toBe("changed");
            expect(second.outcomes[0]).toMatchObject({ status: "unchanged", blocked: [] });
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes one link when two requests ask at once, and neither fails",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const input = {
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("claudeAgent")],
              };

              const results = yield* Effect.all([manager.enable(input), manager.enable(input)], {
                concurrency: "unbounded",
              });

              expect(results.map((result) => result.outcomes[0]?.status).toSorted()).toEqual([
                "changed",
                "unchanged",
              ]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never replaces a real folder or file where the link would go",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, write } = yield* makeMachine;
          // Claude's folder holds its own `alpha` without a SKILL.md, and a file named `beta`.
          yield* write(".claude/skills/alpha/mine.md", "my own notes");
          yield* write(".claude/skills/beta", "a file");
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const beta = path.join(home, ".agents/skills/beta");
              yield* fs.symlink(path.join(home, "library/skills/beta"), beta);
              const listed = (yield* catalog.list({})).skills;

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "alpha"), refOf(listed, "global", "beta")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes.map(({ status, blocked }) => ({ status, blocked }))).toEqual([
                {
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "entryTaken" }],
                },
                {
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "entryTaken" }],
                },
              ]);
              yield* encodeResult(result);
              expect(
                yield* fs.readFileString(path.join(home, ".claude/skills/alpha/mine.md")),
              ).toBe("my own notes");
              expect(yield* fs.readFileString(path.join(home, ".claude/skills/beta"))).toBe(
                "a file",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("never points a link that is there somewhere else", () =>
      Effect.gen(function* () {
        const { fs, path, home, link } = yield* makeMachine;
        // Claude's own `alpha` is already a link, to the other skill.
        yield* link("library/skills/beta", ".claude/skills/alpha");
        yield* withManager(home, [], ({ manager, catalog }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({});

            const result = yield* manager.enable({
              skills: [refOf(skills, "global", "alpha")],
              agents: [agent("claudeAgent")],
            });

            expect(result.outcomes[0]?.blocked).toEqual([
              { instanceId: "claudeAgent", reason: "entryTaken" },
            ]);
            expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
              path.join(home, "library/skills/beta"),
            );
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't link a skill the agent would never load because another comes first",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project, write } = yield* makeMachine;
          // Claude reads its global folder before the project's, so a global `verify` wins.
          yield* write(".claude/skills/verify/SKILL.md", skillFile("verify"));
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });

              const result = yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "project", "verify")],
                agents: [agent("claudeAgent"), agent("codex")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "claudeAgent", reason: "shadowed" }],
              });
              expect(yield* fs.exists(path.join(project, ".claude"))).toBe(false);
            }),
          );
        }),
    );
  });

  describe("disable", () => {
    it.effect.skipIf(!symlinksSupported)(
      "removes the agent's link and leaves the skill's own folder and every other link",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              yield* manager.enable({ skills: [alpha], agents: [agent("claudeAgent")] });

              const result = yield* manager.disable({
                skills: [alpha],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]).toEqual({
                skill: alpha,
                status: "changed",
                blocked: [],
                affected: [],
              });
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
              expect(
                yield* fs.readFileString(path.join(home, "library/skills/alpha/notes.md")),
              ).toBe("notes on alpha");
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha")).toMatchObject({
                claudeAgent: "none",
                codex: "direct",
              });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses for an agent that reads the skill's folder, changing nothing",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});

              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "alpha"), refOf(skills, "global", "solo")],
                // Codex reads the shared folder the alpha link is in; Claude reads solo's own folder.
                agents: [agent("codex"), agent("claudeAgent")],
              });

              expect(result.outcomes.map(({ status, blocked }) => ({ status, blocked }))).toEqual([
                {
                  status: "skipped",
                  blocked: [{ instanceId: "codex", reason: "alwaysOn" }],
                },
                {
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "alwaysOn" }],
                },
              ]);
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "names the other agents that lose the skill with the link",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, link } = yield* makeMachine;
          // `beta` is only linked in Claude's folder, which Cursor and OpenCode read too.
          yield* link("library/skills/beta", ".claude/skills/beta");
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              expect(stateOf(skills, "global", "beta")).toMatchObject({
                claudeAgent: "link",
                cursor: "link",
                opencode: "link",
              });

              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "beta")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "changed",
                affected: [agent("cursor"), agent("opencode")],
              });
              expect(yield* fs.exists(path.join(home, "library/skills/beta/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );
  });

  describe("remove", () => {
    it.effect.skipIf(!symlinksSupported)(
      "removes every link to the skill and never the original folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              yield* manager.enable({ skills: [alpha], agents: [agent("claudeAgent")] });

              const result = yield* manager.remove({ skills: [alpha] });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(result.outcomes[0]?.affected).toContain(agent("claudeAgent"));
              expect(result.outcomes[0]?.affected).toContain(agent("codex"));
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(false);
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
              expect(
                yield* fs.readFileString(path.join(home, "library/skills/alpha/SKILL.md")),
              ).toBe(skillFile("alpha"));
              expect((yield* catalog.list({})).skills.some((skill) => skill.name === "alpha")).toBe(
                false,
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("does nothing to a skill that is a real folder", () =>
      Effect.gen(function* () {
        const { fs, path, home } = yield* makeMachine;
        yield* withManager(home, [], ({ manager, catalog }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({});

            const result = yield* manager.remove({ skills: [refOf(skills, "global", "solo")] });

            expect(result.outcomes[0]).toMatchObject({ status: "unchanged", blocked: [] });
            expect(yield* fs.exists(path.join(home, ".claude/skills/solo/SKILL.md"))).toBe(true);
          }),
        );
      }),
    );
  });

  describe("requests", () => {
    it.effect.skipIf(!symlinksSupported)(
      "refuses to write when the skill is no longer where the list said, or gone",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              // The shared folder's `alpha` now leads to another folder.
              yield* fs.remove(path.join(home, ".agents/skills/alpha"));
              yield* fs.symlink(
                path.join(home, "library/skills/beta"),
                path.join(home, ".agents/skills/alpha"),
              );

              const result = yield* manager.enable({
                skills: [alpha, { scope: "global", name: "ghost", home: "~/ghost" }],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes.map(({ status, reason }) => ({ status, reason }))).toEqual([
                { status: "skipped", reason: "changed" },
                { status: "skipped", reason: "notFound" },
              ]);
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a project folder the environment doesn't know, and an agent it doesn't have",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [], ({ manager }) =>
            Effect.gen(function* () {
              // The list itself refuses a folder that isn't a project, so name the skill as a
              // client holding an older list would.
              const verify: SkillRef = {
                scope: "project",
                name: "verify",
                home: ".agents/skills/verify",
              };

              const unregistered = yield* manager
                .enable({ cwd: project, skills: [verify], agents: [agent("claudeAgent")] })
                .pipe(Effect.flip);
              expect(unregistered).toEqual(
                new SkillRequestError({ reason: "projectNotRegistered" }),
              );
              expect(yield* fs.exists(path.join(project, ".claude"))).toBe(false);
            }),
          );
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });

              const unknown = yield* manager
                .enable({
                  cwd: project,
                  skills: [refOf(skills, "project", "verify")],
                  agents: [agent("not-an-agent")],
                })
                .pipe(Effect.flip);
              expect(unknown).toEqual(new SkillRequestError({ reason: "unknownAgent" }));
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "tells what happened to each skill in a bulk request, and one bad skill doesn't stop the rest",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const alpha = refOf(skills, "global", "alpha");
              const ghost: SkillRef = { scope: "global", name: "ghost", home: "~/ghost" };
              const verify = refOf(skills, "project", "verify");
              const solo = refOf(skills, "global", "solo");

              const result = yield* manager.enable({
                cwd: project,
                skills: [alpha, ghost, verify, solo],
                agents: [agent("claudeAgent")],
              });

              expect(
                result.outcomes.map(({ skill, status }) => [skill.name, status] as const),
              ).toEqual([
                ["alpha", "changed"],
                ["ghost", "skipped"],
                ["verify", "changed"],
                // Claude reads solo's folder itself.
                ["solo", "unchanged"],
              ]);
              yield* encodeResult(result);
            }),
          );
        }),
    );
  });
});

describe("the request and result schemas", () => {
  const ref = { scope: "global", name: "alpha", home: "~/alpha" } as const;
  const decodes = (schema: Schema.Decoder<unknown>, input: unknown) =>
    Schema.decodeUnknownOption(schema)(input).pipe(Option.isSome);

  it("accepts a request for some skills and agents", () => {
    expect(decodes(SkillEnableInput, { skills: [ref], agents: ["claudeAgent"] })).toBe(true);
    expect(decodes(SkillDisableInput, { cwd: "/repo", skills: [ref], agents: ["codex"] })).toBe(
      true,
    );
    expect(decodes(SkillRemoveInput, { skills: [ref] })).toBe(true);
  });

  it("rejects a request for no skills, no agents or too many skills", () => {
    expect(decodes(SkillEnableInput, { skills: [], agents: ["codex"] })).toBe(false);
    expect(decodes(SkillEnableInput, { skills: [ref], agents: [] })).toBe(false);
    expect(decodes(SkillRemoveInput, { skills: Array.from({ length: 201 }, () => ref) })).toBe(
      false,
    );
    expect(decodes(SkillRemoveInput, { skills: Array.from({ length: 200 }, () => ref) })).toBe(
      true,
    );
  });
});

describe("planEnable", () => {
  const read = (directory: string, scope: SkillScope, rival = false, standard = false) => ({
    scope,
    directory,
    label: directory,
    standard,
    rival,
  });
  const skill = (
    agents: SkillCatalog.ResolvedSkill["agents"],
    entries: SkillCatalog.ResolvedSkill["entries"] = [],
  ): SkillCatalog.ResolvedSkill => ({
    scope: "project",
    name: "verify",
    displayHome: ".agents/skills/verify",
    home: "/repo/.agents/skills/verify",
    entries,
    agents,
  });
  const member = (
    instanceId: string,
    collision: "first-wins" | "all",
    reads: ReturnType<typeof read>[],
  ) => ({
    instanceId: agent(instanceId),
    driver: ProviderInstanceId.make(instanceId) as never,
    collision,
    state: "none" as const,
    via: [],
    reads,
  });
  const everyone = new Set(["a", "b"].map((id) => agent(id)));

  it("links in the shared folder when the agent reads it, even when its own folder is first", () => {
    const plan = planEnable(
      skill([
        member("a", "first-wins", [
          read("/repo/.pi/skills", "project"),
          read("/repo/.agents/skills", "project", false, true),
        ]),
      ]),
      everyone,
    );
    expect(plan.links).toEqual([{ directory: "/repo/.agents/skills", agents: [agent("a")] }]);
  });

  it("makes one link for agents that read the same folder, and none where it is there already", () => {
    const shared = [read("/repo/.agents/skills", "project", false, true)];
    expect(
      planEnable(skill([member("a", "all", shared), member("b", "first-wins", shared)]), everyone)
        .links,
    ).toEqual([{ directory: "/repo/.agents/skills", agents: [agent("a"), agent("b")] }]);
    expect(
      planEnable(
        skill(
          [member("a", "all", shared)],
          [{ path: "/repo/.agents/skills/verify", directory: "/repo/.agents/skills", target: "x" }],
        ),
        everyone,
      ).links,
    ).toEqual([]);
  });

  it("holds back an agent that loads another skill with the name first, unless it loads them all", () => {
    const reads = [
      read("/home/.claude/skills", "global", true),
      read("/repo/.claude/skills", "project"),
    ];
    const plan = planEnable(
      skill([member("a", "first-wins", reads), member("b", "all", reads)]),
      everyone,
    );
    expect(plan.blocked).toEqual([{ instanceId: agent("a"), reason: "shadowed" }]);
    expect(plan.links).toEqual([{ directory: "/repo/.claude/skills", agents: [agent("b")] }]);
  });
});
