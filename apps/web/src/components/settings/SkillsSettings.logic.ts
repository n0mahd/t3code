import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  SkillAgentAccess,
  SkillListResult,
  SkillOutcome,
  SkillOutcomeReason,
  SkillRef,
  SkillScope,
  SkillSummary,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";

/** An enabled provider instance, named and drawn the way the rest of the app does. */
export type SkillAgent = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "displayName" | "accentColor"
>;

const joinNames = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export type Skill = SkillSummary & {
  /** Stable across reads, so an open skill survives a refresh. */
  readonly id: string;
};

export type SkillsContext = {
  /** Provider instances that are installed, enabled and known to the server's folder table. */
  readonly installed: readonly SkillAgent[];
};

/**
 * The environment the page reads skills from. The settings scope names it, connected or not: an
 * offline environment is reported as offline, never swapped for another one, whose skills would
 * be shown as the project's and which would be sent the project's folder. Only a scope that names
 * no environment falls back to the primary one, then the first.
 */
export function skillsEnvironment<T extends { readonly environmentId: EnvironmentId }>(input: {
  /** The scope's connected environment, when it has one. */
  readonly connected: T | null;
  readonly scopeEnvironmentIds: readonly EnvironmentId[];
  readonly environments: readonly T[];
  readonly primaryId: EnvironmentId | null;
}): T | undefined {
  if (input.connected) return input.connected;
  if (input.scopeEnvironmentIds.length > 0) {
    return input.environments.find((item) =>
      input.scopeEnvironmentIds.includes(item.environmentId),
    );
  }
  return (
    input.environments.find((item) => item.environmentId === input.primaryId) ??
    input.environments[0]
  );
}

export function ingestSkills(result: SkillListResult) {
  const skills = result.skills.map((entry): Skill => ({
    ...entry,
    id: `${entry.scope}\0${entry.name}\0${entry.home}`,
  }));
  const known = new Set(skills.flatMap((skill) => skill.access.map((access) => access.instanceId)));
  return { skills, unreadable: result.unreadable, known };
}

export function installedAgents(
  providers: readonly ServerProvider[],
  known: ReadonlySet<ProviderInstanceId>,
): SkillAgent[] {
  return deriveProviderInstanceEntries(providers)
    .filter(
      (entry) =>
        known.has(entry.instanceId) && entry.installed && entry.enabled && entry.isAvailable,
    )
    .map(({ instanceId, driverKind, displayName, accentColor }) => ({
      instanceId,
      driverKind,
      displayName,
      accentColor,
    }));
}

// -- Access -----------------------------------------------------------------------------------

export const accessOf = (
  skill: Skill,
  agent: Pick<SkillAgent, "instanceId">,
): SkillAgentAccess | undefined =>
  skill.access.find((access) => access.instanceId === agent.instanceId);

const hasAccess = (skill: Skill, agent: SkillAgent) => {
  const state = accessOf(skill, agent)?.state;
  return state === "direct" || state === "link";
};

/** Where the agent reads the skill from, or the folder it looks in when it can't see it. */
export const agentSkillPath = (skill: Skill, agent: SkillAgent) => {
  const access = accessOf(skill, agent);
  if (!access) return null;
  return hasAccess(skill, agent) ? `${access.folder}/${skill.name}` : access.folder;
};

/** Installed agents that don't load this copy of the skill. */
const missingAgents = (skill: Skill, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => !hasAccess(skill, agent));

// -- Attention --------------------------------------------------------------------------------

type Attention = {
  /** A conflict gets a badge on its row; the others only show in the list filter and the skill. */
  kind: "conflict" | "header" | "missing";
  detail: string;
};

const scopeName = (scope: SkillScope) => (scope === "global" ? "Global" : "This project");

