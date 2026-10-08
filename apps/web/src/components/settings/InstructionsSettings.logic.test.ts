import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type {
  ClaudeInstructionChoice,
  InstructionAgentAccess,
  InstructionEntry,
  InstructionListResult,
} from "@t3tools/contracts";

import {
  claudeChange,
  claudeRows,
  describeAgentsResult,
  describeChange,
  failureText,
  findInstructionRow,
  ingestInstructions,
  instructionActions,
  instructionChips,
  instructionErrorReason,
  instructionAttentionCount,
  instructionItems,
  instructionRows,
  instructionsToCheckWithGit,
  instructionUnreadableNote,
  isSaveConflict,
  matchesClaudeQuery,
  matchesInstructionQuery,
  nestedFiles,
  planClaudeAgents,
  usage,
  usageNote,
  withInstructionGitNote,
  type InstructionData,
} from "./InstructionsSettings.logic";
import type { SkillAgent } from "./SkillsSettings.logic";

const agent = (instanceId: string, driver: string, displayName: string): SkillAgent => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName,
  accentColor: undefined,
});
const claude = agent("claudeAgent", "claudeAgent", "Claude");
const claudeWork = agent("claude_work", "claudeAgent", "Claude Work");
const codex = agent("codex", "codex", "Codex");
const pi = agent("pi", "pi", "Pi");
const ALL = [claude, codex, pi];
const ctx = { installed: ALL };

type Reach = Partial<
  Record<string, Pick<InstructionAgentAccess, "state" | "reason" | "blockingFile">>
>;

/** An entry the way the server reports it; `reach` says how each listed agent gets to it. */
function entry(
  id: string,
  over: Partial<InstructionEntry> = {},
  reach: Reach = {},
  agents: readonly SkillAgent[] = [...ALL, claudeWork],
): InstructionEntry {
  return {
    id,
    scope: "project",
    kind: "shared",
    path: `/home/user/acme-web/${id}`,
    exists: true,
    size: 120,
    readOnly: false,
    access: agents.map((item) => ({
      instanceId: item.instanceId,
      driver: item.driverKind,
      state: "none",
      ...reach[item.instanceId],
    })),
    ...over,
  };
}

const projectAgents = (reach: Reach = {}, over: Partial<InstructionEntry> = {}) =>
  entry(
    "project:shared:AGENTS.md",
    { relativePath: "AGENTS.md", ...over },
    { codex: { state: "direct" }, pi: { state: "direct" }, ...reach },
  );
const projectClaude = (name: string, reach: Reach = { claudeAgent: { state: "direct" } }) => {
  const kind = name === "CLAUDE.local.md" ? "claudeLocal" : "claude";
  return entry(`project:${kind}:${name}`, { kind, relativePath: name }, reach, [claude, codex, pi]);
};
const sharedFile = (reach: Reach = {}, over: Partial<InstructionEntry> = {}) =>
  entry("global:shared", { scope: "global", path: "/home/user/.agents/AGENTS.md", ...over }, reach);
const ownFile = (instanceId: string, over: Partial<InstructionEntry> = {}) =>
  entry(
    `global:agentOwn:${instanceId}`,
    {
      scope: "global",
      kind: "agentOwn",
      owner: ProviderInstanceId.make(instanceId),
      path: `/home/user/.${instanceId}/AGENTS.md`,
      ...over,
    },
    { [instanceId]: { state: "direct" } },
  );

const choice = (
  instanceId: string,
  over: Partial<ClaudeInstructionChoice> = {},
): ClaudeInstructionChoice => ({
  instanceId: ProviderInstanceId.make(instanceId),
  value: "claude-md-or-agents-md",
  explicit: false,
  supported: true,
  version: "2.1.291",
  ...over,
});

const data = (
  entries: InstructionEntry[],
  claudeChoices: ClaudeInstructionChoice[] = [choice("claudeAgent")],
): InstructionData =>
  ingestInstructions({
    entries,
    claude: claudeChoices,
    sharedPath: "/home/user/.agents/AGENTS.md",
    unreadable: [],
  } satisfies InstructionListResult);

const rowsFor = (entries: InstructionEntry[], context = ctx) =>
  instructionRows(data(entries), context);

describe("ingestInstructions", () => {
  it("lists every instance the server mentions, in an entry or in Claude's choices", () => {
    const { known } = ingestInstructions({
      entries: [projectAgents()],
      claude: [choice("claude_extra")],
      sharedPath: "/home/user/.agents/AGENTS.md",
      unreadable: [],
    });
    expect([...known].toSorted()).toEqual([
      "claudeAgent",
      "claude_extra",
      "claude_work",
      "codex",
      "pi",
    ]);
  });
});

