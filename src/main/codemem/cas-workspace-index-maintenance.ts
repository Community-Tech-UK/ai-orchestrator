import type { SqliteDriver } from '../db/sqlite-driver';
import type { WorkspaceHash } from './types';

export interface WorkspaceIndexStats {
  workspaceHash: WorkspaceHash;
  absPath: string;
  lastIndexedAt: number;
  manifestEntries: number;
  workspaceChunks: number;
  workspaceSymbols: number;
}

interface WorkspaceIndexStatsRow {
  workspace_hash: string;
  abs_path: string;
  last_indexed_at: number;
  manifest_entries: number;
  workspace_chunks: number;
  workspace_symbols: number;
}

export function listWorkspaceIndexStats(db: SqliteDriver): WorkspaceIndexStats[] {
  const rows = db.prepare(`
    SELECT
      wr.workspace_hash,
      wr.abs_path,
      wr.last_indexed_at,
      COALESCE(m.manifest_entries, 0) AS manifest_entries,
      COALESCE(c.workspace_chunks, 0) AS workspace_chunks,
      COALESCE(s.workspace_symbols, 0) AS workspace_symbols
    FROM workspace_root wr
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS manifest_entries
      FROM workspace_manifest
      GROUP BY workspace_hash
    ) m ON m.workspace_hash = wr.workspace_hash
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS workspace_chunks
      FROM workspace_chunks
      GROUP BY workspace_hash
    ) c ON c.workspace_hash = wr.workspace_hash
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS workspace_symbols
      FROM workspace_symbols
      GROUP BY workspace_hash
    ) s ON s.workspace_hash = wr.workspace_hash
    ORDER BY wr.last_indexed_at ASC
  `).all<WorkspaceIndexStatsRow>();

  return rows.map((row) => ({
    workspaceHash: row.workspace_hash,
    absPath: row.abs_path,
    lastIndexedAt: row.last_indexed_at,
    manifestEntries: row.manifest_entries,
    workspaceChunks: row.workspace_chunks,
    workspaceSymbols: row.workspace_symbols,
  }));
}

export function deleteWorkspaceIndex(db: SqliteDriver, workspaceHash: WorkspaceHash): void {
  const chunkRows = db
    .prepare('SELECT id FROM workspace_chunks WHERE workspace_hash = ?')
    .all<{ id: number }>(workspaceHash);
  const tx = db.transaction(() => {
    const deleteFts = db.prepare('DELETE FROM code_fts WHERE rowid = ?');
    for (const row of chunkRows) {
      deleteFts.run(row.id);
    }
    db.prepare('DELETE FROM workspace_chunks WHERE workspace_hash = ?').run(workspaceHash);
    db.prepare('DELETE FROM workspace_symbols WHERE workspace_hash = ?').run(workspaceHash);
    db.prepare('DELETE FROM workspace_manifest WHERE workspace_hash = ?').run(workspaceHash);
    db.prepare('DELETE FROM code_index_status WHERE workspace_hash = ?').run(workspaceHash);
    db.prepare('DELETE FROM workspace_root WHERE workspace_hash = ?').run(workspaceHash);
  });
  tx();
}

/** Rows per table in one transaction: about a quarter of a second of deleting. */
export const ABANDONED_PRUNE_BATCH_ROWS = 1_000;
/**
 * How long one maintenance step aims to hold the worker. Every code search queues
 * behind it, so this matches the 500 ms send deadline. An unbounded search index
 * optimise once took 157 seconds. A step checks the time between batches, so the
 * batch it is on can run past this.
 */
export const MAINTENANCE_STEP_TIME_BUDGET_MS = 500;
const CHUNK_PRUNE_BATCH_ROWS = 2_000;
/** Roughly how much of the search index one merge step rewrites. */
const SEARCH_MERGE_STEP_PAGES = 500;
/** An index run updates its status for every file, so silence this long means it died. */
const INDEX_RUN_STALE_AFTER_MS = 60 * 60 * 1000;

export interface BoundedStepOptions {
  timeBudgetMs?: number;
  now?: () => number;
}

const WORKSPACE_SCOPED_TABLES = [
  'workspace_chunks',
  'workspace_symbols',
  'workspace_manifest',
  'code_index_status',
] as const;

export interface PruneAbandonedWorkspacesOptions extends BoundedStepOptions {
  batchRows?: number;
}

export interface PruneAbandonedWorkspacesResult {
  deletedWorkspaces: number;
  deletedChunks: number;
  remainingWorkspaces: number;
}

