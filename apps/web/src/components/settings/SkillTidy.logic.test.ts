import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { SkillAgentAccess, SkillOutcome } from "@t3tools/contracts";

import {
  defaultTidyChoices,
  describeTidy,
  tidyBanner,
  tidyConfirmation,
  tidyFindings,
  tidySignature,
  tidySteps,
  type TidyChoices,
} from "./SkillTidy.logic";
import type { Skill, SkillAgent, SkillsContext } from "./SkillsSettings.logic";

const agent = (id: string, displayName: string): SkillAgent => ({
  instanceId: ProviderInstanceId.make(id),
  driverKind: ProviderDriverKind.make(id),
  displayName,
  accentColor: undefined,
});
const claude = agent("claudeAgent", "Claude");
const codex = agent("codex", "Codex");
const ctx: SkillsContext = { installed: [claude, codex] };

type Reach = Partial<Record<"claudeAgent" | "codex", SkillAgentAccess["state"]>>;

/** A skill as the server lists it: in the project's shared folder, which both agents can use. */
function skill(name: string, extra: Partial<Skill> & { reach?: Reach } = {}): Skill {
  const { reach = {}, ...rest } = extra;
  const scope = rest.scope ?? "project";
  const home =
    rest.home ?? (scope === "global" ? `~/.agents/skills/${name}` : `.agents/skills/${name}`);
  return {
    id: `${scope}\0${name}\0${home}`,
    name,
    scope,
    home,
    description: "",
    realFolder: true,
    copies: [],
    access: [claude, codex].map((entry) => ({
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      state: reach[entry.instanceId as keyof Reach] ?? "link",
      folder: ".agents/skills",
    })),
    ...rest,
  };
}

const inClaudeFolder = (name: string) =>
  skill(name, { home: `.claude/skills/${name}`, reach: { claudeAgent: "direct", codex: "none" } });

const choose = (
  skills: readonly Skill[],
  change: (choices: TidyChoices) => Partial<TidyChoices> = () => ({}),
) => {
  const findings = tidyFindings(skills, ctx);
  const choices = defaultTidyChoices(findings);
  return { findings, steps: tidySteps(findings, { ...choices, ...change(choices) }) };
};

const names = (skills: readonly Skill[]) => skills.map((item) => item.name);

