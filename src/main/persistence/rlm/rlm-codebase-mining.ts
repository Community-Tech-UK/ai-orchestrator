import type { SqliteDriver } from '../../db/sqlite-driver';
import type { CodebaseMiningStatusRow } from '../rlm-database.types';
import type {
  CodebaseMiningFileSnapshot,
  CodebaseMiningResult,
  CodebaseMiningStatus,
  ProjectDiscoverySource,
} from '../../../shared/types/knowledge-graph.types';

export interface EnsureProjectRootParams {
  normalizedPath: string;
  rootPath: string;
  projectKey: string;
  displayName: string;
  discoverySource: ProjectDiscoverySource;
  autoMine?: boolean;
  lastActiveAt: number;
}

interface CompleteMiningParams {
  normalizedPath: string;
  contentFingerprint: string;
  files: CodebaseMiningFileSnapshot[];
  factsExtracted: number;
  hintsCreated: number;
  filesRead: number;
  errors: string[];
  startedAt: number;
  completedAt: number;
}

interface FailMiningParams {
  normalizedPath: string;
  contentFingerprint: string;
  files: CodebaseMiningFileSnapshot[];
  filesRead: number;
  errors: string[];
  startedAt: number;
  completedAt: number;
}

// Normal mining flow registers roots before begin/complete/fail writes. The
// INSERT fallbacks below are for defensive direct calls; ON CONFLICT paths
// intentionally preserve existing registry metadata and pause/exclude flags.
export function ensureProjectRoot(db: SqliteDriver, params: EnsureProjectRootParams): CodebaseMiningStatus {
  const autoMineValue = params.autoMine === false ? 0 : 1;
  const autoMineExplicit = params.autoMine === undefined ? 0 : 1;

  db.prepare(`
    INSERT INTO codebase_mining_status (
      normalized_path, root_path, project_key, display_name, discovery_source,
      auto_mine, is_paused, is_excluded, status, files_json, errors_json,
      last_active_at, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'never', '[]', '[]', ?, ?, ?, '{}')
    ON CONFLICT(normalized_path) DO UPDATE SET
      display_name = excluded.display_name,
      auto_mine = CASE
        WHEN ? = 1 THEN excluded.auto_mine
        ELSE codebase_mining_status.auto_mine
      END,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `).run(
    params.normalizedPath,
    params.rootPath,
    params.projectKey,
    params.displayName,
    params.discoverySource,
    autoMineValue,
    params.lastActiveAt,
    params.lastActiveAt,
    params.lastActiveAt,
    autoMineExplicit,
  );

  const status = getMiningStatus(db, params.normalizedPath);
  if (!status) {
    throw new Error(`Failed to register project root: ${params.normalizedPath}`);
  }
  return status;
}

export function listProjectRoots(db: SqliteDriver): CodebaseMiningStatus[] {
  const rows = db.prepare(`
    SELECT * FROM codebase_mining_status
    ORDER BY COALESCE(last_active_at, updated_at) DESC, normalized_path ASC
  `).all() as CodebaseMiningStatusRow[];

  return rows.map(rowToStatus);
}

export function pauseProjectRoot(
  db: SqliteDriver,
  normalizedPath: string,
  updatedAt: number,
): CodebaseMiningStatus | undefined {
  db.prepare(`
    UPDATE codebase_mining_status
    SET is_paused = 1, updated_at = ?
    WHERE normalized_path = ?
  `).run(updatedAt, normalizedPath);
  return getMiningStatus(db, normalizedPath);
}

export function resumeProjectRoot(
  db: SqliteDriver,
  normalizedPath: string,
  updatedAt: number,
): CodebaseMiningStatus | undefined {
  db.prepare(`
    UPDATE codebase_mining_status
    SET is_paused = 0, updated_at = ?
    WHERE normalized_path = ?
  `).run(updatedAt, normalizedPath);
  return getMiningStatus(db, normalizedPath);
}

export function excludeProjectRoot(
  db: SqliteDriver,
  normalizedPath: string,
  updatedAt: number,
): CodebaseMiningStatus | undefined {
  db.prepare(`
    UPDATE codebase_mining_status
    SET is_excluded = 1, updated_at = ?
    WHERE normalized_path = ?
  `).run(updatedAt, normalizedPath);
  return getMiningStatus(db, normalizedPath);
}

export function getMiningStatus(db: SqliteDriver, normalizedPath: string): CodebaseMiningStatus | undefined {
  const row = db.prepare(`
    SELECT * FROM codebase_mining_status
    WHERE normalized_path = ?
  `).get(normalizedPath) as CodebaseMiningStatusRow | undefined;

  return row ? rowToStatus(row) : undefined;
}

export function getMiningResult(db: SqliteDriver, normalizedPath: string): CodebaseMiningResult | undefined {
  const status = getMiningStatus(db, normalizedPath);
  if (!status || status.status === 'never') {
    return undefined;
  }

  return {
    normalizedPath: status.normalizedPath,
    rootPath: status.rootPath,
    projectKey: status.projectKey,
    displayName: status.displayName,
    discoverySource: status.discoverySource,
    autoMine: status.autoMine,
    isPaused: status.isPaused,
    isExcluded: status.isExcluded,
    status: status.status,
    factsExtracted: status.factsExtracted ?? 0,
    hintsCreated: status.hintsCreated ?? 0,
    filesRead: status.filesRead ?? 0,
    errors: status.errors ?? [],
    contentFingerprint: status.contentFingerprint,
    lastMinedAt: status.completedAt,
  };
}

