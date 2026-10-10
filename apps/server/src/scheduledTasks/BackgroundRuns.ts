import { ScheduledTaskError, ThreadId, type ScheduledTask } from "@t3tools/contracts";
import type { ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Background scheduled-task runs: tasks with `runInBackground` launch a thread
 * per run that clients keep out of the sidebar thread list.
 *
 * The state lives in two side tables created here at startup rather than in a
 * numbered migration. Migrations only run ids above the highest one applied, so
 * a fork migration would make an upstream migration with the same id silently
 * never run. The tables are prefixed so an upstream table is never shadowed.
 *
 * - `fork_scheduled_task_background`: one row per task that runs in the
 *   background, holding its most recent run's thread.
 * - `fork_background_threads`: one row per thread a background run launched.
 *   `ProjectionStore` reads it to flag thread shells.
 */
export const ensureBackgroundRunTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_scheduled_task_background (
      task_id TEXT PRIMARY KEY,
      last_run_thread_id TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_background_threads (
      thread_id TEXT PRIMARY KEY,
      scheduled_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/**
 * The thread a run launches. Derived from the run rather than allocated, so
 * the thread can be flagged before it exists and a replayed launch reuses it.
 * The varying part comes last because scratch folders are named after the
 * tail of the id.
 */
function runThreadId(taskId: ScheduledTaskId, runKey: string): ThreadId {
  return ThreadId.make(`thread:scheduled-task:${taskId}:${runKey}`);
}

interface BackgroundTaskState {
  readonly lastRunThreadId: ThreadId | null;
}

/** Lookups and writes for background runs; failures are `ScheduledTaskError`s like the rest of the service. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureBackgroundRunTables;

  const failure = (message: string, taskId: ScheduledTaskId) => (cause: unknown) =>
    new ScheduledTaskError({ message, taskId, cause });

  /** Background state by task id; a task that does not run in the background is absent. */
  const stateByTaskId = () =>
    sql<{ readonly task_id: string; readonly last_run_thread_id: string | null }>`
      SELECT task_id, last_run_thread_id FROM fork_scheduled_task_background
    `.pipe(
      Effect.map((rows) => {
        const states = new Map<string, BackgroundTaskState>();
        for (const row of rows) {
          states.set(row.task_id, {
            lastRunThreadId:
              row.last_run_thread_id === null
                ? null
                : Option.getOrNull(decodeThreadId(row.last_run_thread_id)),
          });
        }
        return states;
      }),
    );

  /** Adds `runInBackground` and `lastRunThreadId` to tasks decoded from `scheduled_tasks` rows. */
  const annotate = Effect.fn("BackgroundRuns.annotate")(function* (
    tasks: ReadonlyArray<ScheduledTask>,
  ) {
    if (tasks.length === 0) return tasks;
    const states = yield* stateByTaskId().pipe(
      Effect.mapError(
        (cause) => new ScheduledTaskError({ message: "Could not load background runs.", cause }),
      ),
    );
    return tasks.map((task): ScheduledTask => {
      const state = states.get(task.id);
      return state === undefined
        ? task
        : { ...task, runInBackground: true, lastRunThreadId: state.lastRunThreadId };
    });
  });

  const annotateOne = (task: ScheduledTask) =>
    annotate([task]).pipe(Effect.map(([annotated]) => annotated ?? task));

  const setRunInBackground = (taskId: ScheduledTaskId, runInBackground: boolean) =>
    (runInBackground
      ? // Conditional on the task existing, so a save racing a delete leaves no orphan row.
        sql`
          INSERT INTO fork_scheduled_task_background (task_id, last_run_thread_id)
          SELECT ${taskId}, NULL
          WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${taskId})
          ON CONFLICT (task_id) DO NOTHING
        `
      : sql`DELETE FROM fork_scheduled_task_background WHERE task_id = ${taskId}`
    ).pipe(
      Effect.asVoid,
      Effect.mapError(failure("Could not save the run-in-background setting.", taskId)),
    );

  /**
   * Flags the thread a run is about to launch and returns its id, so the
   * thread's shell is never published without the flag.
   */
  const registerThread = (input: {
    readonly taskId: ScheduledTaskId;
    readonly runKey: string;
    readonly createdAt: string;
  }) => {
    const threadId = runThreadId(input.taskId, input.runKey);
    return sql`
      INSERT INTO fork_background_threads (thread_id, scheduled_task_id, created_at)
      VALUES (${threadId}, ${input.taskId}, ${input.createdAt})
      ON CONFLICT (thread_id) DO NOTHING
    `.pipe(
      Effect.as(threadId),
      Effect.mapError(failure("Could not register the background run thread.", input.taskId)),
    );
  };

  /** Only called for a thread that was created; a failed bookkeeping write must not fail the run. */
  const recordLastRun = (taskId: ScheduledTaskId, threadId: ThreadId) =>
    sql`
      UPDATE fork_scheduled_task_background
      SET last_run_thread_id = ${threadId}
      WHERE task_id = ${taskId}
    `.pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("Could not record background run thread", { taskId, cause }),
      ),
    );

  /**
   * Drops a deleted task's setting. Threads its runs launched stay flagged:
   * they remain searchable, and deleting a task must not flood the sidebar.
   */
  const forgetTask = (taskId: ScheduledTaskId) =>
    sql`DELETE FROM fork_scheduled_task_background WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("Could not clear the run-in-background setting.", taskId)),
    );

  return { annotate, annotateOne, setRunInBackground, registerThread, recordLastRun, forgetTask };
}).pipe(Effect.orDie);
