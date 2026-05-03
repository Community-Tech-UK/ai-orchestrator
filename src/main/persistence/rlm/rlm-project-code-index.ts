import * as crypto from 'crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type {
  ProjectCodeIndexStatusRow,
  ProjectCodeSymbolRow,
} from '../rlm-database.types';
import type {
  ProjectCodeIndexRunStatus,
  ProjectCodeIndexStatus,
  ProjectCodeSymbol,
} from '../../../shared/types/knowledge-graph.types';

export const PROJECT_CODE_INDEX_SNAPSHOT_VERSION = 1;
export const PROJECT_CODE_INDEX_TIMEOUT_MS = 120_000;
export const PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT = 200;
export const PROJECT_CODE_INDEX_SIGNATURE_LIMIT = 500;
export const PROJECT_CODE_INDEX_DOC_COMMENT_LIMIT = 1_000;

export interface UpsertProjectCodeIndexStatusParams {
  projectKey: string;
  workspaceHash?: string | null;
  status: ProjectCodeIndexRunStatus;
  fileCount?: number;
  symbolCount?: number;
  syncStartedAt?: number | null;
  lastIndexedAt?: number | null;
  lastSyncedAt?: number | null;
  updatedAt?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectCodeSymbolInput {
  projectKey: string;
  sourceId: string;
  workspaceHash: string;
  symbolId: string;
  pathFromRoot: string;
  name: string;
  kind: string;
  containerName?: string | null;
  startLine: number;
  startCharacter: number;
  endLine?: number | null;
  endCharacter?: number | null;
  signature?: string | null;
  docComment?: string | null;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ListProjectCodeSymbolsOptions {
  limit?: number;
}

export function projectCodeSymbolId(projectKey: string, symbolId: string): string {
  return stableId('pcs', projectKey, symbolId);
}

export function projectCodeSymbolEvidenceId(projectKey: string, symbolId: string, sourceId: string): string {
  return stableId('pcse', projectKey, symbolId, sourceId);
}

export function upsertProjectCodeIndexStatus(
  db: SqliteDriver,
  params: UpsertProjectCodeIndexStatusParams,
): ProjectCodeIndexStatus {
  const existing = db.prepare(`
    SELECT * FROM project_code_index_status
    WHERE project_key = ?
  `).get(params.projectKey) as ProjectCodeIndexStatusRow | undefined;
  const now = params.updatedAt ?? Date.now();
  const metadata = {
    ...(existing ? parseRecord(existing.metadata_json) : {}),
    ...(params.metadata ?? {}),
    snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
  };

  db.prepare(`
    INSERT INTO project_code_index_status (
      project_key, workspace_hash, status, file_count, symbol_count,
      sync_started_at, last_indexed_at, last_synced_at, updated_at, error, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      workspace_hash = excluded.workspace_hash,
      status = excluded.status,
      file_count = excluded.file_count,
      symbol_count = excluded.symbol_count,
      sync_started_at = excluded.sync_started_at,
      last_indexed_at = excluded.last_indexed_at,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at,
      error = excluded.error,
      metadata_json = excluded.metadata_json
  `).run(
    params.projectKey,
    params.workspaceHash ?? existing?.workspace_hash ?? null,
    params.status,
    params.fileCount ?? existing?.file_count ?? 0,
    params.symbolCount ?? existing?.symbol_count ?? 0,
    params.syncStartedAt === undefined ? existing?.sync_started_at ?? null : params.syncStartedAt,
    params.lastIndexedAt === undefined ? existing?.last_indexed_at ?? null : params.lastIndexedAt,
    params.lastSyncedAt === undefined ? existing?.last_synced_at ?? null : params.lastSyncedAt,
    now,
    params.error === undefined ? existing?.error ?? null : params.error,
    JSON.stringify(metadata),
  );

  return mustGetStatus(db, params.projectKey);
}

export function getProjectCodeIndexStatus(
  db: SqliteDriver,
  projectKey: string,
  staleAfterMs = PROJECT_CODE_INDEX_TIMEOUT_MS,
): ProjectCodeIndexStatus {
  const row = db.prepare(`
    SELECT * FROM project_code_index_status
    WHERE project_key = ?
  `).get(projectKey) as ProjectCodeIndexStatusRow | undefined;

  if (!row) {
    return {
      projectKey,
      status: 'never',
      fileCount: 0,
      symbolCount: 0,
      updatedAt: 0,
      metadata: { snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION },
    };
  }

  return rowToStatus(row, staleAfterMs);
}

export function replaceProjectCodeSymbols(
  db: SqliteDriver,
  projectKey: string,
  symbols: ProjectCodeSymbolInput[],
): void {
  db.prepare('DELETE FROM project_code_symbols WHERE project_key = ?').run(projectKey);

  const insert = db.prepare(`
    INSERT INTO project_code_symbols (
      id, project_key, source_id, workspace_hash, symbol_id, path_from_root,
      name, kind, container_name, start_line, start_character, end_line,
      end_character, signature, doc_comment, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  for (const symbol of symbols) {
    const createdAt = symbol.createdAt ?? now;
    const updatedAt = symbol.updatedAt ?? now;
    insert.run(
      projectCodeSymbolId(projectKey, symbol.symbolId),
      projectKey,
      symbol.sourceId,
      symbol.workspaceHash,
      symbol.symbolId,
      symbol.pathFromRoot,
      symbol.name,
      symbol.kind,
      symbol.containerName ?? null,
      symbol.startLine,
      symbol.startCharacter,
      symbol.endLine ?? null,
      symbol.endCharacter ?? null,
      truncate(symbol.signature, PROJECT_CODE_INDEX_SIGNATURE_LIMIT),
      truncate(symbol.docComment, PROJECT_CODE_INDEX_DOC_COMMENT_LIMIT),
      createdAt,
      updatedAt,
      JSON.stringify({
        ...(symbol.metadata ?? {}),
        snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
      }),
    );
  }
}

export function listProjectCodeSymbols(
  db: SqliteDriver,
  projectKey: string,
  options: ListProjectCodeSymbolsOptions = {},
): ProjectCodeSymbol[] {
  const limit = clampLimit(options.limit ?? PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT);
  const rows = db.prepare(`
    SELECT * FROM project_code_symbols
    WHERE project_key = ?
    ORDER BY path_from_root ASC, start_line ASC, start_character ASC, name ASC
    LIMIT ?
  `).all(projectKey, limit) as ProjectCodeSymbolRow[];

  return rows.map(rowToSymbol);
}

export function getProjectCodeSymbol(
  db: SqliteDriver,
  projectKey: string,
  symbolId: string,
): ProjectCodeSymbol | undefined {
  const row = db.prepare(`
    SELECT * FROM project_code_symbols
    WHERE project_key = ? AND symbol_id = ?
  `).get(projectKey, symbolId) as ProjectCodeSymbolRow | undefined;

  return row ? rowToSymbol(row) : undefined;
}

export function countProjectCodeSymbols(db: SqliteDriver, projectKey: string): number {
  return (db.prepare(`
    SELECT COUNT(*) as count FROM project_code_symbols WHERE project_key = ?
  `).get(projectKey) as { count: number }).count;
}

function mustGetStatus(db: SqliteDriver, projectKey: string): ProjectCodeIndexStatus {
  const row = db.prepare(`
    SELECT * FROM project_code_index_status
    WHERE project_key = ?
  `).get(projectKey) as ProjectCodeIndexStatusRow | undefined;
  if (!row) {
    throw new Error(`Project code-index status not found: ${projectKey}`);
  }
  return rowToStatus(row, PROJECT_CODE_INDEX_TIMEOUT_MS);
}

function rowToStatus(row: ProjectCodeIndexStatusRow, staleAfterMs: number): ProjectCodeIndexStatus {
  const metadata = parseRecord(row.metadata_json);
  let status = parseStatus(row.status);
  let error = row.error ?? undefined;
  const now = Date.now();

  if (
    status === 'indexing'
    && row.sync_started_at !== null
    && now - row.sync_started_at > staleAfterMs
  ) {
    status = 'failed';
    error = error ?? 'Code index sync is stale after timing out.';
    metadata['reason'] = metadata['reason'] ?? 'stale_indexing';
    metadata['stale'] = true;
  }

  return {
    projectKey: row.project_key,
    workspaceHash: row.workspace_hash ?? undefined,
    status,
    fileCount: row.file_count,
    symbolCount: row.symbol_count,
    syncStartedAt: row.sync_started_at ?? undefined,
    lastIndexedAt: row.last_indexed_at ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    updatedAt: row.updated_at,
    error,
    metadata,
  };
}

function rowToSymbol(row: ProjectCodeSymbolRow): ProjectCodeSymbol {
  return {
    targetKind: 'code_symbol',
    targetId: row.symbol_id,
    id: row.id,
    projectKey: row.project_key,
    sourceId: row.source_id,
    workspaceHash: row.workspace_hash,
    symbolId: row.symbol_id,
    pathFromRoot: row.path_from_root,
    name: row.name,
    kind: row.kind,
    containerName: row.container_name ?? undefined,
    startLine: row.start_line,
    startCharacter: row.start_character,
    endLine: row.end_line ?? row.start_line,
    endCharacter: row.end_character ?? row.start_character,
    signature: row.signature ?? undefined,
    docComment: row.doc_comment ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseRecord(row.metadata_json),
    evidenceCount: 1,
  };
}

function parseStatus(value: string): ProjectCodeIndexRunStatus {
  if (
    value === 'never'
    || value === 'indexing'
    || value === 'ready'
    || value === 'failed'
    || value === 'disabled'
    || value === 'paused'
    || value === 'excluded'
  ) {
    return value;
  }
  return 'failed';
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(value), PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT));
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt metadata should not break project memory reads.
  }
  return {};
}
