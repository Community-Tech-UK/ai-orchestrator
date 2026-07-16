import * as crypto from 'node:crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { getRLMDatabase } from '../../persistence/rlm-database';
import type { ProviderId } from '../../../shared/types/provider-quota.types';

export interface ProviderLimitEvent {
  id: string;
  provider: ProviderId;
  /** Null is an account-wide provider limit; a value scopes the limit to that model. */
  model: string | null;
  detectedAt: number;
  resumeAt: number;
  source: string;
  instanceId: string | null;
}

export interface RecordProviderLimitEvent {
  provider: ProviderId;
  model: string | null;
  detectedAt: number;
  resumeAt: number;
  source: string;
  instanceId: string | null;
}

const PROVIDER_LIMIT_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS provider_limit_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    detected_at INTEGER NOT NULL,
    resume_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    instance_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_provider_limit_events_active
    ON provider_limit_events(provider, model, resume_at DESC, detected_at DESC);
`;

/** Reusable DDL for the migration and direct in-memory store tests. */
export function createProviderLimitLedgerSchema(db: SqliteDriver): void {
  db.exec(PROVIDER_LIMIT_EVENTS_SCHEMA);
}

/**
 * Durable cross-instance record of provider limits. Account-wide rows use an
 * empty on-disk model and model-specific rows take precedence during lookup.
 * The indexed lookup keeps the send-path consultation constant-time.
 */
export class ProviderLimitLedger {
  private static instance: ProviderLimitLedger | null = null;

  constructor(private readonly db: SqliteDriver) {}

  static getInstance(db: SqliteDriver = getRLMDatabase().getRawDb()): ProviderLimitLedger {
    if (!ProviderLimitLedger.instance) {
      ProviderLimitLedger.instance = new ProviderLimitLedger(db);
    }
    return ProviderLimitLedger.instance;
  }

  static _resetForTesting(): void {
    ProviderLimitLedger.instance = null;
  }

  record(params: RecordProviderLimitEvent): ProviderLimitEvent {
    if (!Number.isFinite(params.detectedAt) || !Number.isFinite(params.resumeAt)) {
      throw new Error('Provider limit times must be finite epoch milliseconds');
    }
    if (params.resumeAt <= params.detectedAt) {
      throw new Error('Provider limit resumeAt must be after detectedAt');
    }
    if (!params.source.trim()) {
      throw new Error('Provider limit source is required');
    }

    const event: ProviderLimitEvent = {
      id: crypto.randomUUID(),
      ...params,
      model: normalizeModel(params.model),
    };
    this.db.prepareCached(`
      INSERT INTO provider_limit_events
        (id, provider, model, detected_at, resume_at, source, instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.provider,
      event.model ?? '',
      event.detectedAt,
      event.resumeAt,
      event.source,
      event.instanceId,
    );
    return event;
  }

  /** Returns a future exact-model limit, else the provider-wide fallback. */
  getActive(params: { provider: ProviderId; model: string | null; now?: number }): ProviderLimitEvent | null {
    const model = normalizeModel(params.model) ?? '';
    const row = this.db.prepareCached(`
      SELECT id, provider, model, detected_at, resume_at, source, instance_id
      FROM provider_limit_events
      WHERE provider = ? AND resume_at > ? AND (model = ? OR model = '')
      ORDER BY CASE WHEN model = ? THEN 0 ELSE 1 END, detected_at DESC
      LIMIT 1
    `).get<ProviderLimitEventRow>(params.provider, params.now ?? Date.now(), model, model);
    return row ? toEvent(row) : null;
  }

  list(params: { provider?: ProviderId } = {}): ProviderLimitEvent[] {
    const rows = params.provider
      ? this.db.prepareCached(`
          SELECT id, provider, model, detected_at, resume_at, source, instance_id
          FROM provider_limit_events WHERE provider = ? ORDER BY detected_at ASC
        `).all<ProviderLimitEventRow>(params.provider)
      : this.db.prepareCached(`
          SELECT id, provider, model, detected_at, resume_at, source, instance_id
          FROM provider_limit_events ORDER BY detected_at ASC
        `).all<ProviderLimitEventRow>();
    return rows.map(toEvent);
  }

  deleteExpired(now = Date.now()): number {
    return this.db.prepareCached('DELETE FROM provider_limit_events WHERE resume_at <= ?').run(now).changes;
  }

  /**
   * User-override clear: delete the still-active (future-dated) gates that
   * would hold a turn for this model — the exact-model row and the
   * account-wide fallback. A recorded resumeAt can go stale mid-window (e.g.
   * the user applies a reset credit or purchases more quota on the provider
   * side), and without this the durable row keeps holding every send until
   * its wall-clock expiry. Called when the user explicitly resumes or
   * dismisses a quota park; if the provider is in fact still limited, the
   * very next failed turn re-records a fresh gate.
   *
   * `model: null` clears provider-wide (every model plus the account gate):
   * callers without a model scope are acting on account-level evidence (a
   * user override, or a quota probe whose windows are account-level), which
   * invalidates every recorded gate for the provider. Leaving model-scoped
   * rows behind would let a stale gate instantly re-park the resumed session.
   */
  clearActive(params: { provider: ProviderId; model: string | null; now?: number }): number {
    const model = normalizeModel(params.model);
    const now = params.now ?? Date.now();
    if (model === null) {
      return this.db.prepareCached(
        'DELETE FROM provider_limit_events WHERE provider = ? AND resume_at > ?',
      ).run(params.provider, now).changes;
    }
    return this.db.prepareCached(
      "DELETE FROM provider_limit_events WHERE provider = ? AND (model = ? OR model = '') AND resume_at > ?",
    ).run(params.provider, model, now).changes;
  }

  /** A successful turn after a reset clears that model and any account-wide gate. */
  clearAfterSuccessfulTurn(params: { provider: ProviderId; model: string | null; now?: number }): number {
    const model = normalizeModel(params.model);
    const now = params.now ?? Date.now();
    if (model === null) {
      return this.db.prepareCached(
        "DELETE FROM provider_limit_events WHERE provider = ? AND model = '' AND resume_at <= ?",
      ).run(params.provider, now).changes;
    }
    return this.db.prepareCached(
      "DELETE FROM provider_limit_events WHERE provider = ? AND (model = ? OR model = '') AND resume_at <= ?",
    ).run(params.provider, model, now).changes;
  }
}

/**
 * Lazy runtime port for callers that construct before the RLM database is
 * initialized (notably InstanceManager's lightweight test and renderer paths).
 */
export function getProviderLimitLedgerPort(): Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive' | 'clearAfterSuccessfulTurn'> {
  return {
    record: (event) => ProviderLimitLedger.getInstance().record(event),
    getActive: (query) => ProviderLimitLedger.getInstance().getActive(query),
    clearActive: (params) => ProviderLimitLedger.getInstance().clearActive(params),
    clearAfterSuccessfulTurn: (params) => ProviderLimitLedger.getInstance().clearAfterSuccessfulTurn(params),
  };
}

interface ProviderLimitEventRow {
  id: string;
  provider: ProviderId;
  model: string;
  detected_at: number;
  resume_at: number;
  source: string;
  instance_id: string | null;
}

function normalizeModel(model: string | null): string | null {
  const normalized = model?.trim();
  return normalized ? normalized : null;
}

function toEvent(row: ProviderLimitEventRow): ProviderLimitEvent {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model || null,
    detectedAt: row.detected_at,
    resumeAt: row.resume_at,
    source: row.source,
    instanceId: row.instance_id,
  };
}