describe("the rows", () => {
  const managed = () =>
    entry("managed:claude", { scope: "managed", kind: "managed", readOnly: true });

  it("names each kind of file, and says only what the title leaves out", () => {
    const rows = rowsFor([
      projectAgents(),
      projectClaude("CLAUDE.md"),
      projectClaude(".claude/CLAUDE.md"),
      projectClaude("CLAUDE.local.md", { claudeAgent: { state: "direct" } }),
      sharedFile(),
      ownFile("codex"),
      managed(),
    ]);
    expect(rows.map((row) => [row.title, row.subtitle])).toEqual([
      ["This project", null],
      ["CLAUDE.md", "Shared with your team"],
      [".claude/CLAUDE.md", "Shared with your team"],
      ["Just you", "Your own notes for this project"],
      ["Global", null],
      ["Codex's own instructions", null],
      ["Set by your organization", "Read-only"],
    ]);
  });

  it("gives the open file the same heading, and its file name under it", () => {
    const rows = rowsFor([
      projectAgents(),
      projectClaude("CLAUDE.md"),
      projectClaude("CLAUDE.local.md"),
      sharedFile(),
    ]);
    expect(rows.map((row) => [row.heading, row.headingNote])).toEqual([
      ["This project", "AGENTS.md"],
      ["CLAUDE.md", "Shared with your team"],
      ["Just you", "CLAUDE.local.md"],
      ["Global", "AGENTS.md"],
    ]);
  });

  it("puts a missing project file, CLAUDE.local.md and Global file up for creating", () => {
    const local = { ...projectClaude("CLAUDE.local.md"), exists: false, size: 0 };
    const rows = rowsFor([
      projectAgents({}, { exists: false, size: 0 }),
      local,
      sharedFile({}, { exists: false, size: 0 }),
    ]);
    expect(rows.map((row) => [row.title, row.subtitle, row.missing])).toEqual([
      ["This project", "No instructions yet", true],
      ["Just you", "Your own notes for this project", true],
      ["Global", "No instructions yet", true],
    ]);
  });

  it("leaves out every other file that isn't there, and the subfolder files", () => {
    expect(
      rowsFor([
        projectClaude("CLAUDE.md"),
        entry("project:nested:apps/web/AGENTS.md", {
          kind: "nested",
          relativePath: "apps/web/AGENTS.md",
        }),
        { ...projectClaude(".claude/CLAUDE.md"), exists: false },
        { ...ownFile("codex"), exists: false },
      ]).map((row) => row.title),
    ).toEqual(["CLAUDE.md"]);
  });

  it("puts the project first, then Global, then each agent's own, then the organization", () => {
    const rows = rowsFor([
      managed(),
      ownFile("pi"),
      entry("global:claude:claudeAgent", {
        scope: "global",
        kind: "claude",
        owner: ProviderInstanceId.make("claudeAgent"),
      }),
      sharedFile(),
      projectClaude("CLAUDE.local.md"),
      projectClaude("CLAUDE.md"),
      projectAgents(),
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      "This project",
      "CLAUDE.md",
      "Just you",
      "Global",
      "Claude's own notes",
      "Pi's own instructions",
      "Set by your organization",
    ]);
  });

  it("names the instance when an agent has more than one", () => {
    const withTwo = { installed: [claude, claudeWork] };
    const own = (instanceId: string) =>
      entry(`global:claude:${instanceId}`, {
        scope: "global",
        kind: "claude",
        owner: ProviderInstanceId.make(instanceId),
      });
    expect(rowsFor([own("claudeAgent"), own("claude_work")], withTwo).map((r) => r.title)).toEqual([
      "Claude's own notes",
      "Claude Work's own notes",
    ]);
  });

  it("leaves out an agent's own file when that agent isn't installed", () => {
    expect(rowsFor([ownFile("codex")], { installed: [claude] })).toEqual([]);
  });

  it("opens a subfolder file by its folder, with the file name under it", () => {
    const nested = entry("project:nested:apps/web/AGENTS.md", {
      kind: "nested",
      relativePath: "apps/web/AGENTS.md",
    });
    const all = data([projectAgents(), nested]);
    expect(findInstructionRow(all, ctx, nested.id)).toMatchObject({
      title: "apps/web",
      heading: "apps/web",
      headingNote: "AGENTS.md",
      subtitle: null,
    });
    expect(findInstructionRow(all, ctx, "gone")).toBeNull();
  });

  it("expands only the Global file, and only once it exists", () => {
    const rows = rowsFor([projectAgents(), projectClaude("CLAUDE.local.md"), sharedFile()]);
    expect(rows.map((row) => [row.title, row.expandable])).toEqual([
      ["This project", false],
      ["Just you", false],
      ["Global", true],
    ]);
    expect(rowsFor([sharedFile({}, { exists: false })])[0]!.expandable).toBe(false);
  });
});

