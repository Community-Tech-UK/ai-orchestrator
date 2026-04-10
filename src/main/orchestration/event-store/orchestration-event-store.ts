/**
 * Orchestration Event Store
 *
 * Append-only event store backed by SQLite. Supports replay, debugging,
 * and audit trails for orchestration operations (verifications, debates,
 * consensus).
 *
 * Gated behind the EVENT_SOURCING feature flag. The store is injected with
 * a database instance (EventStoreDb interface) to keep it testable without
 * the native better-sqlite3 binding.
 */

import { getLogger } from '../../logging/logger';
import { isFeatureEnabled } from '../../../shared/constants/feature-flags';
import type { OrchestrationEvent, OrchestrationEventType } from './orchestration-events';

const logger = getLogger('OrchestrationEventStore');

export interface EventStoreDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown | undefined;
  };
}

interface EventRow {
  id: string;
  type: string;
  aggregate_id: string;
  timestamp: number;
  payload: string;
  metadata: string | null;
}

function rowToEvent(row: EventRow): OrchestrationEvent {
  return {
    id: row.id,
    type: row.type as OrchestrationEventType,
    aggregateId: row.aggregate_id,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as OrchestrationEvent['metadata'])
      : undefined,
  };
}

export class OrchestrationEventStore {
  private static instance: OrchestrationEventStore | null = null;
  private readonly db: EventStoreDb;
  private initialized = false;

  constructor(db: EventStoreDb) {
    this.db = db;
  }

  static getInstance(db: EventStoreDb): OrchestrationEventStore {
    if (!this.instance) this.instance = new OrchestrationEventStore(db);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  initialize(): void {
    if (this.initialized) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_events_aggregate ON orchestration_events(aggregate_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_events_type ON orchestration_events(type)
    `);

    this.initialized = true;
    logger.info('Orchestration event store initialized');
  }

  append(event: OrchestrationEvent): void {
    if (!isFeatureEnabled('EVENT_SOURCING')) return;

    const stmt = this.db.prepare(`
      INSERT INTO orchestration_events (id, type, aggregate_id, timestamp, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.type,
      event.aggregateId,
      event.timestamp,
      JSON.stringify(event.payload),
      event.metadata ? JSON.stringify(event.metadata) : null,
    );
  }

  getByAggregateId(aggregateId: string): OrchestrationEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM orchestration_events WHERE aggregate_id = ? ORDER BY timestamp ASC',
    );
    return (stmt.all(aggregateId) as EventRow[]).map(rowToEvent);
  }

  getByType(type: OrchestrationEventType, limit = 100): OrchestrationEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM orchestration_events WHERE type = ? ORDER BY timestamp DESC LIMIT ?',
    );
    return (stmt.all(type, limit) as EventRow[]).map(rowToEvent);
  }

  getRecentEvents(limit = 50): OrchestrationEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM orchestration_events ORDER BY timestamp DESC LIMIT ?',
    );
    return (stmt.all(limit) as EventRow[]).map(rowToEvent);
  }
}
