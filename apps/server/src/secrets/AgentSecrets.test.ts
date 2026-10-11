import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgentSecretSetInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AgentSecrets from "./AgentSecrets.ts";

const layer = Layer.mergeAll(AgentSecrets.layer, ServerSecretStore.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-secrets-" })),
  Layer.provideMerge(NodeServices.layer),
);

const decodeSetInput = Schema.decodeUnknownExit(AgentSecretSetInput);

const directory = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return (yield* Path.Path).join(config.stateDir, "agent-secrets");
});

const modeOf = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.stat(path)),
    Effect.map((info) => info.mode & 0o777),
  );

it.layer(layer)("AgentSecrets", (it) => {
  it.effect("saves a value in a private file and lists only its name", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* secrets.set({ name: "CLOUDFLARE_API_TOKEN", value: "cf-value-1", mode: "create" });

      const dir = yield* directory;
      const [entry] = yield* secrets.locate;
      assert.deepStrictEqual(entry, {
        name: "CLOUDFLARE_API_TOKEN",
        path: `${dir}/CLOUDFLARE_API_TOKEN`,
      });
      assert.strictEqual(yield* fileSystem.readFileString(entry!.path), "cf-value-1");
      assert.strictEqual(yield* modeOf(entry!.path), 0o600);
      assert.strictEqual(yield* modeOf(dir), 0o700);

      const listed = yield* secrets.list;
      assert.deepStrictEqual(
        listed.secrets.map((secret) => secret.name),
        ["CLOUDFLARE_API_TOKEN"],
      );
      assert.notInclude(JSON.stringify(listed), "cf-value-1");
      assert.isFalse(Number.isNaN(Date.parse(listed.secrets[0]!.updatedAt)));
      yield* secrets.remove("CLOUDFLARE_API_TOKEN");
    }),
  );

  it.effect("refuses to create over a saved name, and replaces only when asked", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* secrets.set({ name: "GITHUB_TOKEN", value: "first", mode: "create" });

      const refused = yield* secrets
        .set({ name: "GITHUB_TOKEN", value: "second", mode: "create" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "already_exists");
      const path = `${yield* directory}/GITHUB_TOKEN`;
      assert.strictEqual(yield* fileSystem.readFileString(path), "first");

      yield* secrets.set({ name: "GITHUB_TOKEN", value: "second", mode: "replace" });
      assert.strictEqual(yield* fileSystem.readFileString(path), "second");
      assert.strictEqual(yield* modeOf(path), 0o600);
      // No temporary files are left behind.
      assert.deepStrictEqual(yield* fileSystem.readDirectory(yield* directory), ["GITHUB_TOKEN"]);
      yield* secrets.remove("GITHUB_TOKEN");
    }),
  );

  it.effect("readers never see part of a value while it is replaced", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      const a = "a".repeat(32 * 1024);
      const b = "b".repeat(32 * 1024);
      yield* secrets.set({ name: "LARGE_KEY", value: a, mode: "create" });
      const path = `${yield* directory}/LARGE_KEY`;

      const writes = Effect.forEach(
        Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? b : a)),
        (value) => secrets.set({ name: "LARGE_KEY", value, mode: "replace" }),
      );
      const reads = Effect.forEach(Array.from({ length: 40 }), () =>
        fileSystem.readFileString(path),
      );
      const [, seen] = yield* Effect.all([writes, reads], { concurrency: 2 });
      for (const value of seen) assert.isTrue(value === a || value === b);
      yield* secrets.remove("LARGE_KEY");
    }),
  );

  it.effect("deleting removes the file, and deleting again succeeds", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* secrets.set({ name: "OLD_KEY", value: "old", mode: "create" });
      yield* secrets.remove("OLD_KEY");
      assert.isFalse(yield* fileSystem.exists(`${yield* directory}/OLD_KEY`));
      assert.deepStrictEqual((yield* secrets.list).secrets, []);
      yield* secrets.remove("OLD_KEY");
    }),
  );

  it.effect("refuses names that are not secret names, before touching the disk", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const bad = ["../X", "a", "A".repeat(65), "", "A/B", ".HIDDEN", "1ABC", "A-B"];
      for (const name of bad) {
        const failed = yield* secrets.set({ name, value: "x", mode: "replace" }).pipe(Effect.flip);
        assert.strictEqual(failed.reason, "invalid_name", name);
        assert.strictEqual(
          (yield* secrets.remove(name).pipe(Effect.flip)).reason,
          "invalid_name",
          name,
        );
        assert.isTrue(Exit.isFailure(decodeSetInput({ name, value: "x", mode: "create" })), name);
      }
      assert.isFalse(yield* fileSystem.exists(`${config.stateDir}/X`));
      assert.isTrue(
        Exit.isSuccess(decodeSetInput({ name: "A".repeat(64), value: "x", mode: "create" })),
      );
    }),
  );

  it.effect("lists only secrets, never the server's own secrets or stray files", () =>
    Effect.gen(function* () {
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* store.set("SERVER_OWN", new TextEncoder().encode("server-value"));
      yield* secrets.set({ name: "API_KEY", value: "agent-value", mode: "create" });
      const dir = yield* directory;
      yield* fileSystem.writeFileString(`${dir}/.API_KEY.leftover.tmp`, "partial");
      yield* fileSystem.writeFileString(`${dir}/notes.txt`, "stray");
      yield* fileSystem.makeDirectory(`${dir}/SUBDIR`);

      assert.deepStrictEqual(
        (yield* secrets.locate).map((entry) => entry.name),
        ["API_KEY"],
      );
      yield* secrets.remove("API_KEY");
    }),
  );
});
