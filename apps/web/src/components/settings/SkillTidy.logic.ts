import type { ProviderInstanceId, SkillOutcome, SkillRef } from "@t3tools/contracts";

import {
  gitUndoNote,
  groupBySource,
  joinNames,
  type PlanConfirmation,
  type Skill,
  type SkillAgent,
  type SkillsContext,
} from "./SkillsSettings.logic";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const SHARED_FOLDER = ".agents/skills/";

const skillRef = (skill: Skill): SkillRef => ({
  scope: skill.scope,
  name: skill.name,
  home: skill.home,
});

/** A project skill with the same name in Global, and where that Global copy is. */
export type TidyDuplicate = { readonly skill: Skill; readonly globalHome: string };

/** What could be tidied in a project, before any choice is made. */
export type TidyFindings = {
  /** Skills from one `owner/repo` that could move to Global together: two or more, by source. */
  readonly packs: ReadonlyArray<{ readonly source: string; readonly skills: readonly Skill[] }>;
  /** Project skills whose name is also in Global. */
  readonly duplicates: readonly TidyDuplicate[];
  /** Project skills whose real folder is in an agent's own folder, not the shared one. */
  readonly ownFolder: readonly Skill[];
  /** Every project skill an agent could have but doesn't, by agent (see `missingFor`). */
  readonly missing: ReadonlyArray<{
    readonly agent: SkillAgent;
    readonly skills: readonly Skill[];
  }>;
};

/**
 * An agent misses a skill when it doesn't see it at all and T3 Code can turn it on. A skill that
 * shares its name with another may lose to it, and Claude can't load a skill whose header it
 * can't read, so neither counts.
 */
const missesSkill = (skill: Skill, agent: SkillAgent) => {
  if (skill.copies.length > 0) return false;
  if (skill.invalidHeader && agent.driverKind === "claudeAgent") return false;
  const access = skill.access.find((item) => item.instanceId === agent.instanceId);
  return access !== undefined && access.state === "none" && access.fixed !== true;
};

/** Everything that could be tidied in the project's skills; `skills` holds both sections. */
export function tidyFindings(skills: readonly Skill[], ctx: SkillsContext): TidyFindings {
  const project = skills.filter((skill) => skill.scope === "project");
  // Only a skill whose own folder is here can be moved or deleted.
  const movable = project.filter((skill) => skill.realFolder === true);
  const inGlobal = (skill: Skill) => skill.copies.some((copy) => copy.scope === "global");
  const duplicates = movable.flatMap((skill): TidyDuplicate[] => {
    const copy = skill.copies.find((item) => item.scope === "global");
    return copy ? [{ skill, globalHome: copy.home }] : [];
  });
  return {
    // A skill that is in Global already can't move there.
    packs: groupBySource(movable.filter((skill) => !inGlobal(skill))).groups,
    duplicates,
    ownFolder: movable.filter((skill) => !skill.home.startsWith(SHARED_FOLDER)),
    missing: ctx.installed
      .map((agent) => ({ agent, skills: project.filter((skill) => missesSkill(skill, agent)) }))
      .filter((entry) => entry.skills.length > 0),
  };
}

/** What the person picked on each card. */
export type TidyChoices = {
  /** Sources whose skills move to Global; the others stay in the project. */
  readonly packsToGlobal: ReadonlySet<string>;
  /** Names of the duplicates whose project copy goes, keeping the Global one. */
  readonly keepGlobal: ReadonlySet<string>;
  /** Move the skills in an agent's own folder to the shared folder. */
  readonly share: boolean;
  /** Agents whose missing skills are turned on. */
  readonly turnOn: ReadonlySet<ProviderInstanceId>;
};

/** Packs stay, both copies stay, and the rest is fixed. */
export const defaultTidyChoices = (findings: TidyFindings): TidyChoices => ({
  packsToGlobal: new Set(),
  keepGlobal: new Set(),
  share: findings.ownFolder.length > 0,
  turnOn: new Set(findings.missing.map((entry) => entry.agent.instanceId)),
});

