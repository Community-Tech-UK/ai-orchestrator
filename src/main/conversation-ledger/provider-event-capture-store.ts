import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { toJsonSafeProviderEventPayload } from '../providers/provider-event-raw-payload';
import type {
  ProviderEventCaptureInput,
  ProviderEventCaptureQuery,
  ProviderEventCaptureRecord,
} from './provider-event-capture.types';

const logger = getLogger('ProviderEventCaptureStore');

interface ProviderEventCaptureRow {
  event_id: string;
  provider: ProviderEventCaptureRecord['provider'];
  instance_id: string;
  session_id: string | null;
  sequence: number;
  created_at: number;
  event_json: string;
  raw_source: string;
  raw_json: string;
}

/** Focused persistence boundary for raw-backed canonical provider events. */
export class ProviderEventCaptureStore {
  constructor(private readonly db: SqliteDriver) {}

  append(captures: ProviderEventCaptureInput[]): void {
    if (captures.length === 0) return;
    const write = this.db.transaction(() => {
      for (const capture of captures) {
        this.db.prepare(`
          INSERT INTO provider_event_captures (
            event_id, provider, instance_id, session_id, sequence, created_at,
            event_json, raw_source, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING
        `).run(
          capture.eventId,
          capture.provider,
          capture.instanceId,
          capture.sessionId,
          capture.sequence,
          capture.createdAt,
          JSON.stringify(toJsonSafeProviderEventPayload(capture.event)),
          capture.raw.source,
          JSON.stringify({ payload: toJsonSafeProviderEventPayload(capture.raw.payload) }),
        );
      }
    });
    write();
  }

  list(query: ProviderEventCaptureQuery): ProviderEventCaptureRecord[] {
    const limit = Math.max(1, Math.min(query.limit ?? 1_000, 10_000));
    return this.db.prepare(`
      SELECT * FROM provider_event_captures
      WHERE instance_id = ?
      ORDER BY created_at ASC, sequence ASC
      LIMIT ?
    `).all<ProviderEventCaptureRow>(query.instanceId, limit).map(rowToRecord);
  }

  pruneBefore(before: number): number {
    return this.db.prepare('DELETE FROM provider_event_captures WHERE created_at < ?')
      .run(before).changes;
  }
}

function rowToRecord(row: ProviderEventCaptureRow): ProviderEventCaptureRecord {
  const raw = parseJsonObject(row.raw_json);
  return {
    eventId: row.event_id,
    provider: row.provider,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    createdAt: row.created_at,
    event: parseJsonObject(row.event_json) as unknown as ProviderEventCaptureRecord['event'],
    raw: { source: row.raw_source, payload: raw['payload'] },
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    logger.warn('Corrupt provider event capture JSON encountered', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
