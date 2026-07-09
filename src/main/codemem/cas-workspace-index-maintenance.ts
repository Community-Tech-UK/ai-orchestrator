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

export function vacuumFreelistPages(db: SqliteDriver): void {
  const mode = Number(db.pragma('auto_vacuum', { simple: true }) ?? 0);
  if (mode === 0) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    return;
  }
  if (mode !== 2) {
    return;
  }
  db.pragma('incremental_vacuum');
}