/** What Tidy up asks the server for, in the order it runs. */
export type TidySteps = {
  /** Project copies of duplicates, deleted with their links. */
  readonly remove: readonly Skill[];
  readonly toGlobal: readonly Skill[];
  readonly share: readonly Skill[];
  /** Skills each agent gets, among those the other steps leave where they are. */
  readonly turnOn: ReadonlyArray<{ readonly agent: SkillAgent; readonly skills: readonly Skill[] }>;
};

/**
 * The steps the choices add up to. A skill is in one step at most: one that goes or moves out of
 * the folder it is in is left out of the later ones, whose skill references would be out of date.
 */
export function tidySteps(findings: TidyFindings, choices: TidyChoices): TidySteps {
  const remove = findings.duplicates
    .filter((entry) => choices.keepGlobal.has(entry.skill.name))
    .map((entry) => entry.skill);
  const toGlobal = findings.packs
    .filter((pack) => choices.packsToGlobal.has(pack.source))
    .flatMap((pack) => pack.skills);
  const leaving = new Set([...remove, ...toGlobal].map((skill) => skill.id));
  const share = choices.share ? findings.ownFolder.filter((skill) => !leaving.has(skill.id)) : [];
  // A shared skill reaches every agent that reads the shared folder, and keeps the ones it had.
  const moved = new Set([...leaving, ...share.map((skill) => skill.id)]);
  const turnOn = findings.missing
    .filter((entry) => choices.turnOn.has(entry.agent.instanceId))
    .map((entry) => ({
      agent: entry.agent,
      skills: entry.skills.filter((skill) => !moved.has(skill.id)),
    }))
    .filter((entry) => entry.skills.length > 0);
  return { remove, toGlobal, share, turnOn };
}

export const tidyStepCount = (steps: TidySteps) =>
  steps.remove.length +
  steps.toGlobal.length +
  steps.share.length +
  steps.turnOn.reduce((total, entry) => total + entry.skills.length, 0);

/** The folder a project skill's home is in, such as `.claude/skills`. */
const folderOf = (skill: Skill) => skill.home.split("/").slice(0, 2).join("/");

/** Whose own folder the skills sit in: Claude's when they are all in `.claude/skills`. */
const ownerOf = (skills: readonly Skill[]) =>
  skills.every((skill) => folderOf(skill) === ".claude/skills") ? "Claude's" : "an agent's";

export const ownFolderTitle = (skills: readonly Skill[]) =>
  `${plural(skills.length, "skill")} ${skills.length === 1 ? "sits" : "sit"} in ${ownerOf(skills)} own folder`;

export const duplicatesTitle = (duplicates: readonly TidyDuplicate[]) =>
  duplicates.length === 1
    ? `“${duplicates[0]!.skill.name}” is also in Global`
    : `${duplicates.length} skills are also in Global`;

export const packTitle = (pack: TidyFindings["packs"][number]) =>
  `${plural(pack.skills.length, "skill")} from ${pack.source}`;

export const turnOnTitle = (entry: TidySteps["turnOn"][number]) =>
  `Turn on ${plural(entry.skills.length, "skill")} for ${entry.agent.displayName}`;

/**
 * The banner's one sentence for the biggest problem, or null when there is nothing to tidy. An
 * agent that can't use skills comes first, then copies that compete with Global, then folders
 * other agents can't read, then packs that could be Global.
 */
export function tidyBanner(findings: TidyFindings): string | null {
  const steps = tidySteps(findings, defaultTidyChoices(findings));
  const worst = steps.turnOn.toSorted((a, b) => b.skills.length - a.skills.length)[0];
  if (worst) {
    return `${worst.agent.displayName} can't use ${worst.skills.length} of this project's skills.`;
  }
  const { duplicates, ownFolder, packs } = findings;
  if (duplicates.length > 0) {
    return duplicates.length === 1
      ? `“${duplicates[0]!.skill.name}” is in this project and in Global.`
      : `${duplicates.length} of this project's skills are also in Global.`;
  }
  if (ownFolder.length > 0) return `${ownFolderTitle(ownFolder)}.`;
  const pack = packs[0];
  return pack ? `${packTitle(pack)} could be Global.` : null;
}

/**
 * What the banner's dismissal remembers: the problems as they are. It comes back when they
 * change, and never for the same ones.
 */
