import type {
  ClaudeInstructionChoice,
  ClaudeInstructionValue,
  InstructionAgentAccess,
  InstructionAgentsResult,
  InstructionEntry,
  InstructionError,
  InstructionListResult,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  joinNames,
  type PlanConfirmation,
  type SkillAgent,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** The first Claude Code version with the "Project instructions" setting. */
const CLAUDE_SETTING_VERSION = "2.1.277";

const GIT_UNDO_NOTE = "You can undo this with git.";
const CANT_UNDO_NOTE = "This can't be undone.";

// -- Reading the list ---------------------------------------------------------------------------

export function ingestInstructions(result: InstructionListResult) {
  const known = new Set<ProviderInstanceId>([
    ...result.entries.flatMap((entry) => entry.access.map((access) => access.instanceId)),
    ...result.claude.map((choice) => choice.instanceId),
  ]);
  return {
    entries: result.entries,
    claude: result.claude,
    sharedPath: result.sharedPath,
    unreadable: result.unreadable,
    known,
  };
}

export type InstructionData = ReturnType<typeof ingestInstructions>;

const agentOf = (ctx: SkillsContext, instanceId: ProviderInstanceId) =>
  ctx.installed.find((agent) => agent.instanceId === instanceId);

const accessFor = (entry: InstructionEntry, agent: Pick<SkillAgent, "instanceId">) =>
  entry.access.find((access) => access.instanceId === agent.instanceId);

/** The agents that appear in the entry's access list, which are the ones it can say anything about. */
const listedAgents = (entry: InstructionEntry, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => accessFor(entry, agent) !== undefined);

const reads = (access: InstructionAgentAccess | undefined) =>
  access !== undefined && access.state !== "none";

const isClaude = (agent: SkillAgent) => agent.driverKind === "claudeAgent";

/** The name of a file, for a search and a note. */
export const entryFileName = (entry: InstructionEntry) =>
  entry.relativePath ?? entry.path.split(/[\\/]/).at(-1) ?? entry.path;

/** The project's own AGENTS.md, which the list calls "This project". */
const isProjectAgentsFile = (entry: InstructionEntry) =>
  entry.scope === "project" &&
  entry.kind === "shared" &&
  (entry.relativePath === undefined || entry.relativePath === "AGENTS.md");

/** The Global file: the one every project and any agent can share. */
const isGlobalFile = (entry: InstructionEntry) =>
  entry.scope === "global" && entry.kind === "shared";

/** The project's CLAUDE.md in its top folder, the one that can become AGENTS.md. */
const isProjectClaudeFile = (entry: InstructionEntry) =>
  entry.scope === "project" &&
  entry.kind === "claude" &&
  (entry.relativePath === undefined || entry.relativePath === "CLAUDE.md");

// -- Who uses a file ----------------------------------------------------------------------------

export type Usage = {
  /** Every agent that can read this kind of file does. */
  everyone: boolean;
  /** Agents that read it. */
  agents: SkillAgent[];
  /** Agents that could but don't. */
  missing: SkillAgent[];
};

export function usage(entry: InstructionEntry, ctx: SkillsContext): Usage {
  const listed = listedAgents(entry, ctx);
  const agents = listed.filter((agent) => reads(accessFor(entry, agent)));
  return {
    everyone: listed.length > 0 && agents.length === listed.length,
    agents,
    missing: listed.filter((agent) => !reads(accessFor(entry, agent))),
  };
}

/** The tooltip on a row's agent icons. */
export const usageNote = (value: Usage) =>
  value.everyone
    ? "Used by all your agents"
    : `Not used by ${joinNames(value.missing.map((agent) => agent.displayName))}`;

// -- Plans --------------------------------------------------------------------------------------

/** What to ask the server for. */
export type InstructionChange =
  | {
      readonly kind: "setClaude";
      readonly instances: readonly ProviderInstanceId[];
      /** Null goes back to Claude's default. */
      readonly value: ClaudeInstructionValue | null;
    }
  | {
      readonly kind: "enable" | "disable";
      readonly id: string;
      readonly agents: readonly ProviderInstanceId[];
    }
  | { readonly kind: "adopt"; readonly id: string; readonly agent: string }
  | { readonly kind: "share"; readonly id: string; readonly project: boolean }
  | {
      readonly kind: "delete";
      readonly id: string;
      readonly name: string;
      readonly project: boolean;
    };

export type InstructionPlan = {
  readonly change: InstructionChange;
  /** Present when the change should be confirmed first. */
  readonly confirmation?: PlanConfirmation;
};

const claudeNames = (instances: readonly ProviderInstanceId[], ctx: SkillsContext) =>
  joinNames(instances.map((id) => agentOf(ctx, id)?.displayName ?? "Claude"));

/** Claude reads AGENTS.md next to its CLAUDE.md files, in every project. */
export function planClaudeAgents(
  instances: readonly ProviderInstanceId[],
  ctx: SkillsContext,
): InstructionPlan {
  const names = claudeNames(instances, ctx);
  return {
    change: { kind: "setClaude", instances, value: "claude-md-and-agents-md" },
    confirmation: {
      title: `Turn on AGENTS.md for ${names}?`,
      body: `${names} will read AGENTS.md in every project, together with your CLAUDE.md files.`,
      notes: [],
      confirm: "Turn on",
      destructive: false,
    },
  };
}

/** Claude stops reading AGENTS.md, in every project. */
function planClaudeNever(
  instances: readonly ProviderInstanceId[],
  ctx: SkillsContext,
): InstructionPlan {
  const names = claudeNames(instances, ctx);
  return {
    change: { kind: "setClaude", instances, value: "claude-md" },
    confirmation: {
      title: `Turn off AGENTS.md for ${names}?`,
      body: `${names} will stop reading AGENTS.md in every project.`,
      notes: [],
      confirm: "Turn off",
      destructive: false,
    },
  };
}

const enablePlan = (
  id: string,
  kind: "enable" | "disable",
  agents: readonly SkillAgent[],
): InstructionPlan => ({
  change: { kind, id, agents: agents.map((agent) => agent.instanceId) },
});

/** An agent's own file moves into Global, and the agent uses that file from then on. */
function planAdopt(entry: InstructionEntry, name: string): InstructionPlan {
  const same = entry.sameAsShared === true;
  return {
    change: { kind: "adopt", id: entry.id, agent: name },
    confirmation: {
      title: `Use your Global instructions for ${name}?`,
      body: same
        ? `${name}'s instructions match your Global instructions, so ${name} just starts using them.`
        : `${name}'s instructions are added to your Global instructions. ${name} then reads them instead.`,
      notes: [],
      confirm: "Use Global instead",
      destructive: false,
    },
  };
}

/** The project's CLAUDE.md becomes AGENTS.md. */
function planShare(entry: InstructionEntry): InstructionPlan {
  return {
    change: { kind: "share", id: entry.id, project: entry.scope === "project" },
    confirmation: {
      title: "Share with all agents?",
      body: "CLAUDE.md becomes AGENTS.md, so every agent reads it.",
      notes: [],
      confirm: "Share",
      destructive: false,
    },
  };
}

/** Taking the Global file away from the agents that read it. The file stays. */
function planRemove(entry: InstructionEntry, agents: readonly SkillAgent[]): InstructionPlan {
  return {
    change: { kind: "disable", id: entry.id, agents: agents.map((agent) => agent.instanceId) },
    confirmation: {
      title: "Stop using your Global instructions?",
      body: `${joinNames(agents.map((agent) => agent.displayName))} will stop reading them. The file isn't deleted.`,
      notes: [],
      confirm: "Remove",
      destructive: true,
    },
  };
}

function planDelete(entry: InstructionEntry, name: string): InstructionPlan {
  return {
    change: {
      kind: "delete",
      id: entry.id,
      name,
      project: entry.scope === "project",
    },
    confirmation: {
      title: `Delete ${name}?`,
      body: `This deletes ${name}.`,
      notes: [CANT_UNDO_NOTE],
      confirm: "Delete",
      destructive: true,
    },
  };
}

/** The project file ids a confirmation should ask git about, or null when it has nothing to ask. */
export function instructionsToCheckWithGit(plan: InstructionPlan): readonly string[] | null {
  const { change } = plan;
  if (plan.confirmation === undefined) return null;
  return (change.kind === "share" || change.kind === "delete") && change.project
    ? [change.id]
    : null;
}

/**
 * The plan with a line saying git can undo it, once the server has said which of its files git
 * tracks. A file git doesn't track keeps its plan as it was.
 */
export function withInstructionGitNote(
  plan: InstructionPlan,
  tracked: readonly string[],
): InstructionPlan {
  const { change, confirmation } = plan;
  if (!confirmation || (change.kind !== "share" && change.kind !== "delete")) return plan;
  if (!tracked.includes(change.id)) return plan;
  return {
    ...plan,
    confirmation: {
      ...confirmation,
      notes: [...confirmation.notes.filter((note) => note !== CANT_UNDO_NOTE), GIT_UNDO_NOTE],
    },
  };
}

// -- Rows ---------------------------------------------------------------------------------------

export type InstructionFix = { readonly label: string; readonly plan: InstructionPlan };

export type InstructionAttention = {
  /** One plain sentence on what is wrong. */
  readonly detail: string;
  readonly fix: InstructionFix | null;
};

export type InstructionRow = {
  readonly id: string;
  readonly entry: InstructionEntry;
  /** The row's title in the list. */
  readonly title: string;
  /** The title of the open file. */
  readonly heading: string;
  /** The line under the title; null when there is nothing to say. */
  readonly subtitle: string | null;
  /** The line under the title of the open file: its file name, or what the heading leaves out. */
  readonly headingNote: string;
  /** The file isn't there yet, and the row offers to create it. */
  readonly missing: boolean;
  /** Clicking the row opens one switch per agent in place; the Global file does once it exists. */
  readonly expandable: boolean;
  readonly attention: InstructionAttention | null;
  /** Where the row sits in the list. */
  readonly rank: number;
};

const SHARED_WITH_TEAM = "Shared with your team";
const PERSONAL_NOTES = "Your own notes for this project";
const NO_INSTRUCTIONS = "No instructions yet";

type Labels = { title: string; heading: string; subtitle: string | null; headingNote?: string };

/** The folder and file name of a file in a subfolder, such as `apps/web` and `AGENTS.md`. */
function splitNested(entry: InstructionEntry) {
  const path = entry.relativePath ?? entryFileName(entry);
  const cut = path.lastIndexOf("/");
  return { folder: cut < 0 ? "" : path.slice(0, cut), file: path.slice(cut + 1) };
}

/** What a file is called, or null for one the list doesn't show. */
function labelsFor(entry: InstructionEntry, ctx: SkillsContext): Labels | null {
  const name = entryFileName(entry);
  const owner = entry.owner === undefined ? undefined : agentOf(ctx, entry.owner);
  const subtitle = entry.exists ? null : NO_INSTRUCTIONS;
  switch (entry.scope) {
    case "managed":
      return {
        title: "Set by your organization",
        heading: "Set by your organization",
        subtitle: "Read-only",
      };
    case "project":
      if (isProjectAgentsFile(entry)) {
        return { title: "This project", heading: "This project", subtitle };
      }
      if (entry.kind === "claudeLocal") {
        return { title: "Just you", heading: "Just you", subtitle: PERSONAL_NOTES };
      }
      if (entry.kind === "nested") {
        const { folder, file } = splitNested(entry);
        return {
          title: folder || file,
          heading: folder || file,
          subtitle: null,
          headingNote: file,
        };
      }
      return { title: name, heading: name, subtitle: SHARED_WITH_TEAM };
    case "global":
      if (entry.kind === "shared") return { title: "Global", heading: "Global", subtitle };
      // An agent's own file belongs to an agent that is installed and enabled.
      if (owner === undefined) return null;
      return entry.kind === "claude"
        ? {
            title: `${owner.displayName}'s own notes`,
            heading: `${owner.displayName}'s own notes`,
            subtitle: null,
          }
        : {
            title: `${owner.displayName}'s own instructions`,
            heading: `${owner.displayName}'s own instructions`,
            subtitle: null,
          };
  }
}

/** Order in the list: the project, then Global, then each agent's own, then the organization. */
function rank(entry: InstructionEntry) {
  if (entry.scope === "project") {
    if (entry.kind === "shared") return 0;
    return entry.kind === "claude" ? 1 : 2;
  }
  if (entry.scope === "global") {
    if (entry.kind === "shared") return 4;
    return entry.kind === "claude" ? 5 : 6;
  }
  return 7;
}

/** The subfolder files sit after the project's own and before Global. */
const SUBFOLDERS_RANK = 3;

/** Agents that don't read the entry and could be switched on, with the reason that blocks them left out. */
function switchableAgents(entry: InstructionEntry, ctx: SkillsContext) {
  return listedAgents(entry, ctx).filter((agent) => {
    const access = accessFor(entry, agent);
    return (
      access?.state === "none" && access.reason !== "ownFile" && access.reason !== "oldVersion"
    );
  });
}

function attentionFor(
  entry: InstructionEntry,
  ctx: SkillsContext,
  entries: readonly InstructionEntry[],
): InstructionAttention | null {
  if (!entry.exists || entry.readOnly) return null;
  if (isProjectAgentsFile(entry)) {
    const skipped = listedAgents(entry, ctx).filter(
      (agent) => isClaude(agent) && accessFor(entry, agent)?.reason === "claudeFiles",
    );
    if (skipped.length === 0) return null;
    const files = [
      ...new Set(skipped.map((agent) => accessFor(entry, agent)?.blockingFile ?? "CLAUDE.md")),
    ];
    const names = joinNames(skipped.map((agent) => agent.displayName));
    return {
      detail: `${names} ${skipped.length === 1 ? "skips" : "skip"} it because of ${joinNames(files)}`,
      fix: {
        label: `Turn on for ${skipped.length === 1 ? skipped[0]!.displayName : "Claude"}`,
        plan: planClaudeAgents(
          skipped.map((agent) => agent.instanceId),
          ctx,
        ),
      },
    };
  }
  if (isGlobalFile(entry)) {
    const missing = switchableAgents(entry, ctx);
    if (missing.length === 0) return null;
    return {
      detail: `Not used by ${joinNames(missing.map((agent) => agent.displayName))}`,
      fix: {
        label:
          missing.length === 1
            ? `Turn on for ${missing[0]!.displayName}`
            : "Turn on for all agents",
        plan: enablePlan(entry.id, "enable", missing),
      },
    };
  }
  if (entry.scope === "global" && entry.kind === "agentOwn" && entry.sameAsShared !== true) {
    const owner = entry.owner === undefined ? undefined : agentOf(ctx, entry.owner);
    if (!owner) return null;
    return {
      detail: "Not using your Global instructions",
      fix: { label: "Use Global instead", plan: planAdopt(entry, owner.displayName) },
    };
  }
  if (isProjectClaudeFile(entry) && !hasProjectAgentsFile(entries)) {
    const missing = usage(entry, ctx).missing;
    if (missing.length === 0) return null;
    return {
      detail: `Not used by ${joinNames(missing.map((agent) => agent.displayName))}`,
      fix: { label: "Share with all agents", plan: planShare(entry) },
    };
  }
  return null;
}

const hasProjectAgentsFile = (entries: readonly InstructionEntry[]) =>
  entries.some((entry) => isProjectAgentsFile(entry) && entry.exists);

function buildRow(
  entry: InstructionEntry,
  ctx: SkillsContext,
  entries: readonly InstructionEntry[],
): InstructionRow | null {
  const labels = labelsFor(entry, ctx);
  if (!labels) return null;
  const { headingNote, ...text } = labels;
  const fileName = entryFileName(entry);
  return {
    id: entry.id,
    entry,
    ...text,
    // A heading that is the file's name has said it; the note says who shares it instead.
    headingNote: headingNote ?? (text.heading === fileName ? (text.subtitle ?? "") : fileName),
    missing: !entry.exists,
    expandable: isGlobalFile(entry) && entry.exists,
    attention: attentionFor(entry, ctx, entries),
    rank: rank(entry),
  };
}

/**
 * The files the Instructions section lists: the ones that exist, plus a missing project AGENTS.md,
 * CLAUDE.local.md and Global file, so there is something to create. Subfolder files are listed
 * together in `nestedFiles`.
 */
export function instructionRows(
  data: Pick<InstructionData, "entries">,
  ctx: SkillsContext,
): InstructionRow[] {
  return data.entries
    .filter(
      (entry) =>
        entry.kind !== "nested" &&
        (entry.exists || entry.kind === "shared" || entry.kind === "claudeLocal"),
    )
    .map((entry, index) => ({ row: buildRow(entry, ctx, data.entries), index }))
    .flatMap((item) => (item.row ? [{ ...item, row: item.row }] : []))
    .sort((a, b) => a.row.rank - b.row.rank || a.index - b.index)
    .map(({ row }) => row);
}

/** One file by id, to open it. A subfolder file is found here too. */
export function findInstructionRow(
  data: Pick<InstructionData, "entries">,
  ctx: SkillsContext,
  id: string,
): InstructionRow | null {
  const entry = data.entries.find((candidate) => candidate.id === id);
  return entry ? buildRow(entry, ctx, data.entries) : null;
}

// -- Claude's choice ----------------------------------------------------------------------------

export type ClaudeOption = {
  readonly value: ClaudeInstructionValue;
  readonly label: string;
  readonly hint?: string;
};

export const CLAUDE_OPTIONS: readonly ClaudeOption[] = [
  { value: "claude-md-or-agents-md", label: "When there's no CLAUDE.md", hint: "Claude's default" },
  { value: "claude-md-and-agents-md", label: "Alongside any CLAUDE.md" },
  { value: "claude-md", label: "Never" },
];

const CLAUDE_DEFAULT: ClaudeInstructionValue = "claude-md-or-agents-md";

export type ClaudeRow = {
  readonly instanceId: ProviderInstanceId;
  readonly agent: SkillAgent;
  readonly choice: ClaudeInstructionChoice;
  readonly title: string;
  /** A line under the title on why the choice can't be changed; null when it can. */
  readonly note: string | null;
  readonly control:
    | {
        readonly kind: "select";
        readonly value: ClaudeInstructionValue;
        readonly label: string;
        readonly disabled: boolean;
      }
    | { readonly kind: "text"; readonly text: string };
};

/** One row per enabled Claude instance that is installed. With several, each is named. */
export function claudeRows(
  choices: readonly ClaudeInstructionChoice[],
  ctx: SkillsContext,
): ClaudeRow[] {
  const shown = choices.flatMap((choice) => {
    const agent = agentOf(ctx, choice.instanceId);
    return agent ? [{ choice, agent }] : [];
  });
  return shown.map(({ choice, agent }): ClaudeRow => {
    const managed = choice.value === "managed-only";
    return {
      instanceId: choice.instanceId,
      agent,
      choice,
      title: `${shown.length > 1 ? agent.displayName : "Claude"} reads AGENTS.md`,
      note:
        !choice.supported && !managed
          ? `Needs Claude Code ${CLAUDE_SETTING_VERSION} or later`
          : null,
      control: managed
        ? { kind: "text", text: "Organization only" }
        : {
            kind: "select",
            value: choice.value,
            label: CLAUDE_OPTIONS.find((option) => option.value === choice.value)?.label ?? "",
            disabled: !choice.supported,
          },
    };
  });
}

/**
 * What picking an option asks for. Claude's default is stored as no value at all, so picking it
 * removes the setting; picking what already applies asks for nothing.
 */
export function claudeChange(
  choice: Pick<ClaudeInstructionChoice, "instanceId" | "value" | "explicit">,
  picked: ClaudeInstructionValue,
): InstructionChange | null {
  if (picked === CLAUDE_DEFAULT) {
    return choice.explicit
      ? { kind: "setClaude", instances: [choice.instanceId], value: null }
      : null;
  }
  return picked === choice.value
    ? null
    : { kind: "setClaude", instances: [choice.instanceId], value: picked };
}

// -- Subfolders ---------------------------------------------------------------------------------

export type NestedFile = { readonly id: string; readonly folder: string; readonly file: string };

/** The AGENTS.md and CLAUDE.md files in the project's subfolders, by folder. */
export function nestedFiles(entries: readonly InstructionEntry[]): NestedFile[] {
  return entries
    .filter((entry) => entry.kind === "nested" && entry.exists)
    .map((entry) => ({ id: entry.id, ...splitNested(entry) }))
    .sort(
      (a, b) =>
        a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: "base" }) ||
        a.file.localeCompare(b.file),
    );
}

