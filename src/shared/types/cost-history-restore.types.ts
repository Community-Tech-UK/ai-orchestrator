/**
 * LT-707 cost history restoration (application maintenance flow) payloads.
 *
 * Shared between the main-process maintenance flow and the renderer surface.
 * See `src/main/core/system/cost-entries-a0-restore.ts` for the flow itself.
 */

/**
 * Outcome of restoring affected Claude rows from `cost_entries_a0_backup`.
 * `beforeUsd`/`afterUsd` sum only the rows this run changed — not the whole
 * checked scope (that is `CostRestoreInspection`'s `currentUsd`/`originalUsd`).
 */
export interface CostRestoreSummary {
  status: 'restored' | 'noop' | 'missing-cutoff' | 'failed';
  rows: number;
  beforeUsd: number;
  afterUsd: number;
}

/**
 * Outcome of undoing a restoration from its rollback snapshot.
 * `beforeUsd`/`afterUsd` sum only the rows the undo changed.
 */
export interface CostRestoreRollbackSummary {
  status: 'rolled-back' | 'noop' | 'failed';
  rows: number;
  beforeUsd: number;
  afterUsd: number;
}

/**
 * Read-only totals over the rows the remediation may restore.
 * `originalUsd`/`currentUsd` sum the whole checked scope. `unverifiedRows`
 * counts rows whose repair-time classification cannot be verified (conflicting
 * or unplaceable provider evidence): they fail closed and no run ever writes
 * them.
 */
export interface CostRestoreInspection {
  claudeCutoff: number | null;
  scopedRows: number;
  mismatchedRows: number;
  originalUsd: number;
  currentUsd: number;
  unverifiedRows: number;
}
