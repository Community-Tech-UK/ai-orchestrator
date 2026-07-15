/** Shared DDL for the durable, queryable verification execution ledger. */
export const VERIFICATION_RUNS_UP_SQL = `
  CREATE TABLE IF NOT EXISTS verification_runs (
    id                TEXT PRIMARY KEY,
    scope             TEXT NOT NULL CHECK(scope IN ('loop', 'instance')),
    loop_run_id       TEXT,
    instance_id       TEXT,
    command           TEXT NOT NULL,
    canonical_command TEXT NOT NULL,
    cwd               TEXT NOT NULL,
    exit_code         INTEGER,
    duration_ms       INTEGER NOT NULL CHECK(duration_ms >= 0),
    work_hash         TEXT,
    output_ref        TEXT,
    started_at        INTEGER NOT NULL,
    CHECK(
      (scope = 'loop' AND loop_run_id IS NOT NULL AND instance_id IS NULL) OR
      (scope = 'instance' AND instance_id IS NOT NULL AND loop_run_id IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_verification_runs_loop_started
    ON verification_runs(loop_run_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_verification_runs_instance_started
    ON verification_runs(instance_id, started_at DESC);
`;
