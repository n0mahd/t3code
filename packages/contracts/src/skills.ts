import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillScope = Schema.Literals(["project", "global"]);
export type SkillScope = typeof SkillScope.Type;

export const SkillListInput = Schema.Struct({
  /** A project whose own skill folders are read besides the global ones. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SkillListInput = typeof SkillListInput.Type;

/**
 * How one agent reaches a skill. `direct`: it reads a real folder holding the skill (its own
 * folder, or one shared with other agents). `link`: a link in a folder it reads points at the
 * skill. `off`: it can see the skill, but its own settings switch the skill off. `none`: it
 * doesn't load this copy of the skill, because it can't see it or because another skill of the
 * same name comes first in its folders.
 */
export const SkillAgentState = Schema.Literals(["direct", "link", "off", "none"]);
export type SkillAgentState = typeof SkillAgentState.Type;

export const SkillAgentAccess = Schema.Struct({
  /** The enabled provider instance this is about. Instances of unknown drivers are never listed. */
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  state: SkillAgentState,
  /** Where the agent reads the skill from, or for `none` where it looks for skills. */
  folder: Schema.String,
  /**
   * T3 Code can't switch this agent for this skill: the agent reads the folder directly and has
   * no per-skill setting T3 Code knows. A client disables that agent's switch.
   */
  fixed: Schema.optional(Schema.Boolean),
});
export type SkillAgentAccess = typeof SkillAgentAccess.Type;

/** Another skill with the same name, and whether its SKILL.md text is identical. */
export const SkillCopy = Schema.Struct({
  scope: SkillScope,
  /** The same display path as `SkillSummary.home`. */
  home: Schema.String,
  same: Schema.Boolean,
});
export type SkillCopy = typeof SkillCopy.Type;

export const SkillSummary = Schema.Struct({
  /** The skill's folder name, which is what an agent invokes it by. */
  name: Schema.String,
  scope: SkillScope,
  /** Where the files really are, after following links: relative to the project, or `~/…`. */
  home: Schema.String,
  /** The description cut to 160 characters, with a trailing `…` when it was cut. */
  description: Schema.String,
  /** SKILL.md's header can't be read the way Claude Code reads it, so Claude skips the skill. */
  invalidHeader: Schema.optional(Schema.Boolean),
  /**
   * The skill's folder sits in one of the agents' skill folders, so T3 Code can move or delete it.
   * A skill reached only through links, such as a synced library, isn't.
   */
  realFolder: Schema.optional(Schema.Boolean),
  /** The other skills with the same name, in either scope. */
  copies: Schema.Array(SkillCopy),
  access: Schema.Array(SkillAgentAccess),
  /** `owner/repo` from the installer's record of where the skill came from, for grouping. */
  source: Schema.optional(Schema.String),
  /**
   * Set only for a Global skill that is used in some projects instead of every one: the
   * workspace roots of the registered projects it is used in.
   */
  projects: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SkillSummary = typeof SkillSummary.Type;

/** A skill folder that exists but couldn't be read. */
export const SkillFolderProblem = Schema.Struct({
  scope: SkillScope,
  /** The same label as `SkillAgentAccess.folder`. */
  folder: Schema.String,
});
export type SkillFolderProblem = typeof SkillFolderProblem.Type;

export const SkillListResult = Schema.Struct({
  skills: Schema.Array(SkillSummary),
  /** Folders that couldn't be read; a folder that doesn't exist isn't one. */
  unreadable: Schema.Array(SkillFolderProblem),
});
export type SkillListResult = typeof SkillListResult.Type;

export const SkillGetInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  scope: SkillScope,
  name: TrimmedNonEmptyString,
  /** The `home` the list returned, to tell apart two skills that share a name. */
  home: TrimmedNonEmptyString,
});
export type SkillGetInput = typeof SkillGetInput.Type;

export const SkillFile = Schema.Struct({
  /** Relative to the skill's folder. */
  path: Schema.String,
  size: NonNegativeInt,
  executable: Schema.Boolean,
});
export type SkillFile = typeof SkillFile.Type;

export const SkillGetResult = Schema.Struct({
  /** Absolute path of the skill's folder; null when the skill wasn't found. */
  home: Schema.NullOr(Schema.String),
  /** The whole description, which the list cuts short. */
  description: Schema.String,
  /** SKILL.md text; null when it is missing or too large to show. */
  contents: Schema.NullOr(Schema.String),
  /** Files under the home, up to a limit. */
  files: Schema.Array(SkillFile),
  /** Some files aren't listed: there were more files, folders or entries than the limits allow. */
  filesTruncated: Schema.Boolean,
});
export type SkillGetResult = typeof SkillGetResult.Type;

/** The skill an action is about, as the list returned it. */
export const SkillRef = Schema.Struct({
  scope: SkillScope,
  name: TrimmedNonEmptyString,
  /** The `home` the list returned. The action is refused when the skill is no longer there. */
  home: TrimmedNonEmptyString,
});
export type SkillRef = typeof SkillRef.Type;

const SkillRefs = Schema.Array(SkillRef).check(Schema.isMinLength(1), Schema.isMaxLength(200));
const SkillAgents = Schema.Array(ProviderInstanceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);

/**
 * Switch each agent on for the skill: make a link in the agent's own skill folder, or take away
 * the setting that switches it off.
 */
export const SkillEnableInput = Schema.Struct({
  /** A registered project's folder, for project skills and for the order its folders are read in. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  skills: SkillRefs,
  agents: SkillAgents,
});
export type SkillEnableInput = typeof SkillEnableInput.Type;

/**
 * Switch each agent off for the skill: remove its link, or write the agent's own setting. An agent
 * T3 Code can't switch (`fixed`) stays as it is.
 */
export const SkillDisableInput = SkillEnableInput;
export type SkillDisableInput = typeof SkillDisableInput.Type;

/** Where skills should live and be used. Every `cwd` must be a registered project. */
export const SkillPlacement = Schema.Union([
  /** A project's own skills. */
  Schema.Struct({ kind: Schema.Literal("project"), cwd: TrimmedNonEmptyString }),
  /** Global skills, used in every project. */
  Schema.Struct({ kind: Schema.Literal("global") }),
  /** Global skills used only in these projects, as one copy that each of them links to. */
  Schema.Struct({
    kind: Schema.Literal("projects"),
    cwds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
]);
export type SkillPlacement = typeof SkillPlacement.Type;

/**
 * Put each skill where `to` says, moving its folder when it has to. Agents that used the skill
 * keep using it.
 */
export const SkillPlaceInput = Schema.Struct({
  /** The registered project the list was read for, which project skills in `skills` belong to. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  skills: SkillRefs,
  to: SkillPlacement,
});
export type SkillPlaceInput = typeof SkillPlaceInput.Type;

/** Which of these project skills git tracks, so a move or delete of them shows in git. */
export const SkillTrackedInput = Schema.Struct({
  /** The project the skills are in. */
  cwd: TrimmedNonEmptyString,
  skills: SkillRefs,
});
export type SkillTrackedInput = typeof SkillTrackedInput.Type;

export const SkillTrackedResult = Schema.Struct({
  /** Names of the project skills whose SKILL.md git tracks. Never includes a global skill. */
  tracked: Schema.Array(TrimmedNonEmptyString),
});
export type SkillTrackedResult = typeof SkillTrackedResult.Type;

/** Delete each skill's own folder and the links agents use to reach it. This can't be undone. */
export const SkillDeleteInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  skills: SkillRefs,
});
export type SkillDeleteInput = typeof SkillDeleteInput.Type;

/** Why a skill or an agent was left as it was. A client words each one. */
export const SkillOutcomeReason = Schema.Literals([
  /** The skill isn't in the agents' folders any more. */
  "notFound",
  /** The skill, or a link the list showed, is no longer what the list said it was. */
  "changed",
  /** The agent reads the skill's own folder, so there is no link to remove. */
  "alwaysOn",
  /** A folder, file or link to something else is where the link would go. */
  "entryTaken",
  /** The agent loads another skill with this name first, so a link wouldn't be used. */
  "shadowed",
  /** The system won't let T3 Code make links there. */
  "linkNotAllowed",
  /** The folder couldn't be written. */
  "failed",
  /** The skill's folder is reached through a link, so T3 Code leaves it where it is. */
  "linked",
  /** The other scope already has something with this name, which a move never replaces. */
  "destinationTaken",
  /** Another program is using the folder, so it couldn't be moved. */
  "inUse",
  /** A project or organization setting decides it, so switching the agent here can't. */
  "setElsewhere",
]);
export type SkillOutcomeReason = typeof SkillOutcomeReason.Type;

export const SkillOutcome = Schema.Struct({
  skill: SkillRef,
  /**
   * `changed`: a link was made or removed, even if some agents were left out (see `blocked`).
   * `unchanged`: it was already as asked. `skipped`: nothing was changed.
   */
  status: Schema.Literals(["changed", "unchanged", "skipped"]),
  /** Why the whole skill was skipped: `notFound` or `changed`. */
  reason: Schema.optional(SkillOutcomeReason),
  /** Agents the change didn't reach, with why. */
  blocked: Schema.Array(
    Schema.Struct({ instanceId: ProviderInstanceId, reason: SkillOutcomeReason }),
  ),
  /** Agents that weren't asked for but gained or lost the skill, because they read the same folder. */
  affected: Schema.Array(ProviderInstanceId),
  /**
   * Set when a placement moved the skill but the installer's record of where it came from (`source`
   * in the list) couldn't go along, so the skill no longer has one and won't be updated from there.
   */
  sourceDropped: Schema.optional(Schema.Boolean),
});
export type SkillOutcome = typeof SkillOutcome.Type;

/** One outcome per skill asked for, in the order asked. One bad skill never stops the rest. */
export const SkillBatchResult = Schema.Struct({ outcomes: Schema.Array(SkillOutcome) });
export type SkillBatchResult = typeof SkillBatchResult.Type;

/** A whole request that couldn't be carried out, as opposed to a skill that was skipped. */
export class SkillRequestError extends Schema.TaggedError<SkillRequestError>()(
  "SkillRequestError",
  {
    reason: Schema.Literals(["unknownAgent", "projectNotRegistered"]),
  },
) {
  override get message(): string {
    return this.reason === "unknownAgent"
      ? "That agent isn't enabled in this environment."
      : "That folder isn't a project in this environment.";
  }
}

// -- Updates from a skill's source ------------------------------------------------------------

/** Why a skill couldn't be compared with its source, or updated. A client words each one. */
export const SkillUpdateProblem = Schema.Literals([
  /** GitHub's limit for requests without signing in is used up until `retryAt`. */
  "rateLimited",
  /** The repository or branch isn't on GitHub any more, or it is private. */
  "notFound",
  /** GitHub couldn't be reached, or answered with something unexpected. */
  "unavailable",
  /** The skill's folder, or its source's, is too large to compare. */
  "tooLarge",
  /** The source's folder holds links or submodules, which T3 Code doesn't update. */
  "unsupported",
  /** The skill's own folder couldn't be read. */
  "unreadable",
]);
export type SkillUpdateProblem = typeof SkillUpdateProblem.Type;

/** How a skill compares with the source the `skills` CLI installed it from. */
export const SkillUpdateState = Schema.Literals([
  /** The same files as the source. */
  "current",
  /** The source has a newer version. */
  "update",
  /** You've edited it, and the source has nothing newer. */
  "edited",
  /** It differs from the source, and T3 Code can't tell which side changed. */
  "differs",
  /** The source no longer has the skill. */
  "removed",
  /** It couldn't be compared; see `problem`. */
  "unknown",
]);
export type SkillUpdateState = typeof SkillUpdateState.Type;

export const SkillUpdateEntry = Schema.Struct({
  scope: SkillScope,
  name: Schema.String,
  /** The same display path as `SkillSummary.home`. */
  home: Schema.String,
  /** `owner/repo`. */
  source: Schema.String,
  state: SkillUpdateState,
  /**
   * For `update`: whether you've changed the skill since it was installed. Absent when that is
   * only known once the skill's changes are read.
   */
  edited: Schema.optional(Schema.Boolean),
  problem: Schema.optional(SkillUpdateProblem),
  /** For `rateLimited`: when GitHub takes requests again, as an ISO date. */
  retryAt: Schema.optional(Schema.String),
});
export type SkillUpdateEntry = typeof SkillUpdateEntry.Type;

/**
 * Compare every skill the `skills` CLI recorded, Global ones and the project's, with its source:
 * one GitHub request per repository.
 */
export const SkillUpdateCheckInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  /** Ask GitHub again rather than reuse a recent answer. */
  refresh: Schema.optional(Schema.Boolean),
});
export type SkillUpdateCheckInput = typeof SkillUpdateCheckInput.Type;

export const SkillUpdateCheckResult = Schema.Struct({
  entries: Schema.Array(SkillUpdateEntry),
});
export type SkillUpdateCheckResult = typeof SkillUpdateCheckResult.Type;

/** Read what updating one skill would change. Nothing is written. */
export const SkillChangesInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  scope: SkillScope,
  name: TrimmedNonEmptyString,
  /** The `home` the list returned. */
  home: TrimmedNonEmptyString,
});
export type SkillChangesInput = typeof SkillChangesInput.Type;

export const SkillChangedFile = Schema.Struct({
  /** Relative to the skill's folder. */
  path: Schema.String,
  /** From your copy to the source's. */
  change: Schema.Literals(["added", "modified", "removed"]),
  /**
   * What a merge does to the file: take the source's (`theirs`), keep yours (`mine`), combine
   * both (`merged`), or leave it to you because both changed it in ways that clash, or because
   * nothing says which side changed it (`conflict`).
   */
  merge: Schema.Literals(["theirs", "mine", "merged", "conflict"]),
  /** Your text and the source's; null where the file doesn't exist or isn't shown. */
  mine: Schema.NullOr(Schema.String),
  theirs: Schema.NullOr(Schema.String),
  /** For `merged`: the combined text. */
  merged: Schema.optional(Schema.String),
  /** Why the texts aren't shown. */
  omitted: Schema.optional(Schema.Literals(["binary", "tooLarge"])),
  /** An agent may run this file rather than read it. */
  script: Schema.Boolean,
});
export type SkillChangedFile = typeof SkillChangedFile.Type;

export const SkillChangesResult = Schema.Struct({
  /**
   * The comparison, more exact than the check's: `edited` is always known here. Null when the
   * skill is gone or has no record of a GitHub source.
   */
  entry: Schema.NullOr(SkillUpdateEntry),
  /**
   * The versions these changes are between: the source folder's git tree SHA and your copy's.
   * An update names them, so it applies exactly what was shown or nothing.
   */
  upstreamSha: Schema.optional(Schema.String),
  localSha: Schema.optional(Schema.String),
  /** The files that differ, `SKILL.md` first, up to a limit. */
  files: Schema.Array(SkillChangedFile),
  /** How many more files differ than are listed. */
  more: NonNegativeInt,
});
export type SkillChangesResult = typeof SkillChangesResult.Type;

/** Update one skill from its source, or keep your copy as the version to compare with. */
export const SkillUpdateInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  scope: SkillScope,
  name: TrimmedNonEmptyString,
  home: TrimmedNonEmptyString,
  /** `upstreamSha` and `localSha` from the changes that were shown. */
  upstreamSha: TrimmedNonEmptyString,
  localSha: TrimmedNonEmptyString,
  /**
   * `merge`: take the source's changes and keep yours, which needs every conflict settled in
   * `resolutions`. `theirs`: replace your copy with the source's. `mine`: change no file, and
   * record the source's version as the one your copy is based on.
   */
  choice: Schema.Literals(["merge", "theirs", "mine"]),
  /** For `merge`: which version each conflicting file keeps, by path. */
  resolutions: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["mine", "theirs"]))),
});
export type SkillUpdateInput = typeof SkillUpdateInput.Type;