describe("the card's items", () => {
  const nested = (path: string) =>
    entry(`project:nested:${path}`, { kind: "nested", relativePath: path });
  const entries = [
    projectAgents(),
    projectClaude("CLAUDE.local.md"),
    nested("packages/api/CLAUDE.md"),
    nested("apps/web/AGENTS.md"),
    sharedFile(),
    ownFile("codex"),
  ];
  const labels = (view: { needle: string; onlyAttention: boolean }) =>
    instructionItems(data(entries), ctx, view).map((item) =>
      item.kind === "file"
        ? item.row.title
        : item.kind === "claude"
          ? item.row.title
          : `${item.files.length} in subfolders`,
    );

  it("folds the subfolder files into one item between the project's files and Global", () => {
    expect(labels({ needle: "", onlyAttention: false })).toEqual([
      "This project",
      "Just you",
      "2 in subfolders",
      "Global",
      "Codex's own instructions",
      "Claude reads AGENTS.md",
    ]);
  });

  it("narrows a search to the subfolder files that match", () => {
    expect(labels({ needle: "apps/web", onlyAttention: false })).toEqual(["1 in subfolders"]);
    expect(labels({ needle: "agents.md", onlyAttention: false })).toEqual([
      "This project",
      "1 in subfolders",
      "Global",
      "Codex's own instructions",
      "Claude reads AGENTS.md",
    ]);
    expect(labels({ needle: "tdd", onlyAttention: false })).toEqual([]);
  });

  it("keeps only what needs attention under that filter", () => {
    // Codex's own file isn't using Global, and the Global file isn't used by Claude, Codex or Pi.
    expect(labels({ needle: "", onlyAttention: true })).toEqual([
      "Global",
      "Codex's own instructions",
    ]);
    expect(instructionAttentionCount(data(entries), ctx)).toBe(2);
  });

  it("lists the files alone without a project", () => {
    expect(
      instructionItems(data([sharedFile()], []), ctx, { needle: "", onlyAttention: false }).map(
        (item) => item.kind,
      ),
    ).toEqual(["file"]);
  });
});

describe("who uses a file", () => {
  it("shows one mark when every installed agent the file lists reads it", () => {
    const value = usage(
      sharedFile({
        claudeAgent: { state: "import" },
        codex: { state: "link" },
        pi: { state: "link" },
      }),
      ctx,
    );
    expect(value).toMatchObject({ everyone: true, missing: [] });
    expect(usageNote(value)).toBe("Used by all your agents");
  });

  it("names the agents that don't, and ignores agents the file doesn't list", () => {
    const value = usage(projectClaude("CLAUDE.md"), ctx);
    expect(value.agents).toEqual([claude]);
    expect(value.missing).toEqual([codex, pi]);
    expect(usageNote(value)).toBe("Not used by Codex and Pi");
    expect(usage(entry("x", {}, {}, [claude]), { installed: [codex] })).toEqual({
      everyone: false,
      agents: [],
      missing: [],
    });
  });
});

