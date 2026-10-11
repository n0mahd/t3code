import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Secrets the user saves for agents. Each is a private file on the server,
 * so agents can use it in shell commands; clients only ever see names.
 */
const AGENT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const AGENT_SECRET_NAME_MAX_LENGTH = 64;
/** Room for certificates and private keys, not for files. */
const AGENT_SECRET_VALUE_MAX_LENGTH = 64 * 1024;

/** Also the file name, so it can never hold a path separator or a dot. */
export function isValidAgentSecretName(name: string): boolean {
  return name.length <= AGENT_SECRET_NAME_MAX_LENGTH && AGENT_SECRET_NAME_PATTERN.test(name);
}

/** Uppercases and turns spaces and `-` into `_`, as the user types. */
export function normalizeAgentSecretName(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "_");
}

export const AgentSecretName = Schema.String.check(
  Schema.makeFilter(isValidAgentSecretName, {
    expected: "letters, numbers and underscores, starting with a letter, at most 64 characters",
  }),
);

export const AgentSecretSummary = Schema.Struct({
  name: AgentSecretName,
  updatedAt: IsoDateTime,
});
export type AgentSecretSummary = typeof AgentSecretSummary.Type;

export const AgentSecretListResult = Schema.Struct({
  secrets: Schema.Array(AgentSecretSummary),
});
export type AgentSecretListResult = typeof AgentSecretListResult.Type;

/** `create` refuses a name already saved; `replace` overwrites it. */
export const AgentSecretSetInput = Schema.Struct({
  name: AgentSecretName,
  value: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_SECRET_VALUE_MAX_LENGTH)),
  mode: Schema.Literals(["create", "replace"]),
});
export type AgentSecretSetInput = typeof AgentSecretSetInput.Type;

export const AgentSecretDeleteInput = Schema.Struct({ name: AgentSecretName });
export type AgentSecretDeleteInput = typeof AgentSecretDeleteInput.Type;

const AGENT_SECRET_FAILURE_MESSAGES = {
  invalid_name: "Use letters, numbers and underscores, starting with a letter.",
  already_exists: "You already have a secret with this name.",
  list_failed: "Could not read your secrets.",
  save_failed: "Could not save the secret.",
  delete_failed: "Could not delete the secret.",
} as const;

export const AgentSecretFailureReason = Schema.Literals(
  Object.keys(AGENT_SECRET_FAILURE_MESSAGES) as Array<keyof typeof AGENT_SECRET_FAILURE_MESSAGES>,
);
export type AgentSecretFailureReason = typeof AgentSecretFailureReason.Type;

/** Saving, listing or deleting a secret failed; the message is shown to users. */
export class AgentSecretError extends Schema.TaggedError<AgentSecretError>()("AgentSecretError", {
  reason: AgentSecretFailureReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return AGENT_SECRET_FAILURE_MESSAGES[this.reason];
  }
}
