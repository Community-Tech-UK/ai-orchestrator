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

export function pruneUnreferencedChunks(db: SqliteDriver): number {
  const result = db.prepare(`
    DELETE FROM chunks
    WHERE NOT EXISTS (
      SELECT 1
      FROM workspace_chunks
      WHERE workspace_chunks.content_hash = chunks.content_hash
    )
  `).run();
  return result.changes;
}

export function clearLegacyMerkleNodes(db: SqliteDriver): number {
  return db.prepare('DELETE FROM merkle_nodes').run().changes;
}

export function optimizeSearchIndex(db: SqliteDriver): void {
  db.prepare("INSERT INTO code_fts(code_fts) VALUES('optimize')").run();
}

/** Pages released per incremental-vacuum step: 64 MiB at the default 4 KiB page size. */
export const INCREMENTAL_VACUUM_STEP_PAGES = 16_384;
/** Stop starting new vacuum steps after this long; later maintenance runs carry on. */
export const INCREMENTAL_VACUUM_TIME_BUDGET_MS = 60_000;

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