describe("what needs attention", () => {
  it("says when Claude skips AGENTS.md because of another file, and offers to turn it on", () => {
    const [row] = rowsFor([
      projectAgents({
        claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
      }),
    ]);
    expect(row!.attention).toMatchObject({
      detail: "Claude skips it because of CLAUDE.local.md",
      fix: { label: "Turn on for Claude" },
    });
    expect(row!.attention!.fix!.plan).toEqual({
      change: {
        kind: "setClaude",
        instances: ["claudeAgent"],
        value: "claude-md-and-agents-md",
      },
      confirmation: {
        title: "Turn on AGENTS.md for Claude?",
        body: "Claude will read AGENTS.md in every project, together with your CLAUDE.md files.",
        notes: [],
        confirm: "Turn on",
        destructive: false,
      },
    });
  });

  it("names each Claude instance that skips it, and every file in the way", () => {
    const [row] = rowsFor(
      [
        projectAgents({
          claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.md" },
          claude_work: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
        }),
      ],
      { installed: [claude, claudeWork, codex, pi] },
    );
    expect(row!.attention!.detail).toBe(
      "Claude and Claude Work skip it because of CLAUDE.md and CLAUDE.local.md",
    );
    expect(row!.attention!.fix!.label).toBe("Turn on for Claude");
    expect(row!.attention!.fix!.plan.change).toMatchObject({
      instances: ["claudeAgent", "claude_work"],
    });
  });

  it("names a single Claude instance by its own name", () => {
    const [row] = rowsFor(
      [
        projectAgents({
          claude_work: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.md" },
        }),
      ],
      { installed: [claudeWork, codex, pi] },
    );
    expect(row!.attention!.fix!.label).toBe("Turn on for Claude Work");
    expect(row!.attention!.fix!.plan.confirmation!.title).toBe(
      "Turn on AGENTS.md for Claude Work?",
    );
  });

  it("leaves AGENTS.md alone when Claude reads it, or the person chose not to", () => {
    const reading = { claudeAgent: { state: "setting" as const } };
    expect(rowsFor([projectAgents(reading)])[0]!.attention).toBeNull();
    const never = { claudeAgent: { state: "none" as const, reason: "settingOff" as const } };
    expect(rowsFor([projectAgents(never)])[0]!.attention).toBeNull();
    const old = { claudeAgent: { state: "none" as const, reason: "oldVersion" as const } };
    expect(rowsFor([projectAgents(old)])[0]!.attention).toBeNull();
  });

  it("says which agents don't use Global, and offers to turn it on", () => {
    const [row] = rowsFor([
      sharedFile({ claudeAgent: { state: "import" }, codex: { state: "link" } }),
    ]);
    expect(row!.attention).toMatchObject({
      detail: "Not used by Pi",
      fix: { label: "Turn on for Pi" },
    });
    expect(row!.attention!.fix!.plan).toEqual({
      change: { kind: "enable", id: "global:shared", agents: ["pi"] },
    });
  });

  it("turns on for all agents when several lack Global", () => {
    const [row] = rowsFor([sharedFile({ claudeAgent: { state: "import" } })]);
    expect(row!.attention).toMatchObject({
      detail: "Not used by Codex and Pi",
      fix: { label: "Turn on for all agents" },
    });
  });

  it("doesn't blame an agent that keeps its own file, or one that is too old", () => {
    const reach: Reach = {
      claudeAgent: { state: "import" },
      codex: { state: "none", reason: "ownFile" },
      pi: { state: "none", reason: "oldVersion" },
    };
    expect(rowsFor([sharedFile(reach)])[0]!.attention).toBeNull();
  });

  it("offers a missing Global file nothing to fix", () => {
    expect(rowsFor([sharedFile({}, { exists: false })])[0]!.attention).toBeNull();
  });

  it("offers an agent's own file Global, and says its text is added", () => {
    const [row] = rowsFor([ownFile("codex")]);
    expect(row!.attention).toMatchObject({
      detail: "Not using your Global instructions",
      fix: { label: "Use Global instead" },
    });
    expect(row!.attention!.fix!.plan).toEqual({
      change: { kind: "adopt", id: "global:agentOwn:codex", agent: "Codex" },
      confirmation: {
        title: "Use Global for Codex?",
        body: "Codex's instructions are added to Global. Codex then reads that file instead.",
        notes: [],
        confirm: "Use Global instead",
        destructive: false,
      },
    });
  });

  it("doesn't flag an agent's own file that has Global's text already", () => {
    expect(rowsFor([ownFile("codex", { sameAsShared: true })])[0]!.attention).toBeNull();
  });

  it("offers to share a CLAUDE.md that no AGENTS.md sits beside", () => {
    const rows = rowsFor([
      projectAgents({}, { exists: false }),
      projectClaude("CLAUDE.md"),
      projectClaude(".claude/CLAUDE.md"),
    ]);
    const claudeMd = rows.find((row) => row.title === "CLAUDE.md");
    expect(claudeMd!.attention).toMatchObject({
      detail: "Not used by Codex and Pi",
      fix: { label: "Share with all agents" },
    });
    expect(claudeMd!.attention!.fix!.plan).toEqual({
      change: { kind: "share", id: "project:claude:CLAUDE.md", project: true },
      confirmation: {
        title: "Share with all agents?",
        body: "CLAUDE.md becomes AGENTS.md, so every agent reads it.",
        notes: [],
        confirm: "Share",
        destructive: false,
      },
    });
    // Only the one in the top folder can be renamed.
    expect(rows.find((row) => row.title === ".claude/CLAUDE.md")!.attention).toBeNull();
  });

  it("leaves CLAUDE.md alone when AGENTS.md exists, or when every agent reads it already", () => {
    expect(rowsFor([projectAgents(), projectClaude("CLAUDE.md")])[1]!.attention).toBeNull();
    const everyone = entry(
      "project:claude:CLAUDE.md",
      { kind: "claude", relativePath: "CLAUDE.md" },
      { claudeAgent: { state: "direct" }, codex: { state: "direct" }, pi: { state: "direct" } },
    );
    expect(rowsFor([projectAgents({}, { exists: false }), everyone])[1]!.attention).toBeNull();
  });

  it("never flags a file the person can't change", () => {
    const managed = entry("managed:claude", { scope: "managed", kind: "managed", readOnly: true });
    expect(rowsFor([managed])[0]!.attention).toBeNull();
  });
});