/** One plain sentence on what is wrong, or null for a healthy skill. */
export function attention(skill: Skill, ctx: SkillsContext): Attention | null {
  const other = skill.copies.find((copy) => !copy.same);
  if (other) {
    const detail =
      other.scope !== skill.scope
        ? `${scopeName(other.scope)} has a different “${skill.name}”.`
        : skill.scope === "global"
          ? `Another global “${skill.name}” is different.`
          : `Another “${skill.name}” in this project is different.`;
    return { kind: "conflict", detail };
  }
  const claude = ctx.installed.filter((agent) => agent.driverKind === "claudeAgent");
  if (skill.invalidHeader && claude.length > 0) {
    return {
      kind: "header",
      detail: `${joinNames(claude.map((agent) => agent.displayName))} can't read this skill's header.`,
    };
  }
  const missing = missingAgents(skill, ctx);
  return missing.length === 0
    ? null
    : {
        kind: "missing",
        detail: `Not available to ${joinNames(missing.map((agent) => agent.displayName))}`,
      };
}

/** Who can use a skill, among the installed agents. */
type Availability = {
  /** Every installed agent can use it. */
  everyone: boolean;
  agents: SkillAgent[];
  /** Installed agents that can't. */
  missing: SkillAgent[];
};

export function availability(skill: Skill, ctx: SkillsContext): Availability {
  const missing = missingAgents(skill, ctx);
  return {
    everyone: ctx.installed.length > 0 && missing.length === 0,
    agents: ctx.installed.filter((agent) => hasAccess(skill, agent)),
    missing,
  };
}

/** The tooltip on a row's agent icons. */
export const availabilityNote = (value: Availability) =>
  value.everyone
    ? "Available to all your agents"
    : `Not available to ${joinNames(value.missing.map((agent) => agent.displayName))}`;

/** One short line on the folders the server couldn't read, which would otherwise look empty. */
export function unreadableNote(folders: SkillListResult["unreadable"]) {
  const [first, second, ...rest] = folders.map((item) => item.folder);
  if (first === undefined) return "";
  if (second === undefined) return `Couldn't read ${first}`;
  return rest.length === 0
    ? `Couldn't read ${first} and ${second}`
    : `Couldn't read ${first}, ${second} and ${rest.length} more`;
}

// -- Turning skills on and off ------------------------------------------------------------------

/** What to ask the server for. */
export type SkillChange =
  | {
      readonly kind: "enable" | "disable";
      readonly skills: readonly SkillRef[];
      readonly agents: readonly ProviderInstanceId[];
    }
  | { readonly kind: "remove"; readonly skills: readonly SkillRef[] }
  | { readonly kind: "move"; readonly skills: readonly SkillRef[]; readonly to: SkillScope }
  | { readonly kind: "delete"; readonly skills: readonly SkillRef[] };

export type SkillPlan = {
  readonly change: SkillChange;
  /** How many skills it changes. */
  readonly affected: number;
  /** Present when the change should be confirmed first, in plain words. */
  readonly confirmation?: {
    readonly title: string;
    readonly body: string;
    /** Lines under the body, such as what stays on and why. */
    readonly notes: readonly string[];
    readonly confirm: string;
    readonly destructive: boolean;
  };
};

const skillRef = (skill: Skill): SkillRef => ({
  scope: skill.scope,
  name: skill.name,
  home: skill.home,
});

const enablePlan = (skills: readonly Skill[], agents: readonly SkillAgent[]): SkillPlan => ({
  change: {
    kind: "enable",
    skills: skills.map(skillRef),
    agents: agents.map((agent) => agent.instanceId),
  },
  affected: skills.length,
});

/** Why an agent's switch can't be flipped, or null when it can. */
export function switchBlocker(skill: Skill, agent: SkillAgent) {
  return accessOf(skill, agent)?.state === "direct"
    ? "Always on. It reads this folder directly."
    : null;
}

/** Turning one agent on for one skill, or off. Off asks first when other agents lose it too. */
export function planToggle(skill: Skill, agent: SkillAgent, ctx: SkillsContext) {
  return hasAccess(skill, agent) ? planTurnOff([skill], agent, ctx) : enablePlan([skill], [agent]);
}

/** Every installed agent that lacks one of the skills gets a link; nothing asks first. */
export function planTurnOnAll(selected: readonly Skill[], ctx: SkillsContext): SkillPlan | null {
  const targets = selected.filter((skill) => missingAgents(skill, ctx).length > 0);
  if (targets.length === 0) return null;
  const agents = ctx.installed.filter((agent) => targets.some((skill) => !hasAccess(skill, agent)));
  return enablePlan(targets, agents);
}

