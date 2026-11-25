// Recovery checks run on the HTTP event loop. Keep their lookups off the
// journal's large args/result and checkpoint payloads as its history grows.
// This migration changes indexes only; retained actions and task state stay put.
export function ensureJournalIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS tool_calls_run_state ON tool_calls(run_id,state,name);
    CREATE INDEX IF NOT EXISTS runs_status_id ON runs(status,id);
    CREATE INDEX IF NOT EXISTS runs_parent_id ON runs(parent_run,id);
  `);
}