// -- An open file -------------------------------------------------------------------------------

export type InstructionChip = {
  readonly agent: SkillAgent;
  readonly on: boolean;
  /** The agent can't be switched here. */
  readonly locked: boolean;
  /** What a click does; null when it does nothing. */
  readonly plan: InstructionPlan | null;
  /** The tooltip, one line each. */
  readonly lines: readonly string[];
};

function claudeSettingChip(
  agent: SkillAgent,
  access: InstructionAgentAccess,
  choice: ClaudeInstructionChoice | undefined,
  ctx: SkillsContext,
): InstructionChip {
  const name = agent.displayName;
  const instances = [agent.instanceId];
  if (access.state === "import") {
    return {
      agent,
      on: true,
      locked: true,
      plan: null,
      lines: [`${name} reads it through an import in its CLAUDE.md.`],
    };
  }
  if (choice?.value === "managed-only") {
    return {
      agent,
      on: access.state !== "none",
      locked: true,
      plan: null,
      lines: ["Your organization decides this."],
    };
  }
  if (access.state === "setting") {
    return {
      agent,
      on: true,
      locked: false,
      plan: planClaudeNever(instances, ctx),
      lines: [`${name} reads it in every project.`],
    };
  }
  if (access.reason === "oldVersion") {
    return {
      agent,
      on: false,
      locked: true,
      plan: null,
      lines: [`Needs Claude Code ${CLAUDE_SETTING_VERSION} or later.`],
    };
  }
  return {
    agent,
    on: false,
    locked: false,
    plan: planClaudeAgents(instances, ctx),
    lines: [
      access.reason === "claudeFiles"
        ? `${name} skips it because of ${access.blockingFile ?? "CLAUDE.md"}.`
        : `${name} doesn't read AGENTS.md.`,
    ],
  };
}