/** Every workspace in a table, found with one index probe each rather than a full scan. */
function listWorkspaceHashes(db: SqliteDriver, table: typeof WORKSPACE_SCOPED_TABLES[number]): string[] {
  const nextHash = db.prepare(`SELECT MIN(workspace_hash) AS hash FROM ${table} WHERE workspace_hash > ?`);
  const hashes: string[] = [];
  let cursor = '';
  for (;;) {
    const hash = nextHash.get<{ hash: string | null }>(cursor)?.hash;
    if (!hash) return hashes;
    hashes.push(hash);
    cursor = hash;
  }
}

function isIndexRunActive(db: SqliteDriver, workspaceHash: string, now: number): boolean {
  const status = db
    .prepareCached('SELECT state, updated_at FROM code_index_status WHERE workspace_hash = ?')
    .get<{ state: string; updated_at: number }>(workspaceHash);
  return status?.state === 'running' && now - status.updated_at < INDEX_RUN_STALE_AFTER_MS;
}

/**
 * Workspaces that hold rows but were never registered. A cold index registers
 * the workspace only once it finishes, so a run that was cancelled or failed
 * leaves rows behind with nothing pointing at them. They cannot be searched,
 * and a later cold index wipes them before starting, so they have no value.
 * `listWorkspaceIndexStats` starts from the registered workspaces and cannot
 * see them, which is how 3 million of them once built up unnoticed.
 */
export function listAbandonedWorkspaces(db: SqliteDriver, now: number): WorkspaceHash[] {
  const registered = new Set(
    db.prepare('SELECT workspace_hash FROM workspace_root')
      .all<{ workspace_hash: string }>()
      .map((row) => row.workspace_hash),
  );
  const abandoned = new Set<WorkspaceHash>();
  for (const table of WORKSPACE_SCOPED_TABLES) {
    for (const hash of listWorkspaceHashes(db, table)) {
      if (!registered.has(hash) && !isIndexRunActive(db, hash, now)) abandoned.add(hash);
    }
  }
  return [...abandoned];
}

/**
 * Delete one batch of a workspace's rows. The manifest goes only after every
 * chunk and symbol: a new cold index clears old rows by walking the manifest, so
 * rows it no longer lists would survive that clear and be searched as duplicates.
 * The status row goes last, once nothing else is left.
 */
function deleteAbandonedBatch(
  db: SqliteDriver,
  workspaceHash: WorkspaceHash,
  batchRows: number,
): { deletedChunks: number; finished: boolean } {
  const chunkIds = db
    .prepare('SELECT id FROM workspace_chunks WHERE workspace_hash = ? LIMIT ?')
    .all<{ id: number }>(workspaceHash, batchRows);
  const deleteBatch = db.transaction(() => {
    const deleteFts = db.prepareCached('DELETE FROM code_fts WHERE rowid = ?');
    const deleteChunk = db.prepareCached('DELETE FROM workspace_chunks WHERE id = ?');
    for (const { id } of chunkIds) {
      deleteFts.run(id);
      deleteChunk.run(id);
    }
    const deletedSymbols = db.prepareCached(`
      DELETE FROM workspace_symbols
      WHERE rowid IN (SELECT rowid FROM workspace_symbols WHERE workspace_hash = ? LIMIT ?)
    `).run(workspaceHash, batchRows).changes;
    if (chunkIds.length === batchRows || deletedSymbols === batchRows) return false;

    const deletedManifest = db.prepareCached(`
      DELETE FROM workspace_manifest
      WHERE rowid IN (SELECT rowid FROM workspace_manifest WHERE workspace_hash = ? LIMIT ?)
    `).run(workspaceHash, batchRows).changes;
    if (deletedManifest === batchRows) return false;

    db.prepareCached('DELETE FROM code_index_status WHERE workspace_hash = ?').run(workspaceHash);
    return true;
  });
  return { deletedChunks: chunkIds.length, finished: deleteBatch() };
}

/**
 * Remove abandoned workspaces in small transactions until the time budget runs
 * out. A workspace can hold tens of thousands of rows, so deleting one in a
 * single step would stall the worker, and every code search queues behind it.
 * Callers repeat this until nothing remains.
 */
