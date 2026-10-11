import { createAgentSecretEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-secrets";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSecretEnvironment = createAgentSecretEnvironmentAtoms(connectionAtomRuntime);