/** The agents under "Used by", each with what clicking it does. */
export function instructionChips(
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionChip[] {
  return listedAgents(entry, ctx).map((agent): InstructionChip => {
    const access = accessFor(entry, agent)!;
    const name = agent.displayName;
    if (access.state === "direct") {
      return {
        agent,
        on: true,
        locked: true,
        plan: null,
        lines: ["Always on. It reads this file directly."],
      };
    }
    if (isProjectAgentsFile(entry) && isClaude(agent)) {
      return claudeSettingChip(
        agent,
        access,
        data.claude.find((choice) => choice.instanceId === agent.instanceId),
        ctx,
      );
    }
    const on = access.state !== "none";
    if (isGlobalFile(entry) && !entry.readOnly) {
      if (on) {
        return {
          agent,
          on,
          locked: false,
          plan: enablePlan(entry.id, "disable", [agent]),
          lines: [
            access.state === "import"
              ? `${name} imports this file from its own CLAUDE.md.`
              : `${name} reads a link to this file.`,
          ],
        };
      }
      if (access.reason === "ownFile") {
        const own = data.entries.find(
          (other) =>
            other.scope === "global" &&
            other.kind === "agentOwn" &&
            other.exists &&
            other.owner === agent.instanceId,
        );
        return {
          agent,
          on,
          locked: own === undefined,
          plan: own ? planAdopt(own, name) : null,
          lines: [`${name} has its own instructions.`],
        };
      }
      if (access.reason === "oldVersion") {
        return { agent, on, locked: true, plan: null, lines: [`${name} is too old to read it.`] };
      }
      return {
        agent,
        on,
        locked: false,
        plan: enablePlan(entry.id, "enable", [agent]),
        lines: [`${name} doesn't use this file.`],
      };
    }
    return {
      agent,
      on,
      locked: true,
      plan: null,
      lines: [on ? `${name} reads this file.` : `${name} doesn't read this file.`],
    };
  });
}

export type InstructionActions = {
  readonly turnOnAll: InstructionPlan | null;
  readonly removeFromAgents: InstructionPlan | null;
  readonly share: InstructionPlan | null;
  readonly useGlobal: InstructionPlan | null;
  readonly remove: InstructionPlan | null;
};

/** What a delete calls the file: its own name, unless the row's title already is one. */
const deleteName = (row: InstructionRow) =>
  row.entry.kind === "claudeLocal" || row.entry.kind === "nested"
    ? entryFileName(row.entry)
    : row.title;

/** What the ⋯ menu of an open file can do. */
export function instructionActions(
  row: InstructionRow,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries">,
): InstructionActions {
  const { entry } = row;
  const editable = entry.exists && !entry.readOnly;
  const isGlobal = isGlobalFile(entry);
  const turnOn = isGlobal && editable ? switchableAgents(entry, ctx) : [];
  const linked =
    isGlobal && editable
      ? listedAgents(entry, ctx).filter((agent) => {
          const state = accessFor(entry, agent)?.state;
          return state === "link" || state === "import";
        })
      : [];
  const owner = entry.owner === undefined ? undefined : agentOf(ctx, entry.owner);
  return {
    turnOnAll: turnOn.length > 0 ? enablePlan(entry.id, "enable", turnOn) : null,
    removeFromAgents: linked.length > 0 ? planRemove(entry, linked) : null,
    share:
      editable && isProjectClaudeFile(entry) && !hasProjectAgentsFile(data.entries)
        ? planShare(entry)
        : null,
    useGlobal:
      editable && entry.scope === "global" && entry.kind === "agentOwn" && owner
        ? planAdopt(entry, owner.displayName)
        : null,
    remove:
      editable && entry.kind !== "shared" && entry.kind !== "managed"
        ? planDelete(entry, deleteName(row))
        : null,
  };
}

// -- Search and the list ------------------------------------------------------------------------

/** A file matches by its title and its file name, such as "agents.md". */
export const matchesInstructionQuery = (row: InstructionRow, needle: string) =>
  `${row.title} ${entryFileName(row.entry)}`.toLowerCase().includes(needle);

export const matchesClaudeQuery = (row: ClaudeRow, needle: string) =>
  `${row.title} ${row.agent.displayName} claude agents.md`.toLowerCase().includes(needle);

const matchesNestedQuery = (file: NestedFile, needle: string) =>
  `${file.folder}/${file.file}`.toLowerCase().includes(needle);

/** Files that need a look, whatever the search and filter show. */
export const instructionAttentionCount = (
  data: Pick<InstructionData, "entries">,
  ctx: SkillsContext,
) => instructionRows(data, ctx).filter((row) => row.attention !== null).length;

/** What the Instructions card shows, in order. */
export type InstructionItem =
  | { readonly kind: "file"; readonly row: InstructionRow }
  | { readonly kind: "subfolders"; readonly files: readonly NestedFile[] }
  | { readonly kind: "claude"; readonly row: ClaudeRow };

/**
 * The card's items for a search and the Needs attention filter: the files, with the subfolder
 * files folded into one item after the project's own, then Claude's choice. A search narrows the
 * subfolder files too; the filter leaves out what can't need attention.
 */
export function instructionItems(
  data: Pick<InstructionData, "entries" | "claude">,
  ctx: SkillsContext,
  view: { readonly needle: string; readonly onlyAttention: boolean },
): InstructionItem[] {
  const { needle, onlyAttention } = view;
  const rows = instructionRows(data, ctx).filter(
    (row) => (!onlyAttention || row.attention !== null) && matchesInstructionQuery(row, needle),
  );
  const subfolders = onlyAttention
    ? []
    : nestedFiles(data.entries).filter((file) => needle === "" || matchesNestedQuery(file, needle));
  const claude = onlyAttention
    ? []
    : claudeRows(data.claude, ctx).filter((row) => matchesClaudeQuery(row, needle));
  const before = rows.filter((row) => row.rank < SUBFOLDERS_RANK);
  const after = rows.filter((row) => row.rank >= SUBFOLDERS_RANK);
  return [
    ...before.map((row): InstructionItem => ({ kind: "file", row })),
    ...(subfolders.length > 0 ? [{ kind: "subfolders" as const, files: subfolders }] : []),
    ...after.map((row): InstructionItem => ({ kind: "file", row })),
    ...claude.map((row): InstructionItem => ({ kind: "claude", row })),
  ];
}

// -- Saying what happened -----------------------------------------------------------------------

/** One short line on the files the server couldn't read, which would otherwise look empty. */
export function instructionUnreadableNote(files: InstructionListResult["unreadable"]) {
  const [first, second, ...rest] = files.map((item) => item.path);
  if (first === undefined) return "";
  if (second === undefined) return `Couldn't read ${first}`;
  return rest.length === 0
    ? `Couldn't read ${first} and ${second}`
    : `Couldn't read ${first}, ${second} and ${rest.length} more`;
}

type Reason = InstructionError["reason"];

/** The reason the server gave for refusing, or null for any other failure. */
export function instructionErrorReason(error: unknown): Reason | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, reason } = error as { _tag?: unknown; reason?: unknown };
  return _tag === "InstructionError" && typeof reason === "string" ? (reason as Reason) : null;
}

