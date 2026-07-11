import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SqliteDriver } from '../../../db/sqlite-driver';

export interface CodexLeakedStateSnapshot {
  threadIds: string[];
  fingerprint: string;
}

export function resolveCodexTempRoots(overrides?: readonly string[]): string[] {
  if (overrides) return uniqueStrings(overrides.map(normalizePath));
  const root = tmpdir();
  const roots = [normalizePath(root)];
  try {
    roots.push(normalizePath(realpathSync(root)));
  } catch {
    // The lexical temp root remains safe if its canonical form is unavailable.
  }
  return uniqueStrings(roots);
}

export function captureLeakedCodexState(
  db: SqliteDriver,
  tempRoots: readonly string[],
): CodexLeakedStateSnapshot {
  const threadIds = db.prepare('SELECT id, rollout_path FROM threads ORDER BY id')
    .all<{ id: string; rollout_path: string }>()
    .filter((row) => isOwnedAioRolloutPath(row.rollout_path, tempRoots))
    .map((row) => row.id);
  if (threadIds.length === 0) return { threadIds, fingerprint: '[]' };

  const idList = sqlList(threadIds);
  const tables: Record<string, unknown[]> = {
    threads: selectRows(db, 'threads', `id IN (${idList})`, threadIds),
  };
  if (hasColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
    tables['thread_spawn_edges'] = selectRows(
      db,
      'thread_spawn_edges',
      `parent_thread_id IN (${idList}) OR child_thread_id IN (${idList})`,
      [...threadIds, ...threadIds],
    );
  }
  if (hasColumns(db, 'thread_dynamic_tools', ['thread_id'])) {
    tables['thread_dynamic_tools'] = selectRows(db, 'thread_dynamic_tools', `thread_id IN (${idList})`, threadIds);
  }
  if (hasColumns(db, 'agent_job_items', ['job_id', 'assigned_thread_id'])) {
    const assignedItems = selectRows(db, 'agent_job_items', `assigned_thread_id IN (${idList})`, threadIds);
    const jobIds = uniqueStrings(assignedItems.map((row) => (row as Record<string, unknown>)['job_id']));
    if (jobIds.length > 0) {
      tables['agent_job_items'] = selectRows(
        db,
        'agent_job_items',
        `job_id IN (${sqlList(jobIds)})`,
        jobIds,
      );
      if (hasColumns(db, 'agent_jobs', ['id'])) {
        tables['agent_jobs'] = selectRows(db, 'agent_jobs', `id IN (${sqlList(jobIds)})`, jobIds);
      }
    }
  }
  return { threadIds, fingerprint: stableSerialize(tables) };
}

function isOwnedAioRolloutPath(rolloutPath: string, tempRoots: readonly string[]): boolean {
  const normalizedPath = normalizePath(rolloutPath);
  return tempRoots.some((root) => {
    const comparablePath = comparablePathForRoot(normalizedPath, root);
    const comparableRoot = comparablePathForRoot(root, root).replace(/\/$/, '');
    if (!comparablePath.startsWith(`${comparableRoot}/`)) return false;
    const [homeName, sessions, ...rolloutSegments] = comparablePath.slice(comparableRoot.length + 1).split('/');
    if (!homeName || sessions !== 'sessions' || rolloutSegments.length === 0
      || rolloutSegments.some((segment) => segment.length === 0)) return false;
    return ['codex-browser-mcp-', 'codex-nomcp-', 'codex-aio-']
      .some((prefix) => homeName.startsWith(prefix) && homeName.length > prefix.length);
  });
}

function selectRows(db: SqliteDriver, table: string, where: string, params: readonly string[]): unknown[] {
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`).all(...params);
}

function hasColumns(db: SqliteDriver, table: string, required: readonly string[]): boolean {
  const columns = db.pragma(`main.table_info(${table})`);
  if (!Array.isArray(columns)) return false;
  const names = new Set(columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const name = (column as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  }));
  return required.every((column) => names.has(column));
}

function stableSerialize(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify({ bigint: value.toString() });
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).sort().join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function comparablePathForRoot(value: string, root: string): string {
  return /^[A-Za-z]:\//.test(root) ? value.toLowerCase() : value;
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort();
}

function sqlList(values: readonly unknown[]): string {
  if (values.length === 0) throw new Error('Cannot build an empty SQLite value list');
  return values.map(() => '?').join(', ');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