describe("Claude's choice", () => {
  it("has one row per installed Claude, named only when there are several", () => {
    const one = claudeRows([choice("claudeAgent")], ctx);
    expect(one.map((row) => row.title)).toEqual(["Claude reads AGENTS.md"]);
    const two = claudeRows([choice("claudeAgent"), choice("claude_work")], {
      installed: [claude, claudeWork],
    });
    expect(two.map((row) => row.title)).toEqual([
      "Claude reads AGENTS.md",
      "Claude Work reads AGENTS.md",
    ]);
    expect(claudeRows([choice("gone")], ctx)).toEqual([]);
  });

  it("shows what applies now, whether the person chose it or it is the default", () => {
    const [row] = claudeRows([choice("claudeAgent", { value: "claude-md-and-agents-md" })], ctx);
    expect(row!.control).toEqual({
      kind: "select",
      value: "claude-md-and-agents-md",
      label: "Alongside any CLAUDE.md",
      disabled: false,
    });
    expect(claudeRows([choice("claudeAgent")], ctx)[0]!.control).toMatchObject({
      label: "When there's no CLAUDE.md",
    });
    expect(
      claudeRows([choice("claudeAgent", { value: "claude-md" })], ctx)[0]!.control,
    ).toMatchObject({ label: "Never" });
  });

  it("says plainly when the organization decides", () => {
    const [row] = claudeRows([choice("claudeAgent", { value: "managed-only" })], ctx);
    expect(row!.control).toEqual({ kind: "text", text: "Organization only" });
    expect(row!.note).toBeNull();
  });

  it("disables the choice and says why when Claude is too old", () => {
    const [row] = claudeRows([choice("claudeAgent", { supported: false, version: "2.0.1" })], ctx);
    expect(row!.control).toMatchObject({ kind: "select", disabled: true });
    expect(row!.note).toBe("Needs Claude Code 2.1.277 or later");
    expect(claudeRows([choice("claudeAgent")], ctx)[0]!.note).toBeNull();
  });

  it("stores the default as no value, and asks for nothing when nothing changes", () => {
    const base = { instanceId: ProviderInstanceId.make("claudeAgent") };
    expect(
      claudeChange({ ...base, value: "claude-md", explicit: true }, "claude-md-or-agents-md"),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: null });
    expect(
      claudeChange(
        { ...base, value: "claude-md-or-agents-md", explicit: false },
        "claude-md-or-agents-md",
      ),
    ).toBeNull();
    expect(
      claudeChange(
        { ...base, value: "claude-md-or-agents-md", explicit: true },
        "claude-md-or-agents-md",
      ),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: null });
    expect(
      claudeChange({ ...base, value: "claude-md-or-agents-md", explicit: false }, "claude-md"),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: "claude-md" });
    expect(claudeChange({ ...base, value: "claude-md", explicit: true }, "claude-md")).toBeNull();
  });
});

describe("subfolder files", () => {
  it("lists the folders in order, with the file in each", () => {
    const nested = (path: string) =>
      entry(`project:nested:${path}`, { kind: "nested", relativePath: path });
    expect(
      nestedFiles([
        nested("packages/api/CLAUDE.md"),
        nested("apps/web/AGENTS.md"),
        nested("apps/10/AGENTS.md"),
        nested("apps/2/AGENTS.md"),
        { ...nested("apps/gone/AGENTS.md"), exists: false },
        projectAgents(),
      ]).map((item) => [item.folder, item.file]),
    ).toEqual([
      ["apps/2", "AGENTS.md"],
      ["apps/10", "AGENTS.md"],
      ["apps/web", "AGENTS.md"],
      ["packages/api", "CLAUDE.md"],
    ]);
  });
});

