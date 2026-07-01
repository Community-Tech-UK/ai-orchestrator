import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';

export interface RecordCompactionMarkerParams {
  id?: string;
  instanceId: string;
  threadId?: string | null;
  projectKey?: string | null;
  method: string;
  createdAt?: number;
  utilizationBefore?: number | null;
  utilizationAfter?: number | null;
  ledgerAnchor?: number;
  metadata?: Record<string, unknown> | null;
}

export interface CompactionMarker {
  id: string;
  instanceId: string;
  threadId: string | null;
  projectKey: string | null;
  method: string;
  createdAt: number;
  utilizationBefore: number | null;
  utilizationAfter: number | null;
  ledgerAnchor: number;
  metadata: Record<string, unknown> | null;
}

interface CompactionMarkerRow {
  id: string;
  instance_id: string;
  thread_id: string | null;
  project_key: string | null;
  method: string;
  created_at: number;
  utilization_before: number | null;
  utilization_after: number | null;
  ledger_anchor: number;
  metadata_json: string | null;
}

export function recordCompactionMarker(
  db: SqliteDriver,
  params: RecordCompactionMarkerParams,
): string {
  const createdAt = params.createdAt ?? Date.now();
  const id = params.id ?? `cmark_${randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO session_compaction_markers (
      id,
      instance_id,
      thread_id,
      project_key,
      method,
      created_at,
      utilization_before,
      utilization_after,
      ledger_anchor,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      instance_id = excluded.instance_id,
      thread_id = excluded.thread_id,
      project_key = excluded.project_key,
      method = excluded.method,
      created_at = excluded.created_at,
      utilization_before = excluded.utilization_before,
      utilization_after = excluded.utilization_after,
      ledger_anchor = excluded.ledger_anchor,
      metadata_json = excluded.metadata_json
  `).run(
    id,
    params.instanceId,
    params.threadId ?? null,
    params.projectKey ?? null,
    params.method,
    createdAt,
    params.utilizationBefore ?? null,
    params.utilizationAfter ?? null,
    params.ledgerAnchor ?? createdAt,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );
  return id;
}

export function listCompactionMarkers(
  db: SqliteDriver,
  filter: { instanceId?: string; projectKey?: string; limit?: number } = {},
): CompactionMarker[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.instanceId) {
    conditions.push('instance_id = ?');
    params.push(filter.instanceId);
  }
  if (filter.projectKey) {
    conditions.push('project_key = ?');
    params.push(filter.projectKey);
  }
  params.push(filter.limit ?? 50);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT *
    FROM session_compaction_markers
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as CompactionMarkerRow[];
  return rows.map(rowToMarker);
}

export function getCompactionMarker(
  db: SqliteDriver,
  id: string,
): CompactionMarker | null {
  const row = db.prepare(`
    SELECT *
    FROM session_compaction_markers
    WHERE id = ?
  `).get(id) as CompactionMarkerRow | undefined;
  return row ? rowToMarker(row) : null;
}

function rowToMarker(row: CompactionMarkerRow): CompactionMarker {
  return {
    id: row.id,
    instanceId: row.instance_id,
    threadId: row.thread_id,
    projectKey: row.project_key,
    method: row.method,
    createdAt: row.created_at,
    utilizationBefore: row.utilization_before,
    utilizationAfter: row.utilization_after,
    ledgerAnchor: row.ledger_anchor,
    metadata: parseMetadata(row.metadata_json),
  };
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
