import type { SqliteDriver } from '../db/sqlite-driver';
import type { OperatorRunEventKind, OperatorRunEventRecord } from '../../shared/types/operator.types';
import { getLogger } from '../logging/logger';
import { getOperatorDatabase } from './operator-database';
import { getOperatorEventBus } from './operator-event-bus';

const logger = getLogger('OperatorEventRelay');

interface OperatorEventRow {
  rowid: number;
  id: string;
  run_id: string;
  node_id: string | null;
  kind: OperatorRunEventKind;
  payload_json: string;
  created_at: number;
}

export interface OperatorEventRelayConfig {
  db?: SqliteDriver;
  intervalMs?: number;
}

export class OperatorEventRelay {
  private static instance: OperatorEventRelay | null = null;
  private readonly db: SqliteDriver;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastSeenRowId = 0;

  static getInstance(config: OperatorEventRelayConfig = {}): OperatorEventRelay {
    this.instance ??= new OperatorEventRelay(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  constructor(config: OperatorEventRelayConfig = {}) {
    this.db = config.db ?? getOperatorDatabase().db;
    this.intervalMs = config.intervalMs ?? 1_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.lastSeenRowId = this.currentMaxRowId();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  poll(): void {
    try {
      const rows = this.db.prepare(`
        SELECT rowid, * FROM operator_run_events
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT 200
      `).all<OperatorEventRow>(this.lastSeenRowId);

      for (const row of rows) {
        this.lastSeenRowId = row.rowid;
        getOperatorEventBus().publish(rowToEvent(row));
      }
    } catch (error) {
      logger.warn('Failed to relay operator events from database', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private currentMaxRowId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS rowid FROM operator_run_events')
      .get<{ rowid: number }>();
    return row?.rowid ?? 0;
  }
}

export function getOperatorEventRelay(config?: OperatorEventRelayConfig): OperatorEventRelay {
  return OperatorEventRelay.getInstance(config);
}

function rowToEvent(row: OperatorEventRow): OperatorRunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    kind: row.kind,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
