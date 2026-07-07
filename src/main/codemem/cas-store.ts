import { getLogger } from '../logging/logger';
import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  Chunk,
  WorkspaceManifestRow,
  WorkspaceSymbolKind,
  WorkspaceSymbolRecord,
  WorkspaceRoot,
  WorkspaceHash,
} from './types';
import {
  deleteWorkspaceIndex as deleteWorkspaceIndexFromDb,
  listWorkspaceIndexStats as listWorkspaceIndexStatsFromDb,
  type WorkspaceIndexStats,
} from './cas-workspace-index-maintenance';

const logger = getLogger('CasStore');

/**
 * Absolute backstop on how many symbol rows `listWorkspaceSymbols` will
 * materialize in one call. A pathologically large workspace can hold millions
 * of symbols; loading them all into a JS array at once can exhaust the heap and
 * abort the process. Callers that enforce their own (lower) ceiling should
 * count first via `countWorkspaceSymbols`; this cap only guarantees a stray
 * unbounded read degrades to "first N" instead of crashing. Set comfortably
 * above PROJECT_CODE_INDEX_MAX_SYMBOLS (100k) so legitimate reads are unaffected.
 */
const ABSOLUTE_MAX_WORKSPACE_SYMBOL_ROWS = 250_000;

interface ChunkRow {
  content_hash: string;
  ast_normalized_hash: string;
  language: string;
  chunk_type: Chunk['chunkType'];
  name: string;
  signature: string | null;
  doc_comment: string | null;
  symbols_json: string;
  imports_json: string;
  exports_json: string;
  raw_text: string;
}

interface WorkspaceManifestRowRecord {
  workspace_hash: string;
  path_from_root: string;
  content_hash: string;
  merkle_leaf_hash: string;
  mtime: number;
}

interface WorkspaceRootRow {
  workspace_hash: string;
  abs_path: string;
  head_commit: string | null;
  primary_language: string | null;
  last_indexed_at: number;
  merkle_root_hash: string | null;
  pagerank_json: string | null;
}

interface WorkspaceSymbolRow {
  workspace_hash: string;
  symbol_id: string;
  path_from_root: string;
  name: string;
  kind: WorkspaceSymbolKind;
  container_name: string | null;
  start_line: number;
  start_character: number;
  end_line: number | null;
  end_character: number | null;
  signature: string | null;
  doc_comment: string | null;
}

interface WorkspaceChunkRow {
  id: number;
  workspace_hash: string;
  path_from_root: string;
  chunk_index: number;
  content_hash: string;
  start_line: number;
  end_line: number;
  language: string;
  chunk_type: Chunk['chunkType'];
  name: string;
  updated_at: number;
}

interface WorkspaceChunkSearchRow {
  rowid: number;
  workspace_hash: string;
  path_from_root: string;
  content_hash: string;
  start_line: number;
  end_line: number;
  language: string;
  chunk_type: Chunk['chunkType'];
  name: string;
  score: number;
}

interface CodeIndexStatusRow {
  workspace_hash: string;
  abs_path: string;
  state: CodeIndexStatusRecord['state'];
  phase: CodeIndexStatusRecord['phase'];
  total_files: number;
  processed_files: number;
  total_chunks: number;
  processed_chunks: number;
  current_path: string | null;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  error_message: string | null;
  cancel_requested: number;
}

export interface WorkspaceChunkRecord {
  id?: number;
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  chunkIndex: number;
  contentHash: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: Chunk['chunkType'];
  name: string;
  updatedAt: number;
}

export interface WorkspaceChunkSearchResult {
  rowid: number;
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: Chunk['chunkType'];
  name: string;
  score: number;
}

export interface CodeIndexStatusRecord {
  workspaceHash: WorkspaceHash;
  absPath: string;
  state: 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  phase: 'none' | 'scanning' | 'chunking' | 'fts' | 'watching';
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentPath: string | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  errorMessage: string | null;
  cancelRequested: boolean;
}

export class CasStore {
  constructor(private readonly db: SqliteDriver) {}