describe("the agents under Used by", () => {
  const chipsFor = (
    item: InstructionEntry,
    extra: InstructionEntry[] = [],
    choices = [choice("claudeAgent")],
  ) => instructionChips(item, ctx, data([item, ...extra], choices));

  it("locks an agent that reads the file where it is", () => {
    const chip = chipsFor(projectAgents()).find((item) => item.agent.instanceId === "codex")!;
    expect(chip).toMatchObject({ on: true, locked: true, plan: null });
    expect(chip.lines).toEqual(["Always on. It reads this file directly."]);
  });

  it("switches an agent on or off for Global", () => {
    const shared = sharedFile({
      claudeAgent: { state: "import" },
      codex: { state: "link" },
      pi: { state: "none" },
    });
    const byAgent = Object.fromEntries(
      chipsFor(shared).map((chip) => [chip.agent.instanceId, chip]),
    );
    expect(byAgent.codex).toMatchObject({
      on: true,
      locked: false,
      plan: { change: { kind: "disable", id: "global:shared", agents: ["codex"] } },
    });
    expect(byAgent.claudeAgent!.lines).toEqual([
      "Claude imports this file from its own CLAUDE.md.",
    ]);
    expect(byAgent.pi).toMatchObject({
      on: false,
      locked: false,
      plan: { change: { kind: "enable", id: "global:shared", agents: ["pi"] } },
    });
  });

  it("asks before switching on an agent that keeps its own file, and uses its file to do it", () => {
    const shared = sharedFile({ codex: { state: "none", reason: "ownFile" } });
    const own = ownFile("codex");
    const chip = chipsFor(shared, [own]).find((item) => item.agent.instanceId === "codex")!;
    expect(chip.locked).toBe(false);
    expect(chip.plan).toMatchObject({
      change: { kind: "adopt", id: "global:agentOwn:codex", agent: "Codex" },
      confirmation: { title: "Use Global for Codex?" },
    });
    // With no file of its own to find, there is nothing to switch.
    expect(chipsFor(shared).find((item) => item.agent.instanceId === "codex")).toMatchObject({
      locked: true,
      plan: null,
    });
  });

  it("locks an agent that is too old for Global", () => {
    const shared = sharedFile({ pi: { state: "none", reason: "oldVersion" } });
    expect(chipsFor(shared).find((item) => item.agent.instanceId === "pi")).toMatchObject({
      locked: true,
      plan: null,
    });
  });

  it("turns Claude's chip on AGENTS.md into the same confirmed choice as the fix", () => {
    const skipped = projectAgents({
      claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
    });
    const chip = chipsFor(skipped).find((item) => item.agent.instanceId === "claudeAgent")!;
    expect(chip).toMatchObject({ on: false, locked: false });
    expect(chip.plan).toEqual(planClaudeAgents([ProviderInstanceId.make("claudeAgent")], ctx));
    expect(chip.lines).toEqual(["Claude skips it because of CLAUDE.local.md."]);
  });

  it("asks before turning Claude off for AGENTS.md in every project", () => {
    const reading = projectAgents({ claudeAgent: { state: "setting" } });
    const chip = chipsFor(reading).find((item) => item.agent.instanceId === "claudeAgent")!;
    expect(chip).toMatchObject({ on: true, locked: false });
    expect(chip.plan).toMatchObject({
      change: { kind: "setClaude", instances: ["claudeAgent"], value: "claude-md" },
      confirmation: {
        title: "Turn off AGENTS.md for Claude?",
        body: "Claude will stop reading AGENTS.md in every project.",
        confirm: "Turn off",
      },
    });
  });

  it("locks Claude's chip when an import, the organization or an old version decides", () => {
    const imported = projectAgents({ claudeAgent: { state: "import" } });
    expect(chipsFor(imported).find((c) => c.agent.instanceId === "claudeAgent")).toMatchObject({
      on: true,
      locked: true,
    });
    const managed = projectAgents({ claudeAgent: { state: "none" } });
    expect(
      chipsFor(managed, [], [choice("claudeAgent", { value: "managed-only" })]).find(
        (c) => c.agent.instanceId === "claudeAgent",
      ),
    ).toMatchObject({ locked: true, lines: ["Your organization decides this."] });
    const old = projectAgents({ claudeAgent: { state: "none", reason: "oldVersion" } });
    expect(chipsFor(old).find((c) => c.agent.instanceId === "claudeAgent")).toMatchObject({
      locked: true,
      lines: ["Needs Claude Code 2.1.277 or later."],
    });
  });

  it("only shows who reads any other file", () => {
    const chips = chipsFor(projectClaude("CLAUDE.md"));
    expect(chips.map((chip) => [chip.agent.displayName, chip.on, chip.locked])).toEqual([
      ["Claude", true, true],
      ["Codex", false, true],
      ["Pi", false, true],
    ]);
  });
});

