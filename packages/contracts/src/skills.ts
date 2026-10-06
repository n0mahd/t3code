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
 * skill. `none`: it doesn't load this copy of the skill, because it can't see it, because
 * another skill of the same name comes first in its folders, or because its own settings switch
 * the skill off.
 */
export const SkillAgentState = Schema.Literals(["direct", "link", "none"]);
export type SkillAgentState = typeof SkillAgentState.Type;

export const SkillAgentAccess = Schema.Struct({
  /** The enabled provider instance this is about. Instances of unknown drivers are never listed. */
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  state: SkillAgentState,
  /** Where the agent reads the skill from, or for `none` where it looks for skills. */
  folder: Schema.String,
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

/** Make a link in each agent's own skill folder, so the agent can use the skill. */
export const SkillEnableInput = Schema.Struct({
  /** A registered project's folder, for project skills and for the order its folders are read in. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  skills: SkillRefs,
  agents: SkillAgents,
});
export type SkillEnableInput = typeof SkillEnableInput.Type;

/** Remove each agent's link to the skill. An agent that reads the skill's folder itself stays on. */
export const SkillDisableInput = SkillEnableInput;
export type SkillDisableInput = typeof SkillDisableInput.Type;

/** Remove every link to the skills. The skills' own folders are never touched. */
export const SkillRemoveInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  skills: SkillRefs,
});
export type SkillRemoveInput = typeof SkillRemoveInput.Type;

/**
 * Move each skill's folder to the other scope: from a project to the user's global folder, or the
 * other way. Agents that used the skill keep using it.
 */
export const SkillMoveInput = Schema.Struct({
  /** A registered project's folder: the project the skills move from or into. */
  cwd: TrimmedNonEmptyString,
  skills: SkillRefs,
  /** Where the skills go. A skill that is there already is left as it is. */
  to: SkillScope,
});
export type SkillMoveInput = typeof SkillMoveInput.Type;

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
export const SkillDeleteInput = SkillRemoveInput;
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