/** Other installed agents that lose the skill when this agent's link goes: same folder, same link. */
function alsoLosesOnTurnOff(skill: Skill, agent: SkillAgent, ctx: SkillsContext) {
  const target = accessOf(skill, agent);
  if (target?.state !== "link") return [];
  return ctx.installed.filter((other) => {
    const access = accessOf(skill, other);
    return (
      other.instanceId !== agent.instanceId &&
      access?.state === "link" &&
      access.folder === target.folder
    );
  });
}

/** Turning one agent off for the skills it uses through a link. Others stay on. */
export function planTurnOff(
  selected: readonly Skill[],
  agent: SkillAgent,
  ctx: SkillsContext,
): SkillPlan | null {
  const targets = selected.filter((skill) => accessOf(skill, agent)?.state === "link");
  const stuck = selected.filter((skill) => accessOf(skill, agent)?.state === "direct");
  if (targets.length === 0 && stuck.length === 0) return null;
  const alsoLose = new Map(
    targets
      .flatMap((skill) => alsoLosesOnTurnOff(skill, agent, ctx))
      .map((other) => [other.instanceId, other] as const),
  );
  const notes: string[] = [];
  if (alsoLose.size > 0) {
    notes.push(
      `${joinNames([...alsoLose.values()].map((other) => other.displayName))} ${alsoLose.size === 1 ? "loses" : "lose"} ${targets.length === 1 ? "it" : "these"} too.`,
    );
  }
  if (stuck.length > 0) {
    notes.push(
      `${plural(stuck.length, "skill")} ${stuck.length === 1 ? "stays" : "stay"} on because ${agent.displayName} reads ${stuck.length === 1 ? "its" : "their"} folder.`,
    );
  }
  return {
    change: {
      kind: "disable",
      skills: targets.map(skillRef),
      agents: [agent.instanceId],
    },
    affected: targets.length,
    ...(notes.length > 0 && targets.length > 0
      ? {
          confirmation: {
            title: `Turn off for ${agent.displayName}?`,
            body: `Removes ${agent.displayName}'s link for ${plural(targets.length, "skill")}.`,
            notes,
            confirm: "Turn off",
            destructive: false,
          },
        }
      : {}),
  };
}

/** Agents that read the skill through a link, not from the skill's own folder. */
const readsThroughLink = (skill: Skill) =>
  skill.access.filter(
    (access) => access.state !== "none" && `${access.folder}/${skill.name}` !== skill.home,
  );

/** Removing every link to the skills. The skills' own folders stay, so some agents may keep them. */
export function planRemove(selected: readonly Skill[], ctx: SkillsContext): SkillPlan | null {
  const targets = selected.filter((skill) => readsThroughLink(skill).length > 0);
  if (targets.length === 0) return null;
  const change: SkillChange = { kind: "remove", skills: targets.map(skillRef) };
  const notes: string[] = [];
  const idle = selected.length - targets.length;
  if (idle > 0) {
    notes.push(
      `${plural(idle, "skill")} ${idle === 1 ? "is" : "are"} only in ${idle === 1 ? "its" : "their"} own folder, so nothing changes there.`,
    );
  }
  if (targets.length === 1) {
    const skill = targets[0]!;
    const linked = new Set(readsThroughLink(skill).map((access) => access.instanceId));
    const losing = ctx.installed.filter((agent) => linked.has(agent.instanceId));
    const keeping = ctx.installed.filter(
      (agent) => hasAccess(skill, agent) && !linked.has(agent.instanceId),
    );
    if (keeping.length > 0) {
      notes.push(
        `${joinNames(keeping.map((agent) => agent.displayName))} still ${keeping.length === 1 ? "uses" : "use"} it from its own folder.`,
      );
    }
    return {
      change,
      affected: 1,
      confirmation: {
        title: `Remove ${skill.name} from your agents?`,
        body: `${joinNames(losing.map((agent) => agent.displayName)) || "No agent"} will stop using it; the original in ${skill.home} isn't deleted.`,
        notes,
        confirm: "Remove",
        destructive: true,
      },
    };
  }
  return {
    change,
    affected: targets.length,
    confirmation: {
      title: `Remove ${targets.length} skills from your agents?`,
      body: "Agents will stop using them; the originals aren't deleted.",
      notes,
      confirm: "Remove",
      destructive: true,
    },
  };
}