describe("the ⋯ menu", () => {
  const actionsFor = (entries: InstructionEntry[], index: number, context = ctx) => {
    const all = data(entries);
    const row = instructionRows(all, context).find((item) => item.entry === entries[index])!;
    return instructionActions(row, context, all);
  };

  it("turns Global on for the agents that lack it and can take it", () => {
    const shared = sharedFile({
      claudeAgent: { state: "import" },
      codex: { state: "none", reason: "ownFile" },
      pi: { state: "none" },
    });
    expect(actionsFor([shared], 0).turnOnAll).toEqual({
      change: { kind: "enable", id: "global:shared", agents: ["pi"] },
    });
  });

  it("removes Global from the agents that read it, and says the file stays", () => {
    const shared = sharedFile({ claudeAgent: { state: "import" }, codex: { state: "link" } });
    expect(actionsFor([shared], 0).removeFromAgents).toEqual({
      change: { kind: "disable", id: "global:shared", agents: ["claudeAgent", "codex"] },
      confirmation: {
        title: "Remove Global from your agents?",
        body: "Claude and Codex will stop using Global. The file isn't deleted.",
        notes: [],
        confirm: "Remove",
        destructive: true,
      },
    });
    expect(actionsFor([sharedFile()], 0).removeFromAgents).toBeNull();
  });

  it("shares a CLAUDE.md only when there is no AGENTS.md", () => {
    const claudeMd = projectClaude("CLAUDE.md");
    expect(actionsFor([projectAgents({}, { exists: false }), claudeMd], 1).share).not.toBeNull();
    expect(actionsFor([projectAgents(), claudeMd], 1).share).toBeNull();
    expect(
      actionsFor([projectAgents({}, { exists: false }), projectClaude(".claude/CLAUDE.md")], 1)
        .share,
    ).toBeNull();
  });

  it("uses Global for an agent's own, whatever its text", () => {
    const own = ownFile("codex", { sameAsShared: true });
    expect(actionsFor([own], 0).useGlobal).toMatchObject({
      change: { kind: "adopt", agent: "Codex" },
      confirmation: {
        body: "Codex's instructions match Global, so Codex just starts using that file.",
      },
    });
  });

  it("deletes real files other than the AGENTS.md ones, and names the file", () => {
    expect(actionsFor([projectClaude("CLAUDE.md")], 0).remove).toEqual({
      change: { kind: "delete", id: "project:claude:CLAUDE.md", name: "CLAUDE.md", project: true },
      confirmation: {
        title: "Delete CLAUDE.md?",
        body: "This deletes CLAUDE.md.",
        notes: ["This can't be undone."],
        confirm: "Delete",
        destructive: true,
      },
    });
    expect(actionsFor([ownFile("codex")], 0).remove).toMatchObject({
      change: { kind: "delete", name: "Codex's own instructions", project: false },
    });
    // The title "Just you" says nothing about which file goes.
    expect(actionsFor([projectClaude("CLAUDE.local.md")], 0).remove).toMatchObject({
      change: { kind: "delete", name: "CLAUDE.local.md", project: true },
      confirmation: { title: "Delete CLAUDE.local.md?" },
    });
    expect(actionsFor([projectAgents()], 0).remove).toBeNull();
    expect(actionsFor([sharedFile()], 0).remove).toBeNull();
    const managed = entry("managed:claude", { scope: "managed", kind: "managed", readOnly: true });
    const none = actionsFor([managed], 0);
    expect(Object.values(none).every((plan) => plan === null)).toBe(true);
  });

  it("offers nothing to change on a file that isn't there yet", () => {
    const missing = projectAgents({}, { exists: false });
    expect(Object.values(actionsFor([missing], 0)).every((plan) => plan === null)).toBe(true);
  });
});

describe("asking git", () => {
  const share = planClaudeAgents([ProviderInstanceId.make("claudeAgent")], ctx);
  const delPlan = instructionActions(
    rowsFor([projectClaude("CLAUDE.md")])[0]!,
    ctx,
    data([projectClaude("CLAUDE.md")]),
  ).remove!;

  it("checks the project file a rename or a delete is about to touch, and nothing else", () => {
    expect(instructionsToCheckWithGit(delPlan)).toEqual(["project:claude:CLAUDE.md"]);
    const sharePlan = instructionActions(
      rowsFor([projectAgents({}, { exists: false }), projectClaude("CLAUDE.md")])[1]!,
      ctx,
      data([projectAgents({}, { exists: false }), projectClaude("CLAUDE.md")]),
    ).share!;
    expect(instructionsToCheckWithGit(sharePlan)).toEqual(["project:claude:CLAUDE.md"]);
    expect(instructionsToCheckWithGit(share)).toBeNull();
    const global = instructionActions(
      rowsFor([ownFile("codex")])[0]!,
      ctx,
      data([ownFile("codex")]),
    ).remove!;
    expect(instructionsToCheckWithGit(global)).toBeNull();
  });

  it("says git can undo it only for a file git tracks, replacing the line that says it can't", () => {
    expect(withInstructionGitNote(delPlan, []).confirmation!.notes).toEqual([
      "This can't be undone.",
    ]);
    expect(withInstructionGitNote(delPlan, ["other"]).confirmation!.notes).toEqual([
      "This can't be undone.",
    ]);
    expect(
      withInstructionGitNote(delPlan, ["project:claude:CLAUDE.md"]).confirmation!.notes,
    ).toEqual(["You can undo this with git."]);
  });

  it("adds the line to a rename too", () => {
    const sharePlan = instructionActions(
      rowsFor([projectAgents({}, { exists: false }), projectClaude("CLAUDE.md")])[1]!,
      ctx,
      data([projectAgents({}, { exists: false }), projectClaude("CLAUDE.md")]),
    ).share!;
    expect(
      withInstructionGitNote(sharePlan, ["project:claude:CLAUDE.md"]).confirmation!.notes,
    ).toEqual(["You can undo this with git."]);
  });
});

