import {
  SkillUpdateError,
  type SkillChangedFile,
  type SkillChangesResult,
  type SkillUpdateCheckResult,
  type SkillUpdateEntry,
  type SkillUpdateResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { Skill, SkillPlan } from "./SkillsSettings.logic";

/** The last check's answer for each skill, by `Skill.id`. */
export type SkillUpdates = ReadonlyMap<string, SkillUpdateEntry>;

const idOf = (entry: Pick<SkillUpdateEntry, "scope" | "name" | "home">) =>
  `${entry.scope}\0${entry.name}\0${entry.home}`;

export function ingestUpdates(result: SkillUpdateCheckResult): SkillUpdates {
  return new Map(result.entries.map((entry) => [idOf(entry), entry]));
}

/** The check's answer with one skill's more exact one, as reading its changes gives it. */
export function withEntry(updates: SkillUpdates, entry: SkillUpdateEntry): SkillUpdates {
  const next = new Map(updates);
  next.set(idOf(entry), entry);
  return next;
}

/** The skill has a newer version at its source. */
export const hasUpdate = (entry: SkillUpdateEntry | undefined) => entry?.state === "update";

/** The skills among these with an update. */
export const skillsWithUpdates = (skills: readonly Skill[], updates: SkillUpdates | null) =>
  updates === null ? [] : skills.filter((skill) => hasUpdate(updates.get(skill.id)));

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A time of day the way the person's clock shows it. */
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What GitHub's limit means for the person, with when it resets when that is known. */
const rateLimitText = (retryAt: string | undefined) =>
  retryAt === undefined
    ? "GitHub's limit for this network is used up. Try again later."
    : `GitHub's limit for this network is used up. Try again after ${timeOf(retryAt)}.`;

/** One short line after a check: how many updates, and anything that couldn't be checked. */
export function checkSummary(result: SkillUpdateCheckResult): string {
  const { entries } = result;
  if (entries.length === 0) return "No skills here were installed from GitHub.";
  const limited = entries.find((entry) => entry.problem === "rateLimited");
  if (limited) return rateLimitText(limited.retryAt);
  const updates = entries.filter((entry) => entry.state === "update").length;
  const lead =
    updates === 0 ? "Your skills are up to date." : `${plural(updates, "update")} available.`;
  const missing = [
    ...new Set(
      entries.filter((entry) => entry.problem === "notFound").map((entry) => entry.source),
    ),
  ];
  const failed = entries.some((entry) => entry.state === "unknown" && entry.problem !== "notFound");
  const notes = [
    missing.length === 0
      ? null
      : `Couldn't find ${missing.length === 1 ? missing[0] : plural(missing.length, "source")} on GitHub.`,
    failed ? "Some skills couldn't be checked." : null,
  ].filter((note) => note !== null);
  return updates === 0 && notes.length > 0 ? notes.join(" ") : [lead, ...notes].join(" ");
}

/** Why one skill's changes couldn't be shown. */
export function problemText(entry: SkillUpdateEntry): string {
  switch (entry.problem) {
    case "rateLimited":
      return rateLimitText(entry.retryAt);
    case "notFound":
      return `Couldn't find ${entry.source} on GitHub. A private repository can't be checked.`;
    case "tooLarge":
      return "This skill is too large to compare here.";
    case "unsupported":
      return "Its source has links in it, so update it with npx skills update.";
    case "unreadable":
      return "This skill's folder couldn't be read.";
    default:
      return "Couldn't reach GitHub.";
  }
}

/** The heading over a skill's changes. */
export function changesTitle(entry: SkillUpdateEntry): string {
  if (entry.state === "differs") return `Differs from ${entry.source}`;
  return entry.edited ? "You've edited it, and there's a newer version" : "There's a newer version";
}

/** What an update does with your copy: merge, take theirs, or keep yours. */
export type UpdateChoice = "merge" | "theirs" | "mine";
export type Resolutions = Readonly<Record<string, "mine" | "theirs">>;

/** Whether the person has a choice to make: only an edited skill has edits to keep. */
export const needsChoice = (entry: SkillUpdateEntry) =>
  entry.state === "differs" || entry.edited === true;

/** Files a merge can't settle by itself. */
export const conflictsOf = (files: readonly SkillChangedFile[]) =>
  files.filter((file) => file.merge === "conflict");

/** A file's text before and after the update, for the diff; null when it doesn't change. */
export function previewOf(
  file: SkillChangedFile,
  choice: UpdateChoice,
  resolutions: Resolutions,
): { readonly before: string | null; readonly after: string | null } | null {
  if (choice === "mine") return null;
  const take =
    choice === "theirs"
      ? "theirs"
      : file.merge === "conflict"
        ? // An unsettled conflict shows what taking theirs would do.
          (resolutions[file.path] ?? "theirs")
        : file.merge;
  if (take === "mine") return null;
  return { before: file.mine, after: take === "merged" ? (file.merged ?? null) : file.theirs };
}

/** What the confirm dialog says before one skill is updated from its page. */
export function planUpdateOne(input: {
  readonly skill: Skill;
  readonly changes: SkillChangesResult;
  readonly choice: UpdateChoice;
  readonly resolutions: Resolutions;
}): SkillPlan | null {
  const { skill, changes, choice, resolutions } = input;
  const { entry, upstreamSha, localSha, files } = changes;
  if (entry === null || upstreamSha === undefined || localSha === undefined) return null;
  const change = {
    kind: "update" as const,
    skills: [{ scope: skill.scope, name: skill.name, home: skill.home }],
    shown: { upstreamSha, localSha, choice, resolutions },
  };
  // Keeping your copy changes no file, so there is nothing to confirm.
  if (choice === "mine") return { change, affected: 1 };
  const replaced = files.filter((file) => {
    if (file.mine === null && file.omitted === undefined) return false;
    if (choice === "theirs") return file.merge !== "theirs";
    return file.merge === "conflict" && resolutions[file.path] === "theirs";
  });
  const scripts = files.filter(
    (file) => file.script && file.change !== "removed" && previewOf(file, choice, resolutions),
  );
  const notes = [
    replaced.length === 0
      ? null
      : `Your changes to ${replaced.length === 1 ? replaced[0]!.path : plural(replaced.length, "file")} are replaced.`,
    scripts.length === 0
      ? null
      : `Changes ${scripts.length === 1 ? "the script" : "scripts"} ${scripts
          .slice(0, 3)
          .map((file) => file.path)
          .join(", ")}${scripts.length > 3 ? ` and ${scripts.length - 3} more` : ""}.`,
  ].filter((note) => note !== null);
  return {
    change,
    affected: 1,
    confirmation: {
      title:
        choice === "theirs" && needsChoice(entry)
          ? `Use their ${skill.name}?`
          : `Update ${skill.name}?`,
      body:
        choice === "merge" && needsChoice(entry)
          ? "Your edits are kept."
          : `It gets the version from ${entry.source}.`,
      notes,
      confirm: choice === "theirs" && needsChoice(entry) ? "Use their version" : "Update",
      destructive: replaced.length > 0,
    },
  };
}

/** Updating every skill with an update among these; edited ones keep their edits. */
export function planUpdateAll(
  skills: readonly Skill[],
  updates: SkillUpdates | null,
): SkillPlan | null {
  const targets = skillsWithUpdates(skills, updates);
  if (targets.length === 0) return null;
  const edited = targets.some((skill) => updates?.get(skill.id)?.edited !== false);
  return {
    change: {
      kind: "update",
      skills: targets.map((skill) => ({ scope: skill.scope, name: skill.name, home: skill.home })),
    },
    affected: targets.length,
    confirmation: {
      title:
        targets.length === 1 ? `Update ${targets[0]!.name}?` : `Update ${targets.length} skills?`,
      body: edited
        ? "Skills you've edited keep your edits. Any whose edits clash with the update are left for you to choose."
        : "",
      notes: [],
      confirm: "Update",
      destructive: false,
    },
  };
}

const isUpdateError = Schema.is(SkillUpdateError);

/** Why an update failed, from what the server sent back. */
export const updateErrorReason = (error: unknown): SkillUpdateError["reason"] | "failed" =>
  isUpdateError(error) ? error.reason : "failed";

/** How one skill's update went, for the notice afterwards. */
export type UpdateOutcome =
  | { readonly name: string; readonly result: SkillUpdateResult }
  | { readonly name: string; readonly error: SkillUpdateError["reason"] | "failed" };

/** One short notice after updating: what was updated, and what needs the person. */
export function describeUpdates(outcomes: readonly UpdateOutcome[]): string {
  const names = (list: readonly UpdateOutcome[]) =>
    list.length <= 3
      ? list.map((item) => item.name).join(", ")
      : `${list
          .slice(0, 3)
          .map((item) => item.name)
          .join(", ")} and ${list.length - 3} more`;
  const ofStatus = (status: SkillUpdateResult["status"]) =>
    outcomes.filter((item) => "result" in item && item.result.status === status);
  const updated = ofStatus("updated");
  const kept = ofStatus("kept");
  const conflicts = ofStatus("conflicts");
  const changed = ofStatus("changed");
  const failed = outcomes.filter(
    (item) => "error" in item || ("result" in item && item.result.status === "notFound"),
  );
  const stale = outcomes.filter((item) => "result" in item && item.result.lockStale === true);
  const limited = outcomes.find((item) => "error" in item && item.error === "rateLimited");
  const one = outcomes.length === 1 ? outcomes[0] : undefined;
  const parts = [
    updated.length === 0
      ? null
      : one
        ? `Updated ${one.name}.`
        : `Updated ${plural(updated.length, "skill")}.`,
    kept.length === 0
      ? null
      : one
        ? `Kept your ${one.name}.`
        : `Kept ${plural(kept.length, "skill")} as they are.`,
    conflicts.length === 0
      ? null
      : `${names(conflicts)} ${conflicts.length === 1 ? "needs" : "need"} you to choose between your edits and theirs.`,
    changed.length === 0
      ? null
      : `${names(changed)} changed meanwhile, so ${changed.length === 1 ? "it was" : "they were"} left as ${changed.length === 1 ? "it was" : "they were"}. Check again.`,
    limited
      ? rateLimitText(undefined)
      : failed.length === 0
        ? null
        : `Couldn't update ${names(failed)}.`,
    stale.length === 0
      ? null
      : "The skills CLI's record couldn't be updated, so it may offer the update again.",
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing to update." : parts.join(" ");
}