  upsertChunk(chunk: Chunk): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO chunks (
        content_hash,
        ast_normalized_hash,
        language,
        chunk_type,
        name,
        signature,
        doc_comment,
        symbols_json,
        imports_json,
        exports_json,
        raw_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunk.contentHash,
      chunk.astNormalizedHash,
      chunk.language,
      chunk.chunkType,
      chunk.name,
      chunk.signature,
      chunk.docComment,
      chunk.symbolsJson,
      chunk.importsJson,
      chunk.exportsJson,
      chunk.rawText,
    );
  }

  getChunk(contentHash: string): Chunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE content_hash = ?')
      .get(contentHash) as ChunkRow | undefined;
    if (!row) {
      return null;
    }
    return {
      contentHash: row.content_hash,
      astNormalizedHash: row.ast_normalized_hash,
      language: row.language,
      chunkType: row.chunk_type,
      name: row.name,
      signature: row.signature,
      docComment: row.doc_comment,
      symbolsJson: row.symbols_json,
      importsJson: row.imports_json,
      exportsJson: row.exports_json,
      rawText: row.raw_text,
    };
  }

  upsertManifestEntry(entry: WorkspaceManifestRow): void {
    this.db.prepare(`
      INSERT INTO workspace_manifest (
        workspace_hash,
        path_from_root,
        content_hash,
        merkle_leaf_hash,
        mtime
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash, path_from_root) DO UPDATE SET
        content_hash = excluded.content_hash,
        merkle_leaf_hash = excluded.merkle_leaf_hash,
        mtime = excluded.mtime
    `).run(
      entry.workspaceHash,
      entry.pathFromRoot,
      entry.contentHash,
      entry.merkleLeafHash,
      entry.mtime,
    );
  }

  countManifestEntries(workspaceHash: WorkspaceHash): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM workspace_manifest WHERE workspace_hash = ?',
    ).get(workspaceHash) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listManifestEntries(
    workspaceHash: WorkspaceHash,
    options: { limit?: number; offset?: number } = {},
  ): WorkspaceManifestRow[] {
    const params: (string | number)[] = [workspaceHash];
    let sql = 'SELECT * FROM workspace_manifest WHERE workspace_hash = ? ORDER BY path_from_root ASC';

    if (options.limit !== undefined) {
      const limit = Math.max(1, Math.floor(options.limit));
      sql += ' LIMIT ?';
      params.push(limit);
      if (options.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(Math.max(0, Math.floor(options.offset)));
      }
    }

    return (this.db.prepare(sql)
      .all(...params) as WorkspaceManifestRowRecord[])
      .map((row) => ({
        workspaceHash: row.workspace_hash,
        pathFromRoot: row.path_from_root,
        contentHash: row.content_hash,
        merkleLeafHash: row.merkle_leaf_hash,
        mtime: row.mtime,
      }));
  }

  deleteManifestEntry(workspaceHash: WorkspaceHash, pathFromRoot: string): void {
    this.db.prepare('DELETE FROM workspace_manifest WHERE workspace_hash = ? AND path_from_root = ?')
      .run(workspaceHash, pathFromRoot);
  }

  upsertWorkspaceRoot(workspaceRoot: WorkspaceRoot): void {
    this.db.prepare(`
      INSERT INTO workspace_root (
        workspace_hash,
        abs_path,
        head_commit,
        primary_language,
        last_indexed_at,
        merkle_root_hash,
        pagerank_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash) DO UPDATE SET
        abs_path = excluded.abs_path,
        head_commit = excluded.head_commit,
        primary_language = excluded.primary_language,
        last_indexed_at = excluded.last_indexed_at,
        merkle_root_hash = excluded.merkle_root_hash,
        pagerank_json = excluded.pagerank_json
    `).run(
      workspaceRoot.workspaceHash,
      workspaceRoot.absPath,
      workspaceRoot.headCommit,
      workspaceRoot.primaryLanguage,
      workspaceRoot.lastIndexedAt,
      workspaceRoot.merkleRootHash,
      workspaceRoot.pagerankJson,
    );
  }

  getWorkspaceRoot(workspaceHash: WorkspaceHash): WorkspaceRoot | null {
    const row = this.db.prepare('SELECT * FROM workspace_root WHERE workspace_hash = ?')
      .get(workspaceHash) as WorkspaceRootRow | undefined;
    if (!row) {
      return null;
    }
    return {
      workspaceHash: row.workspace_hash,
      absPath: row.abs_path,
      headCommit: row.head_commit,
      primaryLanguage: row.primary_language,
      lastIndexedAt: row.last_indexed_at,
      merkleRootHash: row.merkle_root_hash,
      pagerankJson: row.pagerank_json,
    };
  }

  getWorkspaceRootByPath(absPath: string): WorkspaceRoot | null {
    const row = this.db.prepare('SELECT * FROM workspace_root WHERE abs_path = ?')
      .get(absPath) as WorkspaceRootRow | undefined;
    return row ? this.mapWorkspaceRoot(row) : null;
  }

  listWorkspaceRoots(): WorkspaceRoot[] {
    return (this.db.prepare('SELECT * FROM workspace_root ORDER BY abs_path ASC').all() as WorkspaceRootRow[])
      .map((row) => this.mapWorkspaceRoot(row));
  }

  replaceWorkspaceSymbolsForFile(
    workspaceHash: WorkspaceHash,
    pathFromRoot: string,
    symbols: WorkspaceSymbolRecord[],
  ): void {
    const deleteStmt = this.db.prepare(
      'DELETE FROM workspace_symbols WHERE workspace_hash = ? AND path_from_root = ?',
    );
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO workspace_symbols (
        workspace_hash,
        symbol_id,
        path_from_root,
        name,
        kind,
        container_name,
        start_line,
        start_character,
        end_line,
        end_character,
        signature,
        doc_comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((rows: WorkspaceSymbolRecord[]) => {
      deleteStmt.run(workspaceHash, pathFromRoot);
      for (const symbol of rows) {
        insertStmt.run(
          symbol.workspaceHash,
          symbol.symbolId,
          symbol.pathFromRoot,
          symbol.name,
          symbol.kind,
          symbol.containerName,
          symbol.startLine,
          symbol.startCharacter,
          symbol.endLine,
          symbol.endCharacter,
          symbol.signature,
          symbol.docComment,
        );
      }
    });

    transaction(symbols);
  }

  deleteWorkspaceSymbolsForFile(workspaceHash: WorkspaceHash, pathFromRoot: string): void {
    this.db.prepare(
      'DELETE FROM workspace_symbols WHERE workspace_hash = ? AND path_from_root = ?',
    ).run(workspaceHash, pathFromRoot);
  }

  getWorkspaceSymbol(workspaceHash: WorkspaceHash, symbolId: string): WorkspaceSymbolRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM workspace_symbols WHERE workspace_hash = ? AND symbol_id = ?',
    ).get(workspaceHash, symbolId) as WorkspaceSymbolRow | undefined;
    return row ? this.mapWorkspaceSymbol(row) : null;
  }

  /** Cheap symbol-row count for a workspace — lets callers enforce a ceiling
   *  without materializing (and OOM-ing on) the full symbol set first. */
  countWorkspaceSymbols(workspaceHash: WorkspaceHash): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM workspace_symbols WHERE workspace_hash = ?',
    ).get(workspaceHash) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listWorkspaceSymbols(workspaceHash: WorkspaceHash): WorkspaceSymbolRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM workspace_symbols WHERE workspace_hash = ? ' +
      'ORDER BY path_from_root, start_line, start_character LIMIT ?',
    ).all(workspaceHash, ABSOLUTE_MAX_WORKSPACE_SYMBOL_ROWS) as WorkspaceSymbolRow[];
    if (rows.length === ABSOLUTE_MAX_WORKSPACE_SYMBOL_ROWS) {
      logger.warn(
        `listWorkspaceSymbols(${workspaceHash}) hit the ${ABSOLUTE_MAX_WORKSPACE_SYMBOL_ROWS}-row ` +
        `cap; result truncated. Enforce a lower ceiling via countWorkspaceSymbols.`,
      );
    }
    return rows.map((row) => this.mapWorkspaceSymbol(row));
  }

  searchWorkspaceSymbols(
    workspaceHash: WorkspaceHash,
    query: string,
    options: { kind?: WorkspaceSymbolKind; limit?: number } = {},
  ): WorkspaceSymbolRecord[] {
    const normalizedQuery = query.trim().toLowerCase();
    const likeQuery = normalizedQuery.length === 0 ? '%' : `%${normalizedQuery}%`;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const rows = this.db.prepare(`
      SELECT *
      FROM workspace_symbols
      WHERE workspace_hash = ?
        AND LOWER(name) LIKE ?
        AND (? IS NULL OR kind = ?)
      ORDER BY
        CASE
          WHEN LOWER(name) = ? THEN 0
          WHEN LOWER(name) LIKE ? THEN 1
          ELSE 2
        END,
        LENGTH(name),
        path_from_root,
        start_line
      LIMIT ?
    `).all(
      workspaceHash,
      likeQuery,
      options.kind ?? null,
      options.kind ?? null,
      normalizedQuery,
      `${normalizedQuery}%`,
      limit,
    ) as WorkspaceSymbolRow[];

    return rows.map((row) => this.mapWorkspaceSymbol(row));
  }

  replaceWorkspaceChunksForFile(
    workspaceHash: WorkspaceHash,
    pathFromRoot: string,
    chunks: WorkspaceChunkRecord[],
  ): void {
    const existingStmt = this.db.prepare(
      'SELECT id FROM workspace_chunks WHERE workspace_hash = ? AND path_from_root = ?',
    );
    const deleteFtsStmt = this.db.prepare('DELETE FROM code_fts WHERE rowid = ?');
    const deleteChunksStmt = this.db.prepare(
      'DELETE FROM workspace_chunks WHERE workspace_hash = ? AND path_from_root = ?',
    );
    const insertChunkStmt = this.db.prepare(`
      INSERT INTO workspace_chunks (
        workspace_hash,
        path_from_root,
        chunk_index,
        content_hash,
        start_line,
        end_line,
        language,
        chunk_type,
        name,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFtsStmt = this.db.prepare(`
      INSERT INTO code_fts(rowid, content, symbols)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction((rows: WorkspaceChunkRecord[]) => {
      const existingRows = existingStmt.all(workspaceHash, pathFromRoot) as Array<{ id: number }>;
      for (const row of existingRows) {
        deleteFtsStmt.run(row.id);
      }
      deleteChunksStmt.run(workspaceHash, pathFromRoot);

      for (const chunk of rows) {
        const result = insertChunkStmt.run(
          workspaceHash,
          pathFromRoot,
          chunk.chunkIndex,
          chunk.contentHash,
          chunk.startLine,
          chunk.endLine,
          chunk.language,
          chunk.chunkType,
          chunk.name,
          chunk.updatedAt,
        );
        const storedChunk = this.getChunk(chunk.contentHash);
        insertFtsStmt.run(
          result.lastInsertRowid,
          storedChunk?.rawText ?? '',
          this.buildFtsSymbolsText(storedChunk, chunk.name),
        );
      }
    });

    transaction(chunks);
  }

  searchWorkspaceChunks(
    workspaceHash: WorkspaceHash,
    query: string,
    limit: number,
  ): WorkspaceChunkSearchResult[] {
    const ftsQuery = this.toFtsQuery(query);
    if (!ftsQuery) return [];
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const rows = this.db.prepare(`
      SELECT
        f.rowid,
        wc.workspace_hash,
        wc.path_from_root,
        wc.content_hash,
        wc.start_line,
        wc.end_line,
        wc.language,
        wc.chunk_type,
        wc.name,
        bm25(code_fts) AS score
      FROM code_fts f
      JOIN workspace_chunks wc ON wc.id = f.rowid
      WHERE code_fts MATCH ?
        AND wc.workspace_hash = ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, workspaceHash, boundedLimit) as WorkspaceChunkSearchRow[];

    return rows.map((row) => ({
      rowid: row.rowid,
      workspaceHash: row.workspace_hash,
      pathFromRoot: row.path_from_root,
      contentHash: row.content_hash,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
      chunkType: row.chunk_type,
      name: row.name,
      score: row.score,
    }));
  }

  deleteWorkspaceChunksForFile(workspaceHash: WorkspaceHash, pathFromRoot: string): void {
    const existingStmt = this.db.prepare(
      'SELECT id FROM workspace_chunks WHERE workspace_hash = ? AND path_from_root = ?',
    );
    const deleteFtsStmt = this.db.prepare('DELETE FROM code_fts WHERE rowid = ?');
    const deleteChunksStmt = this.db.prepare(
      'DELETE FROM workspace_chunks WHERE workspace_hash = ? AND path_from_root = ?',
    );
    const transaction = this.db.transaction(() => {
      const existingRows = existingStmt.all(workspaceHash, pathFromRoot) as Array<{ id: number }>;
      for (const row of existingRows) {
        deleteFtsStmt.run(row.id);
      }
      deleteChunksStmt.run(workspaceHash, pathFromRoot);
    });
    transaction();
  }

  listWorkspaceIndexStats(): WorkspaceIndexStats[] {
    return listWorkspaceIndexStatsFromDb(this.db);
  }

  deleteWorkspaceIndex(workspaceHash: WorkspaceHash): void {
    deleteWorkspaceIndexFromDb(this.db, workspaceHash);
  }

  upsertIndexStatus(status: CodeIndexStatusRecord): void {
    this.db.prepare(`
      INSERT INTO code_index_status (
        workspace_hash,
        abs_path,
        state,
        phase,
        total_files,
        processed_files,
        total_chunks,
        processed_chunks,
        current_path,
        started_at,
        updated_at,
        completed_at,
        error_message,
        cancel_requested
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash) DO UPDATE SET
        abs_path = excluded.abs_path,
        state = excluded.state,
        phase = excluded.phase,
        total_files = excluded.total_files,
        processed_files = excluded.processed_files,
        total_chunks = excluded.total_chunks,
        processed_chunks = excluded.processed_chunks,
        current_path = excluded.current_path,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        error_message = excluded.error_message,
        cancel_requested = excluded.cancel_requested
    `).run(
      status.workspaceHash,
      status.absPath,
      status.state,
      status.phase,
      status.totalFiles,
      status.processedFiles,
      status.totalChunks,
      status.processedChunks,
      status.currentPath,
      status.startedAt,
      status.updatedAt,
      status.completedAt,
      status.errorMessage,
      status.cancelRequested ? 1 : 0,
    );
  }

  getIndexStatus(workspaceHash: WorkspaceHash): CodeIndexStatusRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM code_index_status WHERE workspace_hash = ?',
    ).get(workspaceHash) as CodeIndexStatusRow | undefined;
    return row ? this.mapIndexStatus(row) : null;
  }

  requestCancel(workspaceHash: WorkspaceHash): void {
    this.db.prepare(
      'UPDATE code_index_status SET cancel_requested = 1, updated_at = ? WHERE workspace_hash = ?',
    ).run(Date.now(), workspaceHash);
  }

  clearCancel(workspaceHash: WorkspaceHash): void {
    this.db.prepare(
      'UPDATE code_index_status SET cancel_requested = 0, updated_at = ? WHERE workspace_hash = ?',
    ).run(Date.now(), workspaceHash);
  }

  isCancelRequested(workspaceHash: WorkspaceHash): boolean {
    const row = this.db.prepare(
      'SELECT cancel_requested FROM code_index_status WHERE workspace_hash = ?',
    ).get(workspaceHash) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  private mapWorkspaceRoot(row: WorkspaceRootRow): WorkspaceRoot {
    return {
      workspaceHash: row.workspace_hash,
      absPath: row.abs_path,
      headCommit: row.head_commit,
      primaryLanguage: row.primary_language,
      lastIndexedAt: row.last_indexed_at,
      merkleRootHash: row.merkle_root_hash,
      pagerankJson: row.pagerank_json,
    };
  }

  private mapWorkspaceSymbol(row: WorkspaceSymbolRow): WorkspaceSymbolRecord {
    return {
      workspaceHash: row.workspace_hash,
      symbolId: row.symbol_id,
      pathFromRoot: row.path_from_root,
      name: row.name,
      kind: row.kind,
      containerName: row.container_name,
      startLine: row.start_line,
      startCharacter: row.start_character,
      endLine: row.end_line,
      endCharacter: row.end_character,
      signature: row.signature,
      docComment: row.doc_comment,
    };
  }

  private mapIndexStatus(row: CodeIndexStatusRow): CodeIndexStatusRecord {
    return {
      workspaceHash: row.workspace_hash,
      absPath: row.abs_path,
      state: row.state,
      phase: row.phase,
      totalFiles: row.total_files,
      processedFiles: row.processed_files,
      totalChunks: row.total_chunks,
      processedChunks: row.processed_chunks,
      currentPath: row.current_path,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      cancelRequested: row.cancel_requested === 1,
    };
  }

  private buildFtsSymbolsText(chunk: Chunk | null, name: string): string {
    if (!chunk) return name;
    return [name, this.identifierTerms(name), chunk.symbolsJson, this.identifierTerms(chunk.symbolsJson),
      chunk.importsJson, this.identifierTerms(chunk.importsJson), chunk.exportsJson,
      this.identifierTerms(chunk.exportsJson)].join(' ');
  }

  private identifierTerms(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .split(/[^A-Za-z0-9]+/)
      .filter((term) => term.length > 0)
      .join(' ');
  }

  private toFtsQuery(query: string): string {
    return query
      .split(/[^A-Za-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .slice(0, 12)
      .join(' ');
  }
}