describe("search", () => {
  const rows = rowsFor([
    projectAgents(),
    sharedFile(),
    projectClaude("CLAUDE.md"),
    projectClaude("CLAUDE.local.md"),
  ]);
  const [project, claudeMd, local, shared] = rows;

  it("matches a row by its title and by its file name", () => {
    expect(matchesInstructionQuery(project!, "this project")).toBe(true);
    expect(matchesInstructionQuery(project!, "agents.md")).toBe(true);
    expect(matchesInstructionQuery(shared!, "global")).toBe(true);
    expect(matchesInstructionQuery(claudeMd!, "claude.md")).toBe(true);
    expect(matchesInstructionQuery(claudeMd!, "agents.md")).toBe(false);
    expect(matchesInstructionQuery(local!, "just you")).toBe(true);
    expect(matchesInstructionQuery(local!, "claude.local.md")).toBe(true);
    expect(matchesInstructionQuery(project!, "")).toBe(true);
  });

  it("matches Claude's choice by the words on its row", () => {
    const [row] = claudeRows([choice("claudeAgent")], ctx);
    expect(matchesClaudeQuery(row!, "agents.md")).toBe(true);
    expect(matchesClaudeQuery(row!, "claude")).toBe(true);
    expect(matchesClaudeQuery(row!, "tdd")).toBe(false);
  });
});

describe("saying what happened", () => {
  it("reads the reason from the server's error, and nothing else", () => {
    expect(instructionErrorReason({ _tag: "InstructionError", reason: "changedOnDisk" })).toBe(
      "changedOnDisk",
    );
    expect(instructionErrorReason({ _tag: "SomethingElse", reason: "changedOnDisk" })).toBeNull();
    expect(instructionErrorReason(new Error("boom"))).toBeNull();
    expect(instructionErrorReason(null)).toBeNull();
    expect(instructionErrorReason("changedOnDisk")).toBeNull();
  });

  it("treats a file that changed, or appeared, as the person's call, not a failure", () => {
    expect(isSaveConflict("changedOnDisk")).toBe(true);
    expect(isSaveConflict("exists")).toBe(true);
    expect(isSaveConflict("readOnly")).toBe(false);
    expect(isSaveConflict(null)).toBe(false);
  });

  it("words each reason the server can give", () => {
    expect(failureText(null)).toBe("Couldn't change the instructions here.");
    expect(failureText("invalidSettings")).toBe(
      "Claude's settings file isn't valid JSON, so T3 Code left it alone.",
    );
    expect(failureText("linkFailed")).toBe(
      "Couldn't make the link. On Windows, turn on Developer Mode.",
    );
  });

  it("says who was turned on or off, and who couldn't be", () => {
    const result = (outcome: "changed" | "unchanged" | "failed", id: string, reason?: string) => ({
      instanceId: ProviderInstanceId.make(id),
      outcome,
      ...(reason ? { reason } : {}),
    });
    expect(
      describeAgentsResult("enable", [result("changed", "codex"), result("changed", "pi")], ctx),
    ).toBe("Turned on for Codex and Pi.");
    expect(describeAgentsResult("disable", [result("changed", "codex")], ctx)).toBe(
      "Turned off for Codex.",
    );
    expect(
      describeAgentsResult(
        "enable",
        [result("changed", "codex"), result("failed", "pi", "It keeps its own file.")],
        ctx,
      ),
    ).toBe("Turned on for Codex. Couldn't change Pi: It keeps its own file.");
    expect(describeAgentsResult("enable", [result("failed", "pi")], ctx)).toBe(
      "Couldn't change Pi.",
    );
    expect(describeAgentsResult("enable", [result("unchanged", "pi")], ctx)).toBe("Already on.");
    expect(describeAgentsResult("disable", [], ctx)).toBe("Already off.");
  });

  it("says what the other changes did", () => {
    const id = ProviderInstanceId.make("claudeAgent");
    expect(
      describeChange({ kind: "setClaude", instances: [id], value: "claude-md-and-agents-md" }, ctx),
    ).toBe("Claude now reads AGENTS.md in every project.");
    expect(describeChange({ kind: "setClaude", instances: [id], value: "claude-md" }, ctx)).toBe(
      "Claude no longer reads AGENTS.md.",
    );
    expect(describeChange({ kind: "setClaude", instances: [id], value: null }, ctx)).toBe(
      "Claude follows its default again.",
    );
    expect(describeChange({ kind: "adopt", id: "x", agent: "Codex" }, ctx)).toBe(
      "Codex now uses Global.",
    );
    expect(describeChange({ kind: "share", id: "x", project: true }, ctx)).toBe(
      "CLAUDE.md is now AGENTS.md.",
    );
    expect(describeChange({ kind: "delete", id: "x", name: "CLAUDE.md", project: true }, ctx)).toBe(
      "Deleted CLAUDE.md.",
    );
  });

  it("names the files that couldn't be read, briefly", () => {
    const files = (...paths: string[]) => paths.map((path) => ({ path }));
    expect(instructionUnreadableNote([])).toBe("");
    expect(instructionUnreadableNote(files("/a/AGENTS.md"))).toBe("Couldn't read /a/AGENTS.md");
    expect(instructionUnreadableNote(files("/a", "/b"))).toBe("Couldn't read /a and /b");
    expect(instructionUnreadableNote(files("/a", "/b", "/c", "/d"))).toBe(
      "Couldn't read /a, /b and 2 more",
    );
  });
});
