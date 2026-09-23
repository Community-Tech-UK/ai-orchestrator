/**
 * Store for decision-log observation events (migration 066). Follows the
 * shape of rlm-compaction-markers.ts: plain functions over a SqliteDriver.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type {
  ObservationEvent,
  ObservationEventPriority,
  ObservationEventType,
} from '../../../shared/types/observation-event.types';

interface ObservationEventRow {
  id: string;
  instance_id: string;
  compaction_marker_id: string | null;
  timestamp: number;
  turn: number;
  type: ObservationEventType;
  priority: ObservationEventPriority;
  content: string;
  metadata_json: string | null;
  source_type: ObservationEvent['sourceType'];
  created_at: number;
}

export interface ListObservationEventsOptions {
  /** Only events at or above this importance (1 = critical). */
  maxPriority?: ObservationEventPriority;
  /** Newest N events (default 100). Returned oldest first. */
  limit?: number;
}

/** Insert events in one transaction; an id already stored is left untouched. Returns rows inserted. */
export function recordObservationEvents(
  db: SqliteDriver,
  events: readonly ObservationEvent[],
  createdAt = Date.now(),
): number {
  if (events.length === 0) return 0;
  const insert = db.prepare(`
    INSERT INTO session_observation_events (
      id, instance_id, compaction_marker_id, timestamp, turn, type, priority,
      content, metadata_json, source_type, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertAll = db.transaction((rows: readonly ObservationEvent[]) => {
    let inserted = 0;
    for (const event of rows) {
      inserted += insert.run(
        event.id,
        event.instanceId,
        event.compactionMarkerId ?? null,
        event.timestamp,
        event.turn,
        event.type,
        event.priority,
        event.content,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.sourceType,
        createdAt,
      ).changes;
    }
    return inserted;
  });
  return insertAll(events);
}

export function listObservationEvents(
  db: SqliteDriver,
  instanceId: string,
  options: ListObservationEventsOptions = {},
): ObservationEvent[] {
  const rows = db.prepare(`
    SELECT *
    FROM session_observation_events
    WHERE instance_id = ? AND priority <= ?
    ORDER BY created_at DESC, turn DESC, rowid DESC
    LIMIT ?
  `).all<ObservationEventRow>(instanceId, options.maxPriority ?? 3, options.limit ?? 100);
  return rows.reverse().map(rowToEvent);
}

function rowToEvent(row: ObservationEventRow): ObservationEvent {
  const metadata = parseMetadata(row.metadata_json);
  return {
    id: row.id,
    instanceId: row.instance_id,
    ...(row.compaction_marker_id ? { compactionMarkerId: row.compaction_marker_id } : {}),
    timestamp: row.timestamp,
    turn: row.turn,
    type: row.type,
    priority: row.priority,
    content: row.content,
    ...(metadata ? { metadata } : {}),
    sourceType: row.source_type,
  };
}

function parseMetadata(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return null;
  }
}
