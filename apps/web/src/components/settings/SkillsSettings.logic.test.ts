import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type {
  ServerProvider,
  SkillAgentAccess,
  SkillListResult,
  SkillOutcome,
} from "@t3tools/contracts";

import {
  agentSkillPath,
  attention,
  availability,
  availabilityNote,
  compareSkillFiles,
  describeResult,
  ingestSkills,
  installedAgents,
  matchesQuery,
  planDelete,
  planFix,
  planMove,
  planRemove,
  planToggle,
  planTurnOff,
  planTurnOnAll,
  scriptFiles,
  skillBody,
  skillsEnvironment,
  skillsToCheckWithGit,
  switchBlocker,
  unreadableNote,
  withGitNote,
  type Skill,
  type SkillAgent,
} from "./SkillsSettings.logic";

const agent = (instanceId: string, driver: string, displayName: string): SkillAgent => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName,
  accentColor: undefined,
});
const claude = agent("claudeAgent", "claudeAgent", "Claude");
const codex = agent("codex", "codex", "Codex");
const claudeWork = agent("claude_work", "claudeAgent", "Claude Work");
const ALL = [claude, codex, agent("cursor", "cursor", "Cursor")];

/** A skill the way the server reports it; `reach` says how each listed agent gets to it. */
function skill(
  name: string,
  reach: Partial<Record<string, SkillAgentAccess["state"]>> = {},
  extra: Partial<Skill> = {},
): Skill {
  const scope = extra.scope ?? "project";
  return {
    id: `${scope}\0${name}`,
    name,
    scope,
    home: scope === "global" ? `~/.agents/skills/${name}` : `.agents/skills/${name}`,
    description: `The ${name} skill.`,
    copies: [],
    access: [...ALL, claudeWork].map((entry) => ({
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      state: reach[entry.instanceId] ?? "none",
      folder: scope === "global" ? "~/.agents/skills" : ".agents/skills",
    })),
    ...extra,
  };
}

const provider = (
  instanceId: string,
  driver: string,
  over: Partial<
    Pick<ServerProvider, "installed" | "enabled" | "availability" | "displayName">
  > = {},
) =>
  ({
    instanceId,
    driver,
    installed: true,
    enabled: true,
    status: "ready",
    models: [],
    skills: [],
    ...over,
  }) as unknown as ServerProvider;

describe("ingestSkills", () => {
  it("gives every skill home its own id and lists the instances the server knows", () => {
    const result: SkillListResult = {
      skills: [
        skill("tdd", { codex: "direct" }),
        skill("tdd", { codex: "direct" }, { home: ".claude/skills/tdd" }),
        skill("tdd", { codex: "direct" }, { scope: "global" }),
      ],
      unreadable: [{ scope: "global", folder: "~/.claude/skills" }],
    };
    const { skills, known, unreadable } = ingestSkills(result);
    expect(new Set(skills.map((item) => item.id)).size).toBe(3);
    expect([...known].toSorted()).toEqual(["claudeAgent", "claude_work", "codex", "cursor"]);
    expect(unreadable).toEqual([{ scope: "global", folder: "~/.claude/skills" }]);
  });
});