export function beginMining(
  db: SqliteDriver,
  normalizedPath: string,
  contentFingerprint: string,
  files: CodebaseMiningFileSnapshot[],
  startedAt: number,
): void {
  db.prepare(`
    INSERT INTO codebase_mining_status (
      normalized_path, root_path, project_key, display_name, discovery_source,
      auto_mine, is_paused, is_excluded, status, content_fingerprint, files_json,
      facts_extracted, hints_created, files_read, errors_json,
      started_at, completed_at, last_active_at, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, 'manual', 1, 0, 0, 'running', ?, ?, 0, 0, ?, '[]', ?, NULL, ?, ?, ?, '{}')
    ON CONFLICT(normalized_path) DO UPDATE SET
      status = 'running',
      content_fingerprint = excluded.content_fingerprint,
      files_json = excluded.files_json,
      files_read = excluded.files_read,
      errors_json = '[]',
      started_at = excluded.started_at,
      completed_at = NULL,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `).run(
    normalizedPath,
    normalizedPath,
    normalizedPath,
    normalizedPath,
    contentFingerprint,
    JSON.stringify(files),
    files.length,
    startedAt,
    startedAt,
    startedAt,
    startedAt,
  );
}

export function completeMining(db: SqliteDriver, params: CompleteMiningParams): void {
  db.prepare(`
    INSERT INTO codebase_mining_status (
      normalized_path, root_path, project_key, display_name, discovery_source,
      auto_mine, is_paused, is_excluded, status, content_fingerprint, files_json,
      facts_extracted, hints_created, files_read, errors_json,
      started_at, completed_at, last_active_at, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, 'manual', 1, 0, 0, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(normalized_path) DO UPDATE SET
      status = 'completed',
      content_fingerprint = excluded.content_fingerprint,
      files_json = excluded.files_json,
      facts_extracted = excluded.facts_extracted,
      hints_created = excluded.hints_created,
      files_read = excluded.files_read,
      errors_json = excluded.errors_json,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `).run(
    params.normalizedPath,
    params.normalizedPath,
    params.normalizedPath,
    params.normalizedPath,
    params.contentFingerprint,
    JSON.stringify(params.files),
    params.factsExtracted,
    params.hintsCreated,
    params.filesRead,
    JSON.stringify(params.errors),
    params.startedAt,
    params.completedAt,
    params.completedAt,
    params.startedAt,
    params.completedAt,
  );
}

export function failMining(db: SqliteDriver, params: FailMiningParams): void {
  db.prepare(`
    INSERT INTO codebase_mining_status (
      normalized_path, root_path, project_key, display_name, discovery_source,
      auto_mine, is_paused, is_excluded, status, content_fingerprint, files_json,
      facts_extracted, hints_created, files_read, errors_json,
      started_at, completed_at, last_active_at, created_at, updated_at, metadata_json
    )
    VALUES (?, ?, ?, ?, 'manual', 1, 0, 0, 'failed', ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(normalized_path) DO UPDATE SET
      status = 'failed',
      content_fingerprint = excluded.content_fingerprint,
      files_json = excluded.files_json,
      files_read = excluded.files_read,
      errors_json = excluded.errors_json,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `).run(
    params.normalizedPath,
    params.normalizedPath,
    params.normalizedPath,
    params.normalizedPath,
    params.contentFingerprint,
    JSON.stringify(params.files),
    params.filesRead,
    JSON.stringify(params.errors),
    params.startedAt,
    params.completedAt,
    params.completedAt,
    params.startedAt,
    params.completedAt,
  );
}

function rowToStatus(row: CodebaseMiningStatusRow): CodebaseMiningStatus {
  const status = isKnownStatus(row.status) ? row.status : 'failed';

  return {
    normalizedPath: row.normalized_path,
    rootPath: row.root_path,
    projectKey: row.project_key,
    displayName: row.display_name,
    discoverySource: parseDiscoverySource(row.discovery_source),
    autoMine: row.auto_mine !== 0,
    isPaused: row.is_paused !== 0,
    isExcluded: row.is_excluded !== 0,
    mined: status === 'completed',
    status,
    contentFingerprint: row.content_fingerprint ?? undefined,
    filesRead: row.files_read,
    factsExtracted: row.facts_extracted,
    hintsCreated: row.hints_created,
    errors: parseJsonArray(row.errors_json),
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastActiveAt: row.last_active_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isKnownStatus(value: string): value is CodebaseMiningStatus['status'] {
  return value === 'never' || value === 'running' || value === 'completed' || value === 'failed';
}

function parseDiscoverySource(value: string): ProjectDiscoverySource {
  if (
    value === 'manual'
    || value === 'manual-browse'
    || value === 'default-working-directory'
    || value === 'instance-working-directory'
  ) {
    return value;
  }
  return 'manual';
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // Corrupt status metadata should not break the Knowledge page.
  }
  return [];
}