/** The file changed under an edit, so saving would overwrite someone else's work. */
export const isSaveConflict = (reason: Reason | null) =>
  reason === "changedOnDisk" || reason === "exists";

const REASON_TEXT: Record<Reason, string> = {
  changedOnDisk: "That file changed since the list was read.",
  exists: "A file with that name is already there.",
  notFound: "That file isn't there any more.",
  readOnly: "That file is read-only.",
  tooLarge: "That file is too large.",
  unknownEntry: "That file isn't in the list any more.",
  unregisteredProject: "This project isn't set up in T3 Code.",
  invalidSettings: "Claude's settings file isn't valid JSON, so T3 Code left it alone.",
  linkFailed: "Couldn't make the link. On Windows, turn on Developer Mode.",
};

export const CHANGE_FAILED = "Couldn't change the instructions here.";

export const failureText = (reason: Reason | null) =>
  reason === null ? CHANGE_FAILED : REASON_TEXT[reason];

/** One status line on what a change did to the agents, from what the server says happened. */
export function describeAgentsResult(
  kind: "enable" | "disable",
  results: InstructionAgentsResult["results"],
  ctx: SkillsContext,
) {
  const nameOf = (id: ProviderInstanceId) => agentOf(ctx, id)?.displayName ?? id;
  const changed = results.filter((result) => result.outcome === "changed");
  const failed = results.filter((result) => result.outcome === "failed");
  const lead =
    changed.length === 0
      ? ""
      : `${kind === "enable" ? "Turned on" : "Turned off"} for ${joinNames(changed.map((result) => nameOf(result.instanceId)))}.`;
  const problems = failed.map((result) =>
    result.reason
      ? `Couldn't change ${nameOf(result.instanceId)}: ${result.reason}`
      : `Couldn't change ${nameOf(result.instanceId)}.`,
  );
  if (lead === "" && problems.length === 0) {
    return kind === "enable" ? "Already on." : "Already off.";
  }
  return [lead, ...problems].filter((part) => part !== "").join(" ");
}

/** One status line for a change that has no per-agent outcome. */
export function describeChange(change: InstructionChange, ctx: SkillsContext) {
  switch (change.kind) {
    case "setClaude": {
      const names = claudeNames(change.instances, ctx);
      const many = change.instances.length > 1;
      if (change.value === "claude-md-and-agents-md") {
        return `${names} now ${many ? "read" : "reads"} AGENTS.md in every project.`;
      }
      if (change.value === "claude-md") {
        return `${names} no longer ${many ? "read" : "reads"} AGENTS.md.`;
      }
      return `${names} ${many ? "follow" : "follows"} ${many ? "their" : "its"} default again.`;
    }
    case "adopt":
      return `${change.agent} now uses your Global instructions.`;
    case "share":
      return "CLAUDE.md is now AGENTS.md.";
    case "delete":
      return `Deleted ${change.name}.`;
    case "enable":
    case "disable":
      return "";
  }
}