describe("skillsEnvironment", () => {
  const home = { environmentId: EnvironmentId.make("home") };
  const work = { environmentId: EnvironmentId.make("work") };
  const all = [home, work];

  it("uses the scope's connected environment", () => {
    expect(
      skillsEnvironment({
        connected: work,
        scopeEnvironmentIds: [work.environmentId],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBe(work);
  });

  it("keeps an offline scoped environment instead of showing the primary one's skills", () => {
    expect(
      skillsEnvironment({
        connected: null,
        scopeEnvironmentIds: [work.environmentId],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBe(work);
  });

  it("has no environment when the scope names one that is gone", () => {
    expect(
      skillsEnvironment({
        connected: null,
        scopeEnvironmentIds: [EnvironmentId.make("gone")],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBeUndefined();
  });

  it("falls back to the primary, then the first, when the scope names no environment", () => {
    const fallback = { connected: null, scopeEnvironmentIds: [], environments: all };
    expect(skillsEnvironment({ ...fallback, primaryId: work.environmentId })).toBe(work);
    expect(skillsEnvironment({ ...fallback, primaryId: null })).toBe(home);
    expect(skillsEnvironment({ ...fallback, environments: [], primaryId: null })).toBeUndefined();
  });
});

describe("installedAgents", () => {
  const known = new Set(
    ["claudeAgent", "claude_work", "codex", "cursor", "pi", "opencode"].map((id) =>
      ProviderInstanceId.make(id),
    ),
  );

  it("keeps instances that are installed, enabled and reachable, each with its own name", () => {
    expect(
      installedAgents(
        [
          provider("claudeAgent", "claudeAgent", { displayName: "Claude" }),
          provider("claude_work", "claudeAgent", { displayName: "Claude Work" }),
          provider("codex", "codex", { installed: false }),
          provider("pi", "pi", { enabled: false }),
          provider("opencode", "opencode", { availability: "unavailable" }),
          provider("cursor", "cursor"),
        ],
        known,
      ).map((item) => [item.instanceId, item.displayName]),
    ).toEqual([
      ["claudeAgent", "Claude"],
      ["claude_work", "Claude Work"],
      ["cursor", "Cursor"],
    ]);
  });

  it("leaves out instances the server has no folders for", () => {
    expect(
      installedAgents(
        [provider("claudeAgent", "claudeAgent"), provider("codex", "codex")],
        new Set([ProviderInstanceId.make("claudeAgent")]),
      ).map((item) => item.instanceId),
    ).toEqual(["claudeAgent"]);
  });
});

describe("who can use a skill", () => {
  const ctx = { installed: [claude, codex] };

  it("shows one mark when every installed agent can, whatever the others do", () => {
    const value = availability(skill("a", { claudeAgent: "link", codex: "direct" }), ctx);
    expect(value).toMatchObject({ everyone: true, missing: [] });
    expect(value.agents).toEqual([claude, codex]);
    expect(availabilityNote(value)).toBe("Available to all your agents");
  });

  it("names the agents that can't", () => {
    const value = availability(skill("a", { codex: "direct" }), ctx);
    expect(value).toMatchObject({ everyone: false, agents: [codex], missing: [claude] });
    expect(availabilityNote(value)).toBe("Not available to Claude");
  });

  it("tells two instances of one agent apart by their names", () => {
    const both = { installed: [claude, claudeWork] };
    const value = availability(skill("a", { claude_work: "direct" }), both);
    expect(value.agents).toEqual([claudeWork]);
    expect(availabilityNote(value)).toBe("Not available to Claude");
    expect(availabilityNote(availability(skill("a"), both))).toBe(
      "Not available to Claude and Claude Work",
    );
  });

  it("is never everyone when no agent is installed", () => {
    const value = availability(skill("a", { codex: "direct" }), { installed: [] });
    expect(value).toMatchObject({ everyone: false, agents: [], missing: [] });
  });

  it("tells where an agent reads the skill, or where it looks when it can't see it", () => {
    const linked = skill("a", { claudeAgent: "link" });
    const withFolder = {
      ...linked,
      access: linked.access.map((item) =>
        item.instanceId === "claudeAgent" ? { ...item, folder: ".claude/skills" } : item,
      ),
    };
    expect(agentSkillPath(withFolder, claude)).toBe(".claude/skills/a");
    expect(agentSkillPath(withFolder, codex)).toBe(".agents/skills");
    expect(agentSkillPath(withFolder, agent("unknown", "pi", "Pi"))).toBeNull();
  });
});

describe("attention", () => {
  const ctx = { installed: [claude, codex] };
  const both = { claudeAgent: "link", codex: "direct" } as const;

  it("flags a skill that differs from a copy in the other scope, and names that scope", () => {
    const different = [{ scope: "global", home: "~/.agents/skills/tdd", same: false }] as const;
    expect(attention(skill("tdd", both, { copies: different }), ctx)).toEqual({
      kind: "conflict",
      detail: "Global has a different “tdd”.",
    });
    expect(
      attention(
        skill("tdd", both, {
          scope: "global",
          copies: [{ scope: "project", home: ".agents/skills/tdd", same: false }],
        }),
        ctx,
      ),
    ).toEqual({ kind: "conflict", detail: "This project has a different “tdd”." });
  });

  it("flags a copy that differs from another one in the same scope", () => {
    expect(
      attention(
        skill("tdd", both, {
          copies: [{ scope: "project", home: ".claude/skills/tdd", same: false }],
        }),
        ctx,
      )?.detail,
    ).toBe("Another “tdd” in this project is different.");
    expect(
      attention(
        skill("tdd", both, {
          scope: "global",
          copies: [{ scope: "global", home: "~/.claude/skills/tdd", same: false }],
        }),
        ctx,
      )?.detail,
    ).toBe("Another global “tdd” is different.");
  });

  it("doesn't flag an identical copy", () => {
    const same = [{ scope: "global", home: "~/.agents/skills/tdd", same: true }] as const;
    expect(attention(skill("tdd", both, { copies: same }), ctx)).toBeNull();
  });

  it("flags a skill an installed agent can't use, and says which", () => {
    expect(attention(skill("a", { codex: "direct" }), ctx)).toEqual({
      kind: "missing",
      detail: "Not available to Claude",
    });
    expect(attention(skill("a", both), ctx)).toBeNull();
  });

  it("says plainly when Claude can't read the header", () => {
    expect(attention(skill("a", { codex: "direct" }, { invalidHeader: true }), ctx)).toEqual({
      kind: "header",
      detail: "Claude can't read this skill's header.",
    });
    // Without Claude there is nothing to report about its header.
    expect(
      attention(skill("a", { codex: "direct" }, { invalidHeader: true }), { installed: [codex] }),
    ).toBeNull();
  });

  it("ignores agents that aren't installed, and puts a conflict first", () => {
    expect(attention(skill("a", { codex: "direct" }), { installed: [codex] })).toBeNull();
    const conflicting = skill(
      "a",
      {},
      { copies: [{ scope: "global", home: "~/.agents/skills/a", same: false }] },
    );
    expect(attention(conflicting, ctx)?.kind).toBe("conflict");
  });
});

describe("unreadableNote", () => {
  const folder = (name: string) => ({ scope: "global" as const, folder: name });

  it("names the folders that couldn't be read, briefly", () => {
    expect(unreadableNote([])).toBe("");
    expect(unreadableNote([folder("~/.claude/skills")])).toBe("Couldn't read ~/.claude/skills");
    expect(unreadableNote([folder("~/.claude/skills"), folder(".pi/skills")])).toBe(
      "Couldn't read ~/.claude/skills and .pi/skills",
    );
    expect(unreadableNote(["a", "b", "c", "d"].map(folder))).toBe("Couldn't read a, b and 2 more");
  });
});

describe("search", () => {
  it("matches the name and the description", () => {
    const item = skill("verify", {}, { description: "Drive the app" });
    expect(matchesQuery(item, "verif")).toBe(true);
    expect(matchesQuery(item, "drive")).toBe(true);
    expect(matchesQuery(item, "nope")).toBe(false);
    expect(matchesQuery(item, "")).toBe(true);
  });
});

describe("a skill's files", () => {
  it("calls files an agent could run scripts, but never SKILL.md", () => {
    expect(
      scriptFiles([
        { path: "SKILL.md", executable: true },
        { path: "bin/run", executable: false },
        { path: "lib/serve.mjs", executable: false },
        { path: "refs/notes.md", executable: false },
        { path: "tools/check", executable: true },
      ]),
    ).toEqual(["bin/run", "lib/serve.mjs", "tools/check"]);
  });

  it("sorts SKILL.md first, then folders before files, with numbers in order", () => {
    const entry = (path: string, isDirectory = false) => ({
      path,
      isDirectory,
      segments: path.replace(/\/$/, "").split("/"),
    });
    const sorted = [
      entry("refs/note-10.md"),
      entry("README.md"),
      entry("SKILL.md"),
      entry("refs/note-2.md"),
      entry("refs/", true),
      entry("a.txt"),
    ].toSorted(compareSkillFiles);
    expect(sorted.map((item) => item.path)).toEqual([
      "SKILL.md",
      "refs/",
      "refs/note-2.md",
      "refs/note-10.md",
      "a.txt",
      "README.md",
    ]);
  });

  it("drops the header and the blank lines after it from the rendered text", () => {
    expect(skillBody("---\nname: a\n---\n\n\n# Title\n")).toBe("# Title\n");
    expect(skillBody("---\r\nname: a\r\n---\r\n# Title\r\n")).toBe("# Title\r\n");
    expect(skillBody("# No header\n")).toBe("# No header\n");
  });
});

// -- Turning skills on and off --------------------------------------------------------------------

/** A skill whose agents each read it from their own folder, the way the server reports links. */
function reached(
  name: string,
  access: Record<string, { state: SkillAgentAccess["state"]; folder: string }>,
  home = `~/library/skills/${name}`,
): Skill {
  return {
    ...skill(name, {}, { scope: "global", home }),
    access: Object.entries(access).map(([instanceId, { state, folder }]) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(instanceId),
      state,
      folder,
    })),
  };
}
const ref = (name: string, home = `~/library/skills/${name}`) => ({
  scope: "global" as const,
  name,
  home,
});
const ctx = { installed: ALL };
const outcome = (over: Partial<SkillOutcome> & { name: string }): SkillOutcome => ({
  skill: ref(over.name),
  status: "changed",
  blocked: [],
  affected: [],
  ...over,
});

describe("an agent's switch", () => {
  it("is locked only when the agent reads the skill's folder itself", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "link", folder: "~/.codex/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    });
    expect(switchBlocker(tdd, claude)).toBe("Always on. It reads this folder directly.");
    expect(switchBlocker(tdd, codex)).toBeNull();
    expect(switchBlocker(tdd, ALL[2]!)).toBeNull();
  });

  it("turns on for the agent that was clicked, and off for one that has it", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "link", folder: "~/.codex/skills" },
    });
    expect(planToggle(tdd, claude, ctx)).toEqual({
      change: { kind: "enable", skills: [ref("tdd")], agents: ["claudeAgent"] },
      affected: 1,
    });
    expect(planToggle(tdd, codex, ctx)?.change).toEqual({
      kind: "disable",
      skills: [ref("tdd")],
      agents: ["codex"],
    });
  });
});

describe("turning on for all agents", () => {
  const cursor = ALL[2]!;
  it("asks for the agents that some selected skill is missing, and never asks first", () => {
    const first = reached("first", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const second = reached("second", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const done = reached("done", {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });

    const plan = planTurnOnAll([first, second, done], ctx);

    expect(plan?.change).toEqual({
      kind: "enable",
      skills: [ref("first"), ref("second")],
      agents: ["claudeAgent", "codex"],
    });
    expect(plan?.affected).toBe(2);
    expect(plan?.confirmation).toBeUndefined();
    expect(planTurnOnAll([done], ctx)).toBeNull();
  });

  it("leaves out agents that aren't installed", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    });
    expect(planTurnOnAll([tdd], { installed: [claude, cursor] })?.change).toMatchObject({
      agents: ["cursor"],
    });
  });

  it("gives one skill the same one-click fix, naming the agent when only one is missing", () => {
    const some = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const most = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    expect(planFix(some, ctx)?.label).toBe("Turn on for Claude");
    expect(planFix(most, ctx)?.label).toBe("Turn on for all agents");
    expect(planFix(most, ctx)?.plan.change).toMatchObject({ agents: ["claudeAgent", "codex"] });
    expect(
      planFix(reached("ok", { claudeAgent: { state: "link", folder: "~/.claude/skills" } }), {
        installed: [claude],
      }),
    ).toBeNull();
  });
});

describe("turning off for one agent", () => {
  const workCodex = agent("codex_work", "codex", "Codex Work");
  const both = { installed: [codex, workCodex, claude] };
  const linked = (name: string, ...others: Array<[string, "link" | "direct" | "none"]>) =>
    reached(name, {
      codex: { state: "link", folder: "~/.codex/skills" },
      codex_work: { state: "link", folder: "~/.codex/skills" },
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      ...Object.fromEntries(
        others.map(([id, state]) => [id, { state, folder: "~/.claude/skills" }]),
      ),
    });

  it("asks first when another agent reads the same link and loses the skill too", () => {
    const plan = planTurnOff([linked("tdd"), linked("grill")], codex, both);

    expect(plan?.change).toEqual({
      kind: "disable",
      skills: [ref("tdd"), ref("grill")],
      agents: ["codex"],
    });
    expect(plan?.confirmation).toEqual({
      title: "Turn off for Codex?",
      body: "Removes Codex's link for 2 skills.",
      notes: ["Codex Work loses these too."],
      confirm: "Turn off",
      destructive: false,
    });
  });

  it("goes ahead without asking when nothing else is lost", () => {
    const alone = reached("tdd", {
      codex: { state: "link", folder: "~/.codex/skills" },
      codex_work: { state: "none", folder: "~/.codex/skills" },
    });
    const plan = planTurnOff([alone], codex, both);
    expect(plan?.affected).toBe(1);
    expect(plan?.confirmation).toBeUndefined();
  });

  it("says which skills stay on because the agent reads their folder", () => {
    const stays = reached("stays", { codex: { state: "direct", folder: "~/.agents/skills" } });
    const plan = planTurnOff([linked("tdd"), stays], codex, { installed: [codex] });
    expect(plan?.change).toMatchObject({ skills: [ref("tdd")] });
    expect(plan?.confirmation?.notes).toEqual(["1 skill stays on because Codex reads its folder."]);
  });

  it("offers nothing for an agent that uses none of the skills", () => {
    expect(planTurnOff([linked("tdd")], claude, both)).toBeNull();
    const onlyStuck = planTurnOff(
      [reached("stays", { codex: { state: "direct", folder: "~/.agents/skills" } })],
      codex,
      both,
    );
    expect(onlyStuck?.affected).toBe(0);
  });
});

describe("removing skills from the agents", () => {
  it("names who stops using one skill, and who keeps it from its own folder", () => {
    const tdd = reached(
      "tdd",
      {
        claudeAgent: { state: "link", folder: "~/.claude/skills" },
        codex: { state: "direct", folder: "~/.agents/skills" },
        cursor: { state: "none", folder: "~/.cursor/skills" },
      },
      "~/.agents/skills/tdd",
    );
    const plan = planRemove([tdd], ctx);
    expect(plan?.change).toEqual({ kind: "remove", skills: [ref("tdd", "~/.agents/skills/tdd")] });
    expect(plan?.confirmation).toEqual({
      title: "Remove tdd from your agents?",
      body: "Claude will stop using it; the original in ~/.agents/skills/tdd isn't deleted.",
      notes: ["Codex still uses it from its own folder."],
      confirm: "Remove",
      destructive: true,
    });
  });

  it("counts skills for a bulk removal and leaves out those with no link to remove", () => {
    const linked = (name: string) =>
      reached(name, { claudeAgent: { state: "link", folder: "~/.claude/skills" } });
    const own = reached(
      "own",
      { claudeAgent: { state: "direct", folder: "~/.claude/skills" } },
      "~/.claude/skills/own",
    );
    const plan = planRemove([linked("a"), linked("b"), own], ctx);
    expect(plan?.affected).toBe(2);
    expect(plan?.change).toMatchObject({ skills: [ref("a"), ref("b")] });
    expect(plan?.confirmation).toMatchObject({
      title: "Remove 2 skills from your agents?",
      body: "Agents will stop using them; the originals aren't deleted.",
      notes: ["1 skill is only in its own folder, so nothing changes there."],
      destructive: true,
    });
    expect(planRemove([own], ctx)).toBeNull();
  });
});

/** A global skill kept in an agent's folder itself, so it can move or be deleted. */
const owned = (name: string, extra: Partial<Skill> = {}): Skill => ({
  ...reached(
    name,
    {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    },
    `~/.agents/skills/${name}`,
  ),
  realFolder: true,
  ...extra,
});

const ownedInProject = (name: string) =>
  owned(name, { scope: "project", home: `.agents/skills/${name}` });

describe("moving skills between this project and Global", () => {
  /** A skill kept in the project's shared folder, which Claude reaches through a link. */
  const inProject = (name: string, extra: Partial<Skill> = {}) =>
    owned(name, { scope: "project", home: `.agents/skills/${name}`, ...extra });

  it("always asks first, and says where the skill goes and who sees it", () => {
    const toGlobal = planMove([inProject("verify")], "global");
    expect(toGlobal?.change).toEqual({
      kind: "move",
      skills: [{ scope: "project", name: "verify", home: ".agents/skills/verify" }],
      to: "global",
    });
    expect(toGlobal?.confirmation).toEqual({
      title: "Move “verify” to Global?",
      body: "Moves to your Global skills, for all your projects.",
      notes: ["Agents that use it keep using it."],
      confirm: "Move",
      destructive: false,
    });

    const global = inProject("tdd", { scope: "global", home: "~/.agents/skills/tdd" });
    const toProject = planMove([global, inProject("grill", { scope: "global" })], "project");
    expect(toProject?.confirmation).toMatchObject({
      title: "Move 2 skills to this project?",
      body: "Moves into this project, so anyone who clones it gets it.",
      notes: ["Agents that use them keep using them."],
    });
  });

  it("asks git only about project skills a move takes out of a project", () => {
    const out = planMove([inProject("a"), inProject("b")], "global")!;
    expect(skillsToCheckWithGit(out)).toEqual(
      out.change.kind === "move" ? out.change.skills : null,
    );
    // Moving into a project makes new files, so there is nothing in git to undo.
    const global = inProject("g", { scope: "global" });
    expect(skillsToCheckWithGit(planMove([global], "project")!)).toBeNull();
    expect(planMove([inProject("a")], "global")?.confirmation?.notes.join(" ")).not.toContain(
      "git",
    );
  });

  it("leaves out skills that are in the place already or only reached through a link", () => {
    const linked = inProject("synced", { realFolder: undefined });
    const plan = planMove(
      [inProject("verify"), linked, inProject("home", { scope: "global" })],
      "global",
    );
    expect(plan?.change).toMatchObject({ skills: [{ name: "verify" }] });
    expect(plan?.affected).toBe(1);
    expect(plan?.confirmation?.notes).toContain("1 skill is reached through a link, so it stays.");
    expect(planMove([linked], "global")).toBeNull();
    expect(planMove([inProject("home", { scope: "global" })], "global")).toBeNull();
  });
});

describe("deleting skills", () => {
  it("names the folder that goes and who stops using the skill, apart from Remove", () => {
    const plan = planDelete([owned("tdd")], ctx);
    expect(plan?.change).toEqual({
      kind: "delete",
      skills: [ref("tdd", "~/.agents/skills/tdd")],
    });
    expect(plan?.confirmation).toEqual({
      title: "Delete tdd?",
      body: "This deletes ~/.agents/skills/tdd and any links to it. It can't be undone.",
      notes: ["Claude and Codex will stop using it."],
      confirm: "Delete",
      destructive: true,
    });
    expect(planRemove([owned("tdd")], ctx)?.confirmation?.body).toContain("isn't deleted");
  });

  it("counts the folders in a bulk delete and names some of the skills", () => {
    const plan = planDelete(
      ["a", "b", "c", "d", "e", "f"].map((name) => owned(name)),
      ctx,
    );
    expect(plan?.affected).toBe(6);
    expect(plan?.confirmation).toMatchObject({
      title: "Delete 6 skills?",
      body: "This deletes 6 folders and any links to them. It can't be undone.",
      notes: ["“a”, “b”, “c”, “d” and 2 more."],
      destructive: true,
    });
  });

  it("never offers to delete a skill that is only linked, and says Remove is for those", () => {
    const linked = owned("synced", { realFolder: undefined });
    const plan = planDelete([owned("tdd"), linked], ctx);
    expect(plan?.change).toMatchObject({ skills: [{ name: "tdd" }] });
    expect(plan?.confirmation?.notes).toContain(
      "1 skill is reached through a link, so it stays. Remove takes it away from your agents.",
    );
    expect(planDelete([linked], ctx)).toBeNull();
  });

  it("asks git about the project skills only, and not for a global one", () => {
    const plan = planDelete([ownedInProject("a"), owned("g")], ctx)!;
    expect(skillsToCheckWithGit(plan)?.map((skill) => skill.name)).toEqual(["a"]);
    expect(skillsToCheckWithGit(planDelete([owned("g")], ctx)!)).toBeNull();
  });
});

describe("promising an undo with git", () => {
  const delete3 = () =>
    planDelete([ownedInProject("a"), ownedInProject("b"), ownedInProject("c")], ctx)!;

  it("says so once the server has named the skills git tracks", () => {
    expect(
      withGitNote(planDelete([ownedInProject("a")], ctx)!, ["a"]).confirmation?.notes,
    ).toContain("You can undo this with git.");
    expect(withGitNote(delete3(), ["a", "b", "c"]).confirmation?.notes).toContain(
      "You can undo this with git.",
    );
    const some = withGitNote(delete3(), ["a"]).confirmation?.notes;
    expect(some).toContain("1 of these is tracked by git, so you can undo that one with git.");
    expect(withGitNote(delete3(), ["a", "b"]).confirmation?.notes).toContain(
      "2 of these are tracked by git, so you can undo those with git.",
    );
  });

  it("adds nothing when git tracks none of them, and works for a move out of a project", () => {
    const plan = delete3();
    expect(withGitNote(plan, [])).toBe(plan);
    expect(withGitNote(plan, ["other"])).toBe(plan);
    expect(
      withGitNote(planMove([ownedInProject("a")], "global")!, ["a"]).confirmation?.notes,
    ).toContain("You can undo this with git.");
  });

  it("leaves the plan's change alone", () => {
    const plan = delete3();
    expect(withGitNote(plan, ["a"]).change).toBe(plan.change);
  });
});

describe("telling what a change did", () => {
  it("says who got a skill, and who else did because they share a folder", () => {
    expect(
      describeResult(
        { kind: "enable", skills: [ref("a"), ref("b")], agents: [claude.instanceId] },
        [outcome({ name: "a", affected: [codex.instanceId] }), outcome({ name: "b" })],
        ctx,
      ),
    ).toBe("Turned on 2 skills for Claude. Codex gets them too.");
    expect(
      describeResult(
        { kind: "disable", skills: [ref("a")], agents: [codex.instanceId] },
        [outcome({ name: "a", affected: [claude.instanceId, ALL[2]!.instanceId] })],
        ctx,
      ),
    ).toBe("Turned off 1 skill for Codex. Claude and Cursor lose it too.");
    expect(
      describeResult({ kind: "remove", skills: [ref("a")] }, [outcome({ name: "a" })], ctx),
    ).toBe("Removed 1 skill from your agents.");
  });

  it("says where skills went and who else got them, and what a delete took", () => {
    expect(
      describeResult(
        { kind: "move", skills: [ref("a"), ref("b")], to: "global" },
        [outcome({ name: "a", affected: [codex.instanceId] }), outcome({ name: "b" })],
        ctx,
      ),
    ).toBe("Moved 2 skills to Global. Codex gets them too.");
    expect(
      describeResult(
        { kind: "move", skills: [ref("a")], to: "project" },
        [outcome({ name: "a" })],
        ctx,
      ),
    ).toBe("Moved 1 skill to this project.");
    expect(
      describeResult({ kind: "delete", skills: [ref("a")] }, [outcome({ name: "a" })], ctx),
    ).toBe("Deleted 1 skill.");
  });

  it("says why a move or a delete left a skill alone, or didn't finish", () => {
    expect(
      describeResult(
        { kind: "move", skills: [], to: "global" },
        [
          outcome({ name: "a", status: "skipped", reason: "destinationTaken" }),
          outcome({ name: "b", status: "skipped", reason: "linked" }),
          outcome({ name: "c", status: "skipped", reason: "inUse" }),
        ],
        ctx,
      ),
    ).toBe(
      "Global already has a “a”, so it stays. “b” is reached through a link, so it stays where it is. “c” is in use by another program, so it wasn't moved.",
    );
    expect(
      describeResult(
        { kind: "move", skills: [], to: "project" },
        [outcome({ name: "a", status: "skipped", reason: "destinationTaken" })],
        ctx,
      ),
    ).toBe("This project already has a “a”, so it stays.");
    expect(
      describeResult(
        { kind: "move", skills: [ref("a")], to: "global" },
        [outcome({ name: "a", reason: "failed" })],
        ctx,
      ),
    ).toBe("Moved 1 skill to Global. “a” moved, but its old folder couldn't be removed.");
    expect(
      describeResult(
        { kind: "delete", skills: [ref("a")] },
        [outcome({ name: "a", reason: "failed" })],
        ctx,
      ),
    ).toBe("Deleted 1 skill. “a” was only partly deleted.");
  });

  it("says why a skill or an agent was skipped, in the person's words", () => {
    expect(
      describeResult(
        { kind: "enable", skills: [ref("a"), ref("b"), ref("c")], agents: [claude.instanceId] },
        [
          outcome({ name: "a" }),
          outcome({
            name: "b",
            status: "skipped",
            blocked: [{ instanceId: claude.instanceId, reason: "entryTaken" }],
          }),
          outcome({ name: "c", status: "skipped", reason: "changed" }),
        ],
        ctx,
      ),
    ).toBe(
      "Turned on 1 skill for Claude. Claude already has a different “b”. “c” changed since the list was read.",
    );
  });

  it("names an agent the page doesn't list by its id, and cuts a long list short", () => {
    const blocked = (name: string, reason: SkillOutcome["blocked"][number]["reason"]) =>
      outcome({
        name,
        status: "skipped",
        blocked: [{ instanceId: "pi" as never, reason }],
      });
    expect(
      describeResult(
        { kind: "enable", skills: [], agents: [] },
        [
          blocked("a", "shadowed"),
          blocked("b", "shadowed"),
          blocked("c", "alwaysOn"),
          blocked("d", "failed"),
          blocked("e", "failed"),
        ],
        ctx,
      ),
    ).toBe(
      "pi loads another “a” first. pi loads another “b” first. pi reads “c” directly, so it stays on. 2 more couldn't be changed.",
    );
  });

  it("says plainly when there was nothing to do", () => {
    const unchanged = [outcome({ name: "a", status: "unchanged" })];
    expect(describeResult({ kind: "enable", skills: [], agents: [] }, unchanged, ctx)).toBe(
      "Already on.",
    );
    expect(describeResult({ kind: "disable", skills: [], agents: [] }, unchanged, ctx)).toBe(
      "Already off.",
    );
    expect(describeResult({ kind: "remove", skills: [] }, unchanged, ctx)).toBe(
      "Nothing to remove.",
    );
    expect(describeResult({ kind: "move", skills: [], to: "global" }, unchanged, ctx)).toBe(
      "Already in Global.",
    );
    expect(describeResult({ kind: "delete", skills: [] }, unchanged, ctx)).toBe(
      "Nothing to delete.",
    );
  });
});
