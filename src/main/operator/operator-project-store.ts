import { createHash } from 'crypto';
import * as path from 'path';
import type {
  OperatorProjectListQuery,
  OperatorProjectRecord,
  OperatorProjectRemote,
  OperatorProjectScanRootRecord,
  OperatorProjectUpsertInput,
} from '../../shared/types/operator.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';

const logger = getLogger('OperatorProjectStore');

interface ProjectRow {
  id: string;
  canonical_path: string;
  display_name: string;
  source: OperatorProjectRecord['source'];
  git_root: string | null;
  remotes_json: string;
  current_branch: string | null;
  is_pinned: number;
  last_seen_at: number;
  last_accessed_at: number | null;
  metadata_json: string;
}

interface AliasRow {
  alias: string;
}

interface ScanRootRow {
  root_path: string;
  last_scanned_at: number;
  metadata_json: string;
}

export class OperatorProjectStore {
  constructor(private readonly db: SqliteDriver) {}

  upsertProject(input: OperatorProjectUpsertInput): OperatorProjectRecord {
    const now = Date.now();
    const canonicalPath = input.canonicalPath;
    const existing = this.findProjectByPath(canonicalPath);
    const id = existing?.id ?? createProjectId(canonicalPath);
    const aliases = dedupeStrings([
      input.displayName,
      ...(input.aliases ?? []),
      ...(existing?.aliases ?? []),
    ]);

    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO operator_projects (
          id, canonical_path, display_name, source, git_root, remotes_json,
          current_branch, is_pinned, last_seen_at, last_accessed_at, metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_path) DO UPDATE SET
          display_name = excluded.display_name,
          source = excluded.source,
          git_root = excluded.git_root,
          remotes_json = excluded.remotes_json,
          current_branch = excluded.current_branch,
          is_pinned = CASE
            WHEN operator_projects.is_pinned = 1 THEN 1
            ELSE excluded.is_pinned
          END,
          last_seen_at = excluded.last_seen_at,
          last_accessed_at = COALESCE(excluded.last_accessed_at, operator_projects.last_accessed_at),
          metadata_json = excluded.metadata_json
      `).run(
        id,
        canonicalPath,
        input.displayName,
        input.source,
        input.gitRoot ?? null,
        stringifyJsonArray(input.remotes ?? []),
        input.currentBranch ?? null,
        input.isPinned ? 1 : 0,
        input.lastSeenAt ?? now,
        input.lastAccessedAt ?? null,
        stringifyJsonObject({ ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) }),
      );

      this.db.prepare('DELETE FROM operator_project_aliases WHERE project_id = ?').run(id);
      aliases.forEach((alias, index) => {
        this.db.prepare(`
          INSERT INTO operator_project_aliases (
            project_id, alias, alias_key, source, confidence, sort_order
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, alias, normalizeKey(alias), input.source, index === 0 ? 1 : 0.85, index);
      });
    });
    write();

    const project = this.findProjectById(id);
    if (!project) {
      throw new Error(`Failed to persist operator project: ${canonicalPath}`);
    }
    return project;
  }

  findProjectById(id: string): OperatorProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM operator_projects WHERE id = ?').get<ProjectRow>(id);
    return row ? this.rowToProject(row) : null;
  }

  findProjectByPath(canonicalPath: string): OperatorProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM operator_projects WHERE canonical_path = ?')
      .get<ProjectRow>(canonicalPath);
    return row ? this.rowToProject(row) : null;
  }

  listProjects(query: OperatorProjectListQuery = {}): OperatorProjectRecord[] {
    const limit = Math.max(1, Math.min(query.limit ?? 500, 500));
    const rows = this.db.prepare(`
      SELECT * FROM operator_projects
      ORDER BY is_pinned DESC, last_accessed_at DESC NULLS LAST, display_name COLLATE NOCASE ASC
      LIMIT ?
    `).all<ProjectRow>(limit);
    const projects = rows.map((row) => this.rowToProject(row));
    const queryKey = query.query ? normalizeKey(query.query) : '';
    if (!queryKey) {
      return projects;
    }
    return projects.filter((project) => projectMatches(project, queryKey));
  }

  upsertScanRoot(
    rootPath: string,
    metadata: Record<string, unknown> = {},
  ): OperatorProjectScanRootRecord {
    const normalizedPath = path.resolve(rootPath);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO operator_project_scan_roots (
        root_path, last_scanned_at, metadata_json
      )
      VALUES (?, ?, ?)
      ON CONFLICT(root_path) DO UPDATE SET
        last_scanned_at = excluded.last_scanned_at,
        metadata_json = excluded.metadata_json
    `).run(normalizedPath, now, stringifyJsonObject(metadata));
    return this.rowToScanRoot(
      this.db.prepare(`
        SELECT * FROM operator_project_scan_roots
        WHERE root_path = ?
      `).get<ScanRootRow>(normalizedPath)!,
    );
  }

  listScanRoots(): OperatorProjectScanRootRecord[] {
    return this.db.prepare(`
      SELECT * FROM operator_project_scan_roots
      ORDER BY root_path COLLATE NOCASE ASC
    `).all<ScanRootRow>().map((row) => this.rowToScanRoot(row));
  }

  private rowToProject(row: ProjectRow): OperatorProjectRecord {
    return {
      id: row.id,
      canonicalPath: row.canonical_path,
      displayName: row.display_name,
      aliases: this.getAliases(row.id),
      source: row.source,
      gitRoot: row.git_root,
      remotes: parseJsonArray<OperatorProjectRemote>(row.remotes_json, []),
      currentBranch: row.current_branch,
      isPinned: row.is_pinned === 1,
      lastSeenAt: row.last_seen_at,
      lastAccessedAt: row.last_accessed_at,
      metadata: parseJsonObject(row.metadata_json, {}),
    };
  }

  private getAliases(projectId: string): string[] {
    return this.db.prepare(`
      SELECT alias FROM operator_project_aliases
      WHERE project_id = ?
      ORDER BY sort_order ASC, alias COLLATE NOCASE ASC
    `).all<AliasRow>(projectId).map((row) => row.alias);
  }

  private rowToScanRoot(row: ScanRootRow): OperatorProjectScanRootRecord {
    return {
      rootPath: row.root_path,
      lastScannedAt: row.last_scanned_at,
      metadata: parseJsonObject(row.metadata_json, {}),
    };
  }
}

export function createProjectId(canonicalPath: string): string {
  return `project_${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24)}`;
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function projectMatches(project: OperatorProjectRecord, queryKey: string): boolean {
  return normalizeKey(project.displayName).includes(queryKey)
    || normalizeKey(project.canonicalPath).includes(queryKey)
    || project.aliases.some((alias) => normalizeKey(alias).includes(queryKey));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function stringifyJsonObject(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function stringifyJsonArray(value: unknown[]): string {
  return JSON.stringify(value);
}

function parseJsonObject(value: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch (error) {
    logger.warn('Corrupt operator project JSON encountered', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function parseJsonArray<T>(value: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch (error) {
    logger.warn('Corrupt operator project array JSON encountered', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