// -- Moving and deleting ----------------------------------------------------------------------

/** Whether the skill's own folder is in an agent's skill folder, which is what can move or go. */
const hasOwnFolder = (skill: Skill) => skill.realFolder === true;

const destinationName = (to: SkillScope) => (to === "global" ? "Global" : "this project");

const quoted = (skills: readonly Skill[]) => skills.map((skill) => `“${skill.name}”`);

/** The skill names a note lists, cut short so a long selection stays one line. */
const someNames = (skills: readonly Skill[], shown = 4) =>
  skills.length <= shown
    ? joinNames(quoted(skills))
    : `${quoted(skills.slice(0, shown)).join(", ")} and ${skills.length - shown} more`;

/** Skills that stay because they are reached through a link, not kept in an agent's folder. */
const linkedNote = (kept: readonly Skill[], afterwards = "") =>
  kept.length === 0
    ? []
    : [
        `${plural(kept.length, "skill")} ${kept.length === 1 ? "is" : "are"} reached through a link, so ${kept.length === 1 ? "it stays" : "they stay"}.${afterwards}`,
      ];

/**
 * Moving skills between This project and Global. It always asks first, since it changes who
 * sees the skills. The agents that used a skill keep using it; the server links them again.
 */
export function planMove(selected: readonly Skill[], to: SkillScope): SkillPlan | null {
  const coming = selected.filter((skill) => skill.scope !== to);
  const targets = coming.filter(hasOwnFolder);
  if (targets.length === 0) return null;
  const them = targets.length === 1 ? "it" : "them";
  const notes = [
    `Agents that use ${them} keep using ${them}.`,
    ...linkedNote(coming.filter((skill) => !hasOwnFolder(skill))),
  ];
  return {
    change: { kind: "move", skills: targets.map(skillRef), to },
    affected: targets.length,
    confirmation: {
      title: `Move ${targets.length === 1 ? `“${targets[0]!.name}”` : plural(targets.length, "skill")} to ${destinationName(to)}?`,
      body:
        to === "global"
          ? "Moves to your Global skills, for all your projects."
          : "Moves into this project, so anyone who clones it gets it.",
      notes,
      confirm: "Move",
      destructive: false,
    },
  };
}

/**
 * Deleting the skills' own folders and the links that lead to them. This is not Remove: Remove
 * only takes the links away and leaves the original, and a skill that is only linked here, such
 * as one from a synced library, can't be deleted from this page at all.
 */
export function planDelete(selected: readonly Skill[], ctx: SkillsContext): SkillPlan | null {
  const targets = selected.filter(hasOwnFolder);
  if (targets.length === 0) return null;
  const kept = selected.filter((skill) => !hasOwnFolder(skill));
  const notes: string[] = [];
  if (targets.length === 1) {
    const losing = ctx.installed.filter((agent) => hasAccess(targets[0]!, agent));
    if (losing.length > 0) {
      notes.push(`${joinNames(losing.map((agent) => agent.displayName))} will stop using it.`);
    }
  } else {
    notes.push(`${someNames(targets)}.`);
  }
  notes.push(
    ...linkedNote(
      kept,
      ` Remove takes ${kept.length === 1 ? "it" : "them"} away from your agents.`,
    ),
  );
  return {
    change: { kind: "delete", skills: targets.map(skillRef) },
    affected: targets.length,
    confirmation: {
      title:
        targets.length === 1 ? `Delete ${targets[0]!.name}?` : `Delete ${targets.length} skills?`,
      body:
        targets.length === 1
          ? `This deletes ${targets[0]!.home} and any links to it. It can't be undone.`
          : `This deletes ${plural(targets.length, "folder")} and any links to them. It can't be undone.`,
      notes,
      confirm: "Delete",
      destructive: true,
    },
  };
}