export function tidySignature(findings: TidyFindings) {
  const ids = (skills: readonly Skill[]) => skills.map((skill) => skill.id).toSorted();
  return JSON.stringify([
    findings.packs.map((pack) => [pack.source, ids(pack.skills)]),
    ids(findings.duplicates.map((entry) => entry.skill)),
    ids(findings.ownFolder),
    findings.missing.map((entry) => [entry.agent.instanceId, ids(entry.skills)]),
  ]);
}

/** The project skills a Tidy up removes from where git sees them, to ask git about. */
export const tidyGitRefs = (steps: TidySteps) =>
  [...steps.remove, ...steps.toGlobal, ...steps.share].map(skillRef);

const someNames = (skills: readonly Skill[], shown = 3) =>
  skills.length <= shown
    ? joinNames(skills.map((skill) => `“${skill.name}”`))
    : `${skills
        .slice(0, shown)
        .map((skill) => `“${skill.name}”`)
        .join(", ")} and ${skills.length - shown} more`;

/** The dialog before Tidy up runs: one line per step. */
export function tidyConfirmation(
  projectName: string,
  steps: TidySteps,
  tracked: readonly string[] | null,
): PlanConfirmation {
  // Git can bring back what it tracks; anything else that is deleted is gone.
  const undoable = tracked !== null && steps.remove.every((skill) => tracked.includes(skill.name));
  const notes = [
    ...(steps.remove.length > 0
      ? [
          `Delete this project's copy of ${someNames(steps.remove)} and keep Global's.${undoable ? "" : " This can't be undone."}`,
        ]
      : []),
    ...(steps.toGlobal.length > 0
      ? [`Make ${plural(steps.toGlobal.length, "skill")} Global, for all your projects.`]
      : []),
    ...(steps.share.length > 0
      ? [
          `Move ${plural(steps.share.length, "skill")} to the shared folder, so every agent can use ${steps.share.length === 1 ? "it" : "them"}.`,
        ]
      : []),
    ...steps.turnOn.map((entry) => `${turnOnTitle(entry)}.`),
  ];
  const git = tracked === null ? null : gitUndoNote(tidyGitRefs(steps), tracked);
  return {
    title: `Tidy up ${projectName}?`,
    body: "",
    notes: git === null ? notes : [...notes, git],
    confirm: "Tidy up",
    destructive: steps.remove.length > 0,
  };
}

/** What one step did, as the server told it. */
export type TidyStepResult = {
  readonly kind: "remove" | "toGlobal" | "share" | "turnOn";
  readonly agent?: SkillAgent;
  readonly outcomes: readonly SkillOutcome[];
  /** How many skills the step asked for; those without an outcome weren't answered for. */
  readonly asked: number;
};

/** The one line shown after Tidy up, from what the server says happened. */
export function describeTidy(results: readonly TidyStepResult[]) {
  const done = results.flatMap((result) => {
    const count = result.outcomes.filter((outcome) => outcome.status === "changed").length;
    if (count === 0) return [];
    switch (result.kind) {
      case "remove":
        return [`kept Global's copy of ${plural(count, "skill")}`];
      case "toGlobal":
        return [`made ${plural(count, "skill")} Global`];
      case "share":
        return [`moved ${plural(count, "skill")} to the shared folder`];
      case "turnOn":
        return [
          `turned on ${plural(count, "skill")} for ${result.agent?.displayName ?? "an agent"}`,
        ];
    }
  });
  // A skill counts as left when it wasn't changed all the way: skipped, held back for an agent,
  // or never answered for.
  const left = results.reduce((total, result) => {
    const incomplete = result.outcomes.filter(
      (outcome) =>
        outcome.status === "skipped" || outcome.blocked.length > 0 || outcome.reason !== undefined,
    ).length;
    return total + incomplete + (result.asked - result.outcomes.length);
  }, 0);
  const lead = done.length === 0 ? "" : `Tidied up: ${joinNames(done)}.`;
  const rest = left === 0 ? "" : `${plural(left, "skill")} couldn't be changed.`;
  return [lead, rest].filter((part) => part !== "").join(" ") || "Nothing changed.";
}
