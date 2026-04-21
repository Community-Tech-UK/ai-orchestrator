import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  Chunk,
  MerkleNode,
  WorkspaceManifestRow,
  WorkspaceSymbolKind,
  WorkspaceSymbolRecord,
  WorkspaceRoot,
  WorkspaceHash,
} from './types';

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

interface MerkleNodeRow {
  node_hash: string;
  kind: MerkleNode['kind'];
  children_json: string;
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

  upsertMerkleNode(node: MerkleNode): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO merkle_nodes (node_hash, kind, children_json)
      VALUES (?, ?, ?)
    `).run(node.nodeHash, node.kind, node.childrenJson);
  }

  getMerkleNode(nodeHash: string): MerkleNode | null {
    const row = this.db.prepare('SELECT * FROM merkle_nodes WHERE node_hash = ?')
      .get(nodeHash) as MerkleNodeRow | undefined;
    if (!row) {
      return null;
    }
    return {
      nodeHash: row.node_hash,
      kind: row.kind,
      childrenJson: row.children_json,
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

  listManifestEntries(workspaceHash: WorkspaceHash): WorkspaceManifestRow[] {
    return (this.db.prepare('SELECT * FROM workspace_manifest WHERE workspace_hash = ?')
      .all(workspaceHash) as WorkspaceManifestRowRecord[])
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
      INSERT INTO workspace_symbols (
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

  listWorkspaceSymbols(workspaceHash: WorkspaceHash): WorkspaceSymbolRecord[] {
    return (this.db.prepare(
      'SELECT * FROM workspace_symbols WHERE workspace_hash = ? ORDER BY path_from_root, start_line, start_character',
    ).all(workspaceHash) as WorkspaceSymbolRow[]).map((row) => this.mapWorkspaceSymbol(row));
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
}