export function pruneAbandonedWorkspaces(
  db: SqliteDriver,
  options: PruneAbandonedWorkspacesOptions = {},
): PruneAbandonedWorkspacesResult {
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? MAINTENANCE_STEP_TIME_BUDGET_MS;
  const batchRows = Math.max(1, Math.floor(options.batchRows ?? ABANDONED_PRUNE_BATCH_ROWS));
  const pending = listAbandonedWorkspaces(db, now());
  // Starting the clock here means a slow listing cannot leave a burst doing nothing.
  const startedAt = now();

  let deletedWorkspaces = 0;
  let deletedChunks = 0;
  let takenOver = 0;
  for (const workspaceHash of pending) {
    for (let finished = false; !finished;) {
      if (now() - startedAt >= timeBudgetMs) {
        return { deletedWorkspaces, deletedChunks, remainingWorkspaces: pending.length - deletedWorkspaces - takenOver };
      }
      if (isIndexRunActive(db, workspaceHash, now())) {
        takenOver += 1;
        break;
      }
      const batch = deleteAbandonedBatch(db, workspaceHash, batchRows);
      deletedChunks += batch.deletedChunks;
      finished = batch.finished;
      if (finished) deletedWorkspaces += 1;
    }
  }
  return { deletedWorkspaces, deletedChunks, remainingWorkspaces: 0 };
}

export interface PruneUnreferencedChunksResult {
  deleted: number;
  /** Where to resume, or null when the whole table has been walked. */
  resumeAfter: string | null;
}

export interface SpaceReleaseStep {
  deletedChunks: number;
  finished: boolean;
}

/**
 * Delete chunk text nothing refers to, walking the table in key order so a run
 * can stop at its budget and resume from where it was.
 */
export function pruneUnreferencedChunks(
  db: SqliteDriver,
  options: BoundedStepOptions & { after?: string; batchRows?: number } = {},
): PruneUnreferencedChunksResult {
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? MAINTENANCE_STEP_TIME_BUDGET_MS;
  const batchRows = options.batchRows ?? CHUNK_PRUNE_BATCH_ROWS;
  const startedAt = now();
  const batchEnd = db.prepare(
    'SELECT content_hash AS hash FROM chunks WHERE content_hash > ? ORDER BY content_hash LIMIT 1 OFFSET ?',
  );
  const deleteRange = db.prepare(`
    DELETE FROM chunks
    WHERE content_hash > ? AND content_hash <= ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_chunks WHERE workspace_chunks.content_hash = chunks.content_hash
      )
  `);
  const deleteRest = db.prepare(`
    DELETE FROM chunks
    WHERE content_hash > ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_chunks WHERE workspace_chunks.content_hash = chunks.content_hash
      )
  `);

  let deleted = 0;
  let cursor = options.after ?? '';
  while (now() - startedAt < timeBudgetMs) {
    const end = batchEnd.get<{ hash: string }>(cursor, batchRows - 1)?.hash;
    if (!end) {
      return { deleted: deleted + deleteRest.run(cursor).changes, resumeAfter: null };
    }
    deleted += deleteRange.run(cursor, end).changes;
    cursor = end;
  }
  return { deleted, resumeAfter: cursor };
}

export function clearLegacyMerkleNodes(db: SqliteDriver): number {
  return db.prepare('DELETE FROM merkle_nodes').run().changes;
}

/**
 * Tidy the search index in bounded steps, returning true once nothing is left to
 * merge. Repeating FTS5's `merge` until it has no work reaches the same state as
 * `optimize`, which cannot be interrupted. A negative count starts that full
 * merge, and only the first call may use one: repeated, it would restart the
 * merge whenever indexing added to the index in between. A call that changes
 * fewer than two rows had no work to do.
 */
export function mergeSearchIndex(
  db: SqliteDriver,
  options: BoundedStepOptions & { mergeStarted?: boolean } = {},
): boolean {
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? MAINTENANCE_STEP_TIME_BUDGET_MS;
  const startedAt = now();
  const merge = db.prepare("INSERT INTO code_fts(code_fts, rank) VALUES('merge', ?)");
  const totalChanges = db.prepare('SELECT total_changes() AS changes');
  const changesSoFar = (): number => totalChanges.get<{ changes: number }>()?.changes ?? 0;

  let pages = options.mergeStarted ? SEARCH_MERGE_STEP_PAGES : -SEARCH_MERGE_STEP_PAGES;
  while (now() - startedAt < timeBudgetMs) {
    const before = changesSoFar();
    merge.run(pages);
    if (changesSoFar() - before < 2) return true;
    pages = SEARCH_MERGE_STEP_PAGES;
  }
  return false;
}

/** Pages released per incremental-vacuum step: 64 MiB at the default 4 KiB page size. */
export const INCREMENTAL_VACUUM_STEP_PAGES = 16_384;
/** Stop starting new vacuum steps after this long; later maintenance runs carry on. */
export const INCREMENTAL_VACUUM_TIME_BUDGET_MS = 60_000;
/** Pages per step in a clean-up burst: 4 MiB, which keeps a burst near its time budget. */
export const CLEANUP_BURST_VACUUM_STEP_PAGES = 1_024;