/**
 * The project skills a confirmation should ask git about: those a delete removes or a move out of
 * a project takes. A move into a project makes new files, so there is nothing in git to undo.
 * Null when the plan has nothing to ask about.
 */
export function skillsToCheckWithGit(plan: SkillPlan): readonly SkillRef[] | null {
  const { change } = plan;
  if (plan.confirmation === undefined) return null;
  if (change.kind !== "delete" && !(change.kind === "move" && change.to === "global")) return null;
  const skills = change.skills.filter((skill) => skill.scope === "project");
  return skills.length === 0 ? null : skills;
}

/**
 * The plan with a line saying git can undo it, once the server has said which project skills it
 * tracks. A plan nothing is tracked for is returned as it was.
 */
export function withGitNote(plan: SkillPlan, tracked: readonly string[]): SkillPlan {
  if (plan.confirmation === undefined) return plan;
  const { skills } = plan.change;
  const names = new Set(tracked);
  const count = skills.filter((skill) => skill.scope === "project" && names.has(skill.name)).length;
  if (count === 0) return plan;
  const note =
    count === skills.length
      ? "You can undo this with git."
      : `${count} of these ${count === 1 ? "is" : "are"} tracked by git, so you can undo ${count === 1 ? "that one" : "those"} with git.`;
  return {
    ...plan,
    confirmation: { ...plan.confirmation, notes: [...plan.confirmation.notes, note] },
  };
}

/** A one-click fix for a skill that installed agents can't use yet. */
export function planFix(skill: Skill, ctx: SkillsContext) {
  const missing = missingAgents(skill, ctx);
  if (missing.length === 0) return null;
  return {
    label:
      missing.length === 1 ? `Turn on for ${missing[0]!.displayName}` : "Turn on for all agents",
    plan: enablePlan([skill], missing),
  };
}

const problemText = (
  reason: SkillOutcomeReason,
  name: string,
  who: string | undefined,
  /** Where a move was going, to say who is in the way. */
  to?: SkillScope,
) => {
  switch (reason) {
    case "notFound":
      return `“${name}” isn't there any more.`;
    case "changed":
      return `“${name}” changed since the list was read.`;
    case "alwaysOn":
      return `${who ?? "An agent"} reads “${name}” directly, so it stays on.`;
    case "entryTaken":
      return `${who ?? "An agent"} already has a different “${name}”.`;
    case "shadowed":
      return `${who ?? "An agent"} loads another “${name}” first.`;
    case "linkNotAllowed":
      return "Your system doesn't let T3 Code make links there. On Windows, turn on Developer Mode.";
    case "linked":
      return `“${name}” is reached through a link, so it stays where it is.`;
    case "destinationTaken":
      return `${to === undefined ? "The other side" : capitalize(destinationName(to))} already has a “${name}”, so it stays.`;
    case "inUse":
      return `“${name}” is in use by another program, so it wasn't moved.`;
    case "failed":
      return who === undefined
        ? `Couldn't change “${name}”.`
        : `Couldn't change ${who}'s folder for “${name}”.`;
  }
};

const capitalize = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/** A skill that was changed, but not all the way: its old folder stayed, or only some of it went. */
const partialText = (kind: SkillChange["kind"], name: string) =>
  kind === "move"
    ? `“${name}” moved, but its old folder couldn't be removed.`
    : `“${name}” was only partly deleted.`;

const MAX_PROBLEMS = 3;

