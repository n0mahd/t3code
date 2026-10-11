import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SecretsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(SecretsToolkit, {
  // A path is only useful on this machine, so only agents T3 launched here get them.
  t3_secret_list: McpToolAccess.readsAsCaller(() =>
    AgentSecrets.AgentSecrets.pipe(
      Effect.flatMap((secrets) => secrets.locate),
      Effect.map((secrets) => ({ secrets })),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    ),
  ),
});
