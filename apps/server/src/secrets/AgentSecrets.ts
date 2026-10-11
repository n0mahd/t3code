/**
 * AgentSecrets - secrets the user saves once for agents to use.
 *
 * Each secret is one file named after it, readable only by the server's
 * account, so an agent uses it inside a shell command as `$(cat <path>)` and
 * the value never passes through the transcript or model context. Clients see
 * names and dates, agents names and paths; nothing here reads a value back.
 *
 * The server's own secrets (`ServerSecretStore`) live in another directory,
 * and a valid name cannot hold a path separator or a dot, so nothing here can
 * list or reach them.
 *
 * @module AgentSecrets
 */
import {
  AgentSecretError,
  type AgentSecretListResult,
  type AgentSecretSetInput,
  isValidAgentSecretName,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

export class AgentSecrets extends Context.Service<
  AgentSecrets,
  {
    /** Names and when each was last saved, sorted by name. Never values. */
    readonly list: Effect.Effect<AgentSecretListResult, AgentSecretError>;
    /** Names and absolute file paths, sorted by name, for agents' shell commands. */
    readonly locate: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly path: string }>,
      AgentSecretError
    >;
    /**
     * Saves a value atomically: readers see the old value or the new one,
     * never part of either. `create` fails if the name is already saved.
     */
    readonly set: (input: AgentSecretSetInput) => Effect.Effect<void, AgentSecretError>;
    /** Deletes a secret; deleting one that is already gone succeeds. */
    readonly remove: (name: string) => Effect.Effect<void, AgentSecretError>;
  }
>()("t3/secrets/AgentSecrets") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const directory = path.join(serverConfig.stateDir, "agent-secrets");
  const pathOf = (name: string) => path.join(directory, name);

  // Every caller checks, not just the RPC schema, so a crafted name never
  // becomes a path outside the directory.
  const requireName = (name: string) =>
    isValidAgentSecretName(name)
      ? Effect.void
      : Effect.fail(new AgentSecretError({ reason: "invalid_name" }));

  const entries = Effect.gen(function* () {
    const files = yield* fileSystem.readDirectory(directory).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    // Temporary files start with a dot, so they never pass as names.
    const names = files.filter(isValidAgentSecretName).toSorted();
    const found = yield* Effect.forEach(names, (name) =>
      fileSystem.stat(pathOf(name)).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? [
                {
                  name,
                  path: pathOf(name),
                  // Every platform T3 runs on records it.
                  updatedAt: Option.match(info.mtime, {
                    onNone: () => "1970-01-01T00:00:00.000Z",
                    onSome: (mtime) => mtime.toISOString(),
                  }),
                },
              ]
            : [],
        ),
        // Deleted while listing.
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
      ),
    );
    return found.flat();
  }).pipe(Effect.mapError((cause) => new AgentSecretError({ reason: "list_failed", cause })));

  const list: AgentSecrets["Service"]["list"] = entries.pipe(
    Effect.map((found) => ({
      secrets: found.map((entry) => ({
        name: entry.name,
        updatedAt: entry.updatedAt,
      })),
    })),
    Effect.withSpan("AgentSecrets.list"),
  );

  const locate: AgentSecrets["Service"]["locate"] = entries.pipe(
    Effect.map((found) => found.map((entry) => ({ name: entry.name, path: entry.path }))),
    Effect.withSpan("AgentSecrets.locate"),
  );

  const ensureDirectory = fileSystem
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    // Tightens a directory that already existed with a looser mode.
    .pipe(Effect.andThen(fileSystem.chmod(directory, 0o700)));

  const set: AgentSecrets["Service"]["set"] = (input) =>
    Effect.gen(function* () {
      yield* requireName(input.name);
      const target = pathOf(input.name);
      yield* ensureDirectory.pipe(
        Effect.mapError((cause) => new AgentSecretError({ reason: "save_failed", cause })),
      );
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new AgentSecretError({ reason: "save_failed", cause })),
      );
      const temporary = path.join(directory, `.${input.name}.${uuid}.tmp`);
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(temporary, { flag: "wx", mode: 0o600 });
            yield* file.writeAll(new TextEncoder().encode(input.value));
            yield* file.sync;
          }),
        );
        // A hard link fails if the name exists, so two creates cannot both win;
        // a rename replaces the old file in one step.
        yield* input.mode === "create"
          ? fileSystem.link(temporary, target)
          : fileSystem.rename(temporary, target);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AgentSecretError({
              reason: cause.reason._tag === "AlreadyExists" ? "already_exists" : "save_failed",
              cause,
            }),
        ),
        Effect.ensuring(fileSystem.remove(temporary).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.withSpan("AgentSecrets.set", { attributes: { "agent_secret.mode": input.mode } }),
    );

  const remove: AgentSecrets["Service"]["remove"] = (name) =>
    requireName(name).pipe(
      Effect.andThen(
        fileSystem
          .remove(pathOf(name))
          .pipe(
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.void
                : Effect.fail(new AgentSecretError({ reason: "delete_failed", cause })),
            ),
          ),
      ),
      Effect.withSpan("AgentSecrets.remove"),
    );

  return AgentSecrets.of({ list, locate, set, remove });
});

export const layer = Layer.effect(AgentSecrets, make);
