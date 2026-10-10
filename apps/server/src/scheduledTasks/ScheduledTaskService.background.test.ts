import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const taskInput = {
  title: "Inbox sweep",
  prompt: "Triage the inbox.",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-background",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

/**
 * Builds the service with a launch that records its thread id and whether that
 * thread was already flagged as a background run at the moment of the launch.
 */
const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const launches: Array<{ readonly threadId: string | undefined; readonly flagged: boolean }> = [];
  const launchOutcome = { fail: false };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM scheduled_task_run_threads WHERE thread_id = ${input.threadId ?? ""}
        `.pipe(
          Effect.orDie,
          Effect.tap((rows) =>
            Effect.sync(() =>
              launches.push({ threadId: input.threadId, flagged: rows.length > 0 }),
            ),
          ),
          Effect.flatMap(() =>
            launchOutcome.fail
              ? Effect.die(new Error("launch failed"))
              : Effect.succeed({ threadId: input.threadId, resumed: false } as never),
          ),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
  );
  return { sql, launches, launchOutcome, layerDependencies };
});

const rowCount = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

it.effect("flags a background run's thread before launch and records it as the last run", () =>
  Effect.gen(function* () {
    const { launches, layerDependencies } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeUpsertInput({ ...taskInput, runInBackground: true }),
      );
      assert.isTrue(created.task.runInBackground);
      assert.notExists(created.task.lastRunThreadId);

      const ran = yield* service.runNow({ id: created.task.id });
      assert.equal(launches.length, 1);
      const launched = launches[0];
      assert.exists(launched?.threadId);
      // The flag is in place before the thread exists, so its shell is never
      // published without it.
      assert.isTrue(launched?.flagged);
      assert.equal(ran.task.lastRunStatus, "succeeded");
      assert.equal(ran.task.lastRunThreadId, launched?.threadId);
      assert.equal((yield* service.list()).tasks[0]?.lastRunThreadId, launched?.threadId);

      // A task that is not in the background lets the launch allocate its own id.
      const foreground = yield* service.upsert(
        yield* decodeUpsertInput({ ...taskInput, id: "scheduled-task:foreground" }),
      );
      assert.isFalse(foreground.task.runInBackground);
      yield* service.runNow({ id: foreground.task.id });
      assert.equal(launches[1]?.threadId, undefined);
      assert.isFalse(launches[1]?.flagged);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "keeps the stored setting when a save omits it and clears it when a save says false",
  () =>
    Effect.gen(function* () {
      const { layerDependencies } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const created = yield* service.upsert(
          yield* decodeUpsertInput({ ...taskInput, runInBackground: true }),
        );
        const id = created.task.id;
        yield* service.runNow({ id });

        // Older clients save without the field; that must not reset it.
        const omitted = yield* service.upsert(
          yield* decodeUpsertInput({ ...taskInput, id, title: "Renamed" }),
        );
        assert.isTrue(omitted.task.runInBackground);
        assert.exists(omitted.task.lastRunThreadId);
        assert.isTrue((yield* service.list()).tasks[0]?.runInBackground);

        const cleared = yield* service.upsert(
          yield* decodeUpsertInput({ ...taskInput, id, runInBackground: false }),
        );
        assert.isFalse(cleared.task.runInBackground);
        assert.notExists(cleared.task.lastRunThreadId);

        // A save that omits it again keeps the cleared value.
        const stillOff = yield* service.upsert(yield* decodeUpsertInput({ ...taskInput, id }));
        assert.isFalse(stillOff.task.runInBackground);

        // A task bound to a thread posts into it, so there is no run thread to hide.
        const bound = yield* service.upsert(
          yield* decodeUpsertInput({
            ...taskInput,
            id: "scheduled-task:bound",
            threadId: "thread-bound",
            runInBackground: true,
          }),
        );
        assert.isFalse(bound.task.runInBackground);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not record a last run for a launch that failed", () =>
  Effect.gen(function* () {
    const { sql, launches, launchOutcome, layerDependencies } = yield* makeHarness;
    launchOutcome.fail = true;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeUpsertInput({ ...taskInput, runInBackground: true }),
      );
      const ran = yield* service.runNow({ id: created.task.id });
      assert.equal(ran.task.lastRunStatus, "failed");
      assert.notExists(ran.task.lastRunThreadId);
      // The thread was flagged before the launch; leaving that row is harmless.
      assert.equal(launches.length, 1);
      assert.isTrue(launches[0]?.flagged);
      assert.equal(yield* rowCount(sql, "scheduled_task_run_threads"), 1);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a deleted task's run threads flagged", () =>
  Effect.gen(function* () {
    const { sql, layerDependencies } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeUpsertInput({ ...taskInput, runInBackground: true }),
      );
      yield* service.runNow({ id: created.task.id });
      assert.equal(yield* rowCount(sql, "scheduled_task_run_threads"), 1);

      yield* service.delete({ id: created.task.id });
      assert.equal(yield* rowCount(sql, "scheduled_tasks"), 0);
      // Deleting a task must not flood the sidebar with its past runs.
      assert.equal(yield* rowCount(sql, "scheduled_task_run_threads"), 1);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
