import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SecretListTool = Tool.make("t3_secret_list", {
  description:
    'List the secrets the user saved in T3 Code for agents, such as API tokens, as names and absolute file paths. Values are never returned. Use a secret only inside a shell command, quoted: "$(cat <path>)", e.g. curl -H "Authorization: Bearer $(cat <path>)". Never print, echo, or log a value, and never copy one into files, chat, commits, or tool output. If the secret you need is missing, ask the user to add it under Secrets in the thread details panel.',
  success: Schema.Struct({
    secrets: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentSecrets.AgentSecrets,
  ],
})
  .annotate(Tool.Title, "List saved secrets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SecretsToolkit = Toolkit.make(SecretListTool);