describe("tidyFindings", () => {
  it.each([
    {
      case: "a healthy project",
      skills: [skill("lint"), skill("deploy", { scope: "global" })],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "a pack of two from one source",
      skills: [skill("tdd", { source: "acme/skills" }), skill("prd", { source: "acme/skills" })],
      expected: {
        packs: [["acme/skills", ["tdd", "prd"]]],
        duplicates: [],
        ownFolder: [],
        missing: [],
      },
    },
    {
      case: "a single skill from a source is no pack",
      skills: [skill("tdd", { source: "acme/skills" })],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "a pack skill that is in Global already can't move there",
      skills: [
        skill("tdd", { source: "acme/skills" }),
        skill("prd", {
          source: "acme/skills",
          copies: [{ scope: "global", home: "~/.agents/skills/prd", same: false }],
        }),
      ],
      expected: { packs: [], duplicates: ["prd"], ownFolder: [], missing: [] },
    },
    {
      case: "a skill reached through a link can't be moved or deleted",
      skills: [
        skill("synced", {
          realFolder: false,
          home: "~/library/synced",
          copies: [{ scope: "global", home: "~/.agents/skills/synced", same: true }],
        }),
      ],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "a folder in Claude's own folder, which Codex can't read",
      skills: [inClaudeFolder("review")],
      expected: {
        packs: [],
        duplicates: [],
        ownFolder: ["review"],
        missing: [["codex", ["review"]]],
      },
    },
    {
      case: "an agent switched off by its own settings isn't missing the skill",
      skills: [skill("lint", { reach: { claudeAgent: "off" } })],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "an agent T3 Code can't switch isn't missing the skill",
      skills: [
        {
          ...skill("lint"),
          access: [
            {
              instanceId: claude.instanceId,
              driver: claude.driverKind,
              state: "none" as const,
              folder: "x",
              fixed: true,
            },
          ],
        },
      ],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "Claude can't load a skill whose header it can't read",
      skills: [skill("odd", { invalidHeader: true, reach: { claudeAgent: "none" } })],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "a skill that shares its name may lose to the other, so it isn't missing",
      skills: [
        skill("lint", {
          reach: { claudeAgent: "none" },
          copies: [{ scope: "project", home: ".codex/skills/lint", same: false }],
        }),
      ],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
    {
      case: "a project's plugin skill belongs to its agent, so there is nothing to tidy",
      skills: [
        skill("review-kit:review", {
          home: "~/.claude/plugins/cache/review-kit/skills/review",
          provided: "plugin",
          reach: { claudeAgent: "direct", codex: "none" },
        }),
      ],
      expected: { packs: [], duplicates: [], ownFolder: [], missing: [] },
    },
  ])("$case", ({ skills, expected }) => {
    const findings = tidyFindings(skills, ctx);
    expect({
      packs: findings.packs.map((pack) => [pack.source, names(pack.skills)]),
      duplicates: findings.duplicates.map((entry) => entry.skill.name),
      ownFolder: names(findings.ownFolder),
      missing: findings.missing.map((entry) => [entry.agent.instanceId, names(entry.skills)]),
    }).toEqual(expected);
  });

  it("keeps where the Global copy of a duplicate is, to compare the two", () => {
    const findings = tidyFindings(
      [
        skill("lint", {
          copies: [{ scope: "global", home: "~/.claude/skills/lint", same: false }],
        }),
      ],
      ctx,
    );
    expect(findings.duplicates.map((entry) => entry.globalHome)).toEqual(["~/.claude/skills/lint"]);
  });
});

describe("tidySteps", () => {
  const pack = [skill("tdd", { source: "acme/skills" }), skill("prd", { source: "acme/skills" })];
  const duplicate = skill("lint", {
    copies: [{ scope: "global", home: "~/.agents/skills/lint", same: false }],
  });

  it("does nothing to packs and duplicates by default, and fixes the rest", () => {
    const { steps } = choose([
      ...pack,
      duplicate,
      inClaudeFolder("review"),
      skill("e2e", { reach: { codex: "none" } }),
    ]);
    expect({
      remove: names(steps.remove),
      toGlobal: names(steps.toGlobal),
      share: names(steps.share),
      turnOn: steps.turnOn.map((entry) => [entry.agent.displayName, names(entry.skills)]),
    }).toEqual({
      remove: [],
      toGlobal: [],
      share: ["review"],
      // The shared skill reaches Codex through the shared folder; only the other is turned on.
      turnOn: [["Codex", ["e2e"]]],
    });
  });

  it.each([
    {
      case: "moving a pack to Global",
      change: () => ({ packsToGlobal: new Set(["acme/skills"]) }),
      expected: { remove: [], toGlobal: ["tdd", "prd"], share: [], turnOn: [] },
    },
    {
      case: "keeping Global's copy",
      change: () => ({ keepGlobal: new Set(["lint"]) }),
      expected: { remove: ["lint"], toGlobal: [], share: [], turnOn: [] },
    },
  ])("$case", ({ change, expected }) => {
    const { steps } = choose([...pack, duplicate], change);
    expect({
      remove: names(steps.remove),
      toGlobal: names(steps.toGlobal),
      share: names(steps.share),
      turnOn: steps.turnOn.map((entry) => names(entry.skills)),
    }).toEqual(expected);
  });

  it("leaves a skill that moves to Global out of the later steps", () => {
    const tdd = skill("tdd", {
      source: "acme/skills",
      home: ".claude/skills/tdd",
      reach: { claudeAgent: "direct", codex: "none" },
    });
    const prd = skill("prd", { source: "acme/skills", reach: { claudeAgent: "none" } });
    const { steps } = choose([tdd, prd], () => ({ packsToGlobal: new Set(["acme/skills"]) }));
    expect(names(steps.toGlobal)).toEqual(["tdd", "prd"]);
    expect(steps.share).toEqual([]);
    expect(steps.turnOn).toEqual([]);
  });

  it("turns nothing on for an agent that is unticked", () => {
    const { steps } = choose([skill("e2e", { reach: { codex: "none" } })], () => ({
      turnOn: new Set(),
    }));
    expect(steps.turnOn).toEqual([]);
  });
});

describe("tidyBanner", () => {
  it.each([
    { case: "nothing to tidy", skills: [skill("lint")], expected: null },
    {
      case: "the agent missing the most skills comes first",
      skills: [
        skill("a", { reach: { codex: "none" } }),
        skill("b", { reach: { codex: "none" } }),
        skill("c", { reach: { claudeAgent: "none" } }),
        skill("lint", { copies: [{ scope: "global", home: "~/.agents/skills/lint", same: true }] }),
      ],
      expected: "Codex can't use 2 of this project's skills.",
    },
    {
      case: "a copy that is also in Global",
      skills: [
        skill("lint", { copies: [{ scope: "global", home: "~/.agents/skills/lint", same: true }] }),
      ],
      expected: "“lint” is in this project and in Global.",
    },
    {
      case: "folders in Claude's own folder that every agent already reaches",
      skills: [
        skill("review", {
          home: ".claude/skills/review",
          reach: { claudeAgent: "direct", codex: "link" },
        }),
        skill("deploy", {
          home: ".claude/skills/deploy",
          reach: { claudeAgent: "direct", codex: "link" },
        }),
      ],
      expected: "2 skills sit in Claude's own folder.",
    },
    {
      case: "a folder in another agent's own folder",
      skills: [skill("review", { home: ".codex/skills/review" })],
      expected: "1 skill sits in an agent's own folder.",
    },
    {
      case: "only a pack",
      skills: [skill("tdd", { source: "acme/skills" }), skill("prd", { source: "acme/skills" })],
      expected: "2 skills from acme/skills could be Global.",
    },
  ])("$case", ({ skills, expected }) => {
    expect(tidyBanner(tidyFindings(skills, ctx))).toBe(expected);
  });

  it("changes its signature only when the problems change", () => {
    const one = tidySignature(
      tidyFindings([skill("a", { reach: { codex: "none" } }), skill("ok")], ctx),
    );
    const same = tidySignature(
      tidyFindings([skill("ok"), skill("a", { reach: { codex: "none" } })], ctx),
    );
    const more = tidySignature(
      tidyFindings(
        [skill("a", { reach: { codex: "none" } }), skill("b", { reach: { codex: "none" } })],
        ctx,
      ),
    );
    expect(same).toBe(one);
    expect(more).not.toBe(one);
  });
});

describe("tidyConfirmation", () => {
  const duplicate = skill("lint", {
    copies: [{ scope: "global", home: "~/.agents/skills/lint", same: false }],
  });
  const { steps } = choose(
    [duplicate, inClaudeFolder("review"), skill("e2e", { reach: { codex: "none" } })],
    () => ({ keepGlobal: new Set(["lint"]) }),
  );

  it("lists every step, and warns that a delete git doesn't track is for good", () => {
    expect(tidyConfirmation("acme-web", steps, null)).toEqual({
      title: "Tidy up acme-web?",
      body: "",
      notes: [
        "Delete this project's copy of “lint” and keep Global's. This can't be undone.",
        "Move 1 skill to the shared folder, so every agent can use it.",
        "Turn on 1 skill for Codex.",
      ],
      confirm: "Tidy up",
      destructive: true,
    });
  });

  it.each([
    {
      case: "git tracks everything",
      tracked: ["lint", "review"],
      first: "Delete this project's copy of “lint” and keep Global's.",
      last: "You can undo this with git.",
    },
    {
      case: "git tracks only the moved folder",
      tracked: ["review"],
      first: "Delete this project's copy of “lint” and keep Global's. This can't be undone.",
      last: "1 of these is tracked by git, so you can undo that one with git.",
    },
  ])("says what git can undo when $case", ({ tracked, first, last }) => {
    const { notes } = tidyConfirmation("acme-web", steps, tracked);
    expect(notes[0]).toBe(first);
    expect(notes.at(-1)).toBe(last);
  });
});

describe("describeTidy", () => {
  const outcome = (name: string, extra: Partial<SkillOutcome> = {}): SkillOutcome => ({
    skill: { scope: "project", name, home: `.agents/skills/${name}` },
    status: "changed",
    blocked: [],
    affected: [],
    ...extra,
  });

  it.each([
    {
      case: "every step went through",
      results: [
        { kind: "toGlobal" as const, outcomes: [outcome("tdd"), outcome("prd")], asked: 2 },
        { kind: "turnOn" as const, agent: claude, outcomes: [outcome("e2e")], asked: 1 },
      ],
      expected: "Tidied up: made 2 skills Global and turned on 1 skill for Claude.",
    },
    {
      case: "a skill was skipped and a batch went unanswered",
      results: [
        {
          kind: "share" as const,
          outcomes: [
            outcome("review"),
            outcome("deploy", { status: "skipped", reason: "destinationTaken" }),
          ],
          asked: 3,
        },
      ],
      expected: "Tidied up: moved 1 skill to the shared folder. 2 skills couldn't be changed.",
    },
    {
      case: "nothing was asked for",
      results: [],
      expected: "Nothing changed.",
    },
  ])("$case", ({ results, expected }) => {
    expect(describeTidy(results)).toBe(expected);
  });
});
