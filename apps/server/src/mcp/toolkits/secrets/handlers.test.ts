import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment:secrets");
const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:secrets",
  thread: {
    threadId: ThreadId.make("thread:secrets"),
    providerSessionId: "provider:secrets",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const outsideClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
};

const callSecretList = (scope: McpInvocationContext.McpInvocationScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_secret_list", arguments: {} })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(
      McpSchema.McpServerClient,
      McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "secrets", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "secrets", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    ),
  );

const layer = McpHttpServer.layerSecretsToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  Layer.provideMerge(AgentSecrets.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-secrets-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("t3_secret_list", (it) => {
  it.effect("gives a thread's agent paths that hold the values, and no values", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* secrets.set({ name: "CLOUDFLARE_API_TOKEN", value: "cf-value", mode: "create" });
      yield* secrets.set({ name: "GITHUB_TOKEN", value: "gh-value", mode: "create" });

      const result = yield* callSecretList(threadCaller);
      expect(result.isError).toBe(false);
      const listed = result.structuredContent as {
        secrets: ReadonlyArray<{ name: string; path: string }>;
      };
      expect(listed.secrets.map((secret) => secret.name)).toEqual([
        "CLOUDFLARE_API_TOKEN",
        "GITHUB_TOKEN",
      ]);
      const values = yield* Effect.forEach(listed.secrets, (secret) =>
        fileSystem.readFileString(secret.path),
      );
      expect(values).toEqual(["cf-value", "gh-value"]);
      expect(JSON.stringify(result)).not.toContain("cf-value");
      expect(JSON.stringify(result)).not.toContain("gh-value");
    }),
  );

  it.effect("refuses a client signed in from outside a thread", () =>
    Effect.gen(function* () {
      const result = yield* callSecretList(outsideClient);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("thread_credential_required");
    }),
  );
});