/** One status line on what a change did, from what the server says happened to each skill. */
export function describeResult(
  change: SkillChange,
  outcomes: readonly SkillOutcome[],
  ctx: SkillsContext,
) {
  const nameOf = (id: ProviderInstanceId) =>
    ctx.installed.find((agent) => agent.instanceId === id)?.displayName ?? id;
  const changed = outcomes.filter((outcome) => outcome.status === "changed");
  const also = [...new Set(changed.flatMap((outcome) => outcome.affected.map(nameOf)))];
  const alsoNames = joinNames(also);
  const them = changed.length === 1 ? "it" : "them";
  const lead = (() => {
    if (changed.length === 0) return "";
    const count = plural(changed.length, "skill");
    switch (change.kind) {
      case "enable":
        return `Turned on ${count} for ${joinNames(change.agents.map(nameOf))}.${also.length > 0 ? ` ${alsoNames} ${also.length === 1 ? "gets" : "get"} ${them} too.` : ""}`;
      case "disable":
        return `Turned off ${count} for ${joinNames(change.agents.map(nameOf))}.${also.length > 0 ? ` ${alsoNames} ${also.length === 1 ? "loses" : "lose"} ${them} too.` : ""}`;
      case "remove":
        return `Removed ${count} from your agents.`;
      case "move":
        return `Moved ${count} to ${destinationName(change.to)}.${also.length > 0 ? ` ${alsoNames} ${also.length === 1 ? "gets" : "get"} ${them} too.` : ""}`;
      case "delete":
        return `Deleted ${count}.`;
    }
  })();
  const problems = [
    ...new Set(
      outcomes.flatMap((outcome) => [
        ...(outcome.reason
          ? [
              outcome.status === "changed" &&
              outcome.reason === "failed" &&
              (change.kind === "move" || change.kind === "delete")
                ? partialText(change.kind, outcome.skill.name)
                : problemText(
                    outcome.reason,
                    outcome.skill.name,
                    undefined,
                    change.kind === "move" ? change.to : undefined,
                  ),
            ]
          : []),
        ...outcome.blocked.map((blocked) =>
          problemText(blocked.reason, outcome.skill.name, nameOf(blocked.instanceId)),
        ),
      ]),
    ),
  ];
  if (lead === "" && problems.length === 0) {
    switch (change.kind) {
      case "enable":
        return "Already on.";
      case "disable":
        return "Already off.";
      case "remove":
        return "Nothing to remove.";
      case "move":
        return `Already in ${destinationName(change.to)}.`;
      case "delete":
        return "Nothing to delete.";
    }
  }
  const shown = problems.slice(0, MAX_PROBLEMS);
  if (problems.length > shown.length) {
    shown.push(`${problems.length - shown.length} more couldn't be changed.`);
  }
  return [lead, ...shown].filter((part) => part !== "").join(" ");
}

// -- Search -----------------------------------------------------------------------------------

export const matchesQuery = (skill: Skill, needle: string) =>
  `${skill.name} ${skill.description}`.toLowerCase().includes(needle);

/** Files an agent could run, shown as a warning in the skill view. */
const SCRIPT_FILE = /\.(?:sh|mjs|ts|py)$/;
export function scriptFiles(files: ReadonlyArray<{ path: string; executable: boolean }>) {
  return files
    .filter(
      (file) =>
        file.path !== "SKILL.md" &&
        (file.path.startsWith("bin/") || SCRIPT_FILE.test(file.path) || file.executable),
    )
    .map((file) => file.path);
}

// -- Files and SKILL.md -----------------------------------------------------------------------

/** Sort entry as the file tree hands it over. */
type FileSortEntry = { path: string; isDirectory: boolean; segments: readonly string[] };

/** The tree's usual order (folders first, then names), with the root SKILL.md pinned on top. */
export function compareSkillFiles(left: FileSortEntry, right: FileSortEntry) {
  const pinned = Number(right.path === "SKILL.md") - Number(left.path === "SKILL.md");
  if (pinned !== 0) return pinned;
  const shared = Math.min(left.segments.length, right.segments.length);
  for (let depth = 0; depth < shared; depth += 1) {
    const a = left.segments[depth]!;
    const b = right.segments[depth]!;
    if (a === b) continue;
    const aFolder = depth < left.segments.length - 1 || left.isDirectory;
    const bFolder = depth < right.segments.length - 1 || right.isDirectory;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return (
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : 1)
    );
  }
  return left.segments.length - right.segments.length;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BLANK_LINES = /^(?:[ \t]*\r?\n)*/;

/** The instructions after the frontmatter, without the blank line that separates them. */
export function skillBody(contents: string) {
  const match = FRONTMATTER.exec(contents);
  const rest = match ? contents.slice(match[0].length) : contents;
  return rest.slice(BLANK_LINES.exec(rest)![0].length);
}
