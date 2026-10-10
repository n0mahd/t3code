import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN run_in_background INTEGER NOT NULL DEFAULT 0`;
  // The most recent background run's thread, cleared when the task stops
  // running in the background.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;

  // Threads launched by background runs, which sidebar lists hide. A row is
  // written before its thread exists and outlives its task, so a deleted
  // task's runs stay out of the sidebar. ProjectionStore reads it by thread_id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_run_threads (
      thread_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