export const SkillUpdateResult = Schema.Struct({
  /**
   * `updated`: files were written. `kept`: no file changed, and the source's version was
   * recorded. `conflicts`: nothing was written because these files need a choice. `changed`:
   * nothing was written because the skill or its source changed since the changes were read.
   * `notFound`: the skill, or its record, is gone.
   */
  status: Schema.Literals(["updated", "kept", "conflicts", "changed", "notFound"]),
  conflicts: Schema.Array(Schema.String),
  /** The `skills` CLI's record couldn't be rewritten, so it still names the older version. */
  lockStale: Schema.optional(Schema.Boolean),
});
export type SkillUpdateResult = typeof SkillUpdateResult.Type;

/** An update that couldn't run. Nothing was written. */
export class SkillUpdateError extends Schema.TaggedError<SkillUpdateError>()("SkillUpdateError", {
  reason: Schema.Literals([
    ...SkillUpdateProblem.literals,
    /** The `skills` CLI's lock doesn't parse or has a version T3 Code doesn't write. */
    "lockUnsupported",
    /** The skill's folder couldn't be written; it was left as it was. */
    "writeFailed",
  ]),
  /** For `rateLimited`: when GitHub takes requests again, as an ISO date. */
  retryAt: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "rateLimited":
        return "GitHub's limit for requests without signing in is used up.";
      case "notFound":
        return "The skill's source isn't on GitHub any more.";
      case "unavailable":
        return "GitHub couldn't be reached.";
      case "tooLarge":
        return "The skill is too large to update here.";
      case "unsupported":
        return "The skill holds links, which T3 Code doesn't update.";
      case "unreadable":
        return "The skill's folder couldn't be read.";
      case "lockUnsupported":
        return "The skills CLI's lock file can't be updated safely.";
      case "writeFailed":
        return "The skill's folder couldn't be written.";
    }
  }
}