export interface VacuumFreelistOptions {
  stepPages?: number;
  timeBudgetMs?: number;
  now?: () => number;
  /**
   * Allow the one-off full VACUUM that converts a legacy database to
   * incremental mode. It rewrites the whole file and needs about its size in
   * spare disk, so only maintenance runs allow it, not the periodic reclaim.
   */
  allowFullVacuum?: boolean;
}

export interface VacuumFreelistResult {
  freedPages: number;
  remainingFreePages: number;
  stoppedReason:
    | 'done'
    | 'checkpoint-busy'
    | 'time-budget'
    | 'no-progress'
    | 'full-vacuum'
    | 'full-vacuum-needed'
    | 'not-incremental';
}

/**
 * Checkpoint and truncate the WAL. Returns false when another connection's
 * open read kept the checkpoint from completing. Does not wait for that read
 * to finish: the connection's busy timeout is lifted for the call, because
 * the worker is single-threaded and every RPC queues behind the wait.
 */
export function checkpointAndTruncateWal(db: SqliteDriver): boolean {
  const previousTimeout = Number(db.pragma('busy_timeout', { simple: true }) ?? 0);
  db.pragma('busy_timeout = 0');
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)');
    const row = Array.isArray(rows) ? rows[0] as { busy?: unknown } | undefined : undefined;
    return Number(row?.busy ?? 0) === 0;
  } finally {
    db.pragma(`busy_timeout = ${Number.isFinite(previousTimeout) ? previousTimeout : 0}`);
  }
}

/**
 * Release free pages in bounded steps, checkpointing after each one. Every
 * page a vacuum moves is written to the WAL first, and the main file only
 * shrinks once a checkpoint completes, so a single unbounded vacuum run while
 * another connection is reading parks the whole move in the WAL. That left a
 * 41 GB WAL beside a 97 GB file that was 83 GB free pages. A checkpoint is
 * tried before the first step and after every step, and the run stops at the
 * first busy one, so repeated runs against a long-lived reader add nothing to
 * the WAL and a reader that appears mid-run costs at most one step.
 */
export function vacuumFreelistPages(
  db: SqliteDriver,
  options: VacuumFreelistOptions = {},
): VacuumFreelistResult {
  const mode = Number(db.pragma('auto_vacuum', { simple: true }) ?? 0);
  if (mode === 0) {
    if (options.allowFullVacuum === false) {
      return { freedPages: 0, remainingFreePages: freelistCount(db), stoppedReason: 'full-vacuum-needed' };
    }
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    return { freedPages: 0, remainingFreePages: 0, stoppedReason: 'full-vacuum' };
  }
  if (mode !== 2) {
    // auto_vacuum = FULL releases free pages on every commit.
    return { freedPages: 0, remainingFreePages: 0, stoppedReason: 'not-incremental' };
  }

  const stepPages = Math.max(1, Math.floor(options.stepPages ?? INCREMENTAL_VACUUM_STEP_PAGES));
  const timeBudgetMs = options.timeBudgetMs ?? INCREMENTAL_VACUUM_TIME_BUDGET_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const initialFreePages = freelistCount(db);
  let remainingFreePages = initialFreePages;
  if (remainingFreePages > 0 && !checkpointAndTruncateWal(db)) {
    return { freedPages: 0, remainingFreePages, stoppedReason: 'checkpoint-busy' };
  }

  while (remainingFreePages > 0) {
    if (now() - startedAt >= timeBudgetMs) {
      return { freedPages: initialFreePages - remainingFreePages, remainingFreePages, stoppedReason: 'time-budget' };
    }
    db.pragma(`incremental_vacuum(${Math.min(stepPages, remainingFreePages)})`);
    const checkpointed = checkpointAndTruncateWal(db);
    const freeAfterStep = freelistCount(db);
    const progressed = freeAfterStep < remainingFreePages;
    remainingFreePages = freeAfterStep;
    if (!checkpointed) {
      return { freedPages: initialFreePages - remainingFreePages, remainingFreePages, stoppedReason: 'checkpoint-busy' };
    }
    if (!progressed) {
      return { freedPages: initialFreePages - remainingFreePages, remainingFreePages, stoppedReason: 'no-progress' };
    }
  }

  return { freedPages: initialFreePages - remainingFreePages, remainingFreePages, stoppedReason: 'done' };
}

function freelistCount(db: SqliteDriver): number {
  return Number(db.pragma('freelist_count', { simple: true }) ?? 0);
}
