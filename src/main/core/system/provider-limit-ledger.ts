import * as crypto from 'node:crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { getRLMDatabase } from '../../persistence/rlm-database';
import type { ProviderId } from '../../../shared/types/provider-quota.types';

export interface ProviderLimitEvent {
  id: string;
  provider: ProviderId;
  /** Null is an account-wide provider limit; a value scopes the limit to that model. */
  model: string | null;
  /**
   * Account-pool profile the limit belongs to. Null is the legacy profile
   * (stored as ''), which is every row written before account pools. The
   * ledger always sets it; optional so pre-pools fixtures stay valid.
   */
  accountProfileId?: string | null;
  detectedAt: number;
  resumeAt: number;
  source: string;
  instanceId: string | null;
}

export interface RecordProviderLimitEvent {
  provider: ProviderId;
  model: string | null;
  /** Omitted or null records against the legacy profile. */
  accountProfileId?: string | null;
  detectedAt: number;
  resumeAt: number;
  source: string;
  instanceId: string | null;
}

const PROVIDER_LIMIT_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS provider_limit_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    detected_at INTEGER NOT NULL,
    resume_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    instance_id TEXT,
    account_profile_id TEXT NOT NULL DEFAULT ''
  );
`;

const PROVIDER_LIMIT_EVENTS_INDEX = `
  DROP INDEX IF EXISTS idx_provider_limit_events_active;
  CREATE INDEX IF NOT EXISTS idx_provider_limit_events_active
    ON provider_limit_events(provider, account_profile_id, model, resume_at DESC, detected_at DESC);
`;

/**
 * Reusable DDL for direct in-memory store tests, matching migrations 047 + 063.
 * Idempotent against a pre-063 table: the profile column is added when missing.
 */
export function createProviderLimitLedgerSchema(db: SqliteDriver): void {
  db.exec(PROVIDER_LIMIT_EVENTS_TABLE);
  const columns = db.prepare('PRAGMA table_info(provider_limit_events)').all<{ name: string }>();
  if (!columns.some((column) => column.name === 'account_profile_id')) {
    db.exec("ALTER TABLE provider_limit_events ADD COLUMN account_profile_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec(PROVIDER_LIMIT_EVENTS_INDEX);
}

const EVENT_COLUMNS = 'id, provider, model, detected_at, resume_at, source, instance_id, account_profile_id';

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
      provider: params.provider,
      model: normalizeModel(params.model),
      accountProfileId: fromDiskProfileId(toDiskProfileId(params.accountProfileId)),
      detectedAt: params.detectedAt,
      resumeAt: params.resumeAt,
      source: params.source,
      instanceId: params.instanceId,
    };
    this.db.prepareCached(`
      INSERT INTO provider_limit_events
        (id, provider, model, detected_at, resume_at, source, instance_id, account_profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.provider,
      event.model ?? '',
      event.detectedAt,
      event.resumeAt,
      event.source,
      event.instanceId,
      toDiskProfileId(event.accountProfileId),
    );
    return event;
  }

  /**
   * Returns a future exact-model limit for the profile, else that profile's
   * provider-wide fallback. Omitted/null `accountProfileId` is the legacy
   * profile, so pre-pools callers keep their exact behaviour.
   */
  getActive(params: {
    provider: ProviderId;
    model: string | null;
    accountProfileId?: string | null;
    now?: number;
  }): ProviderLimitEvent | null {
    const model = normalizeModel(params.model) ?? '';
    const row = this.db.prepareCached(`
      SELECT ${EVENT_COLUMNS}
      FROM provider_limit_events
      WHERE provider = ? AND account_profile_id = ? AND resume_at > ? AND (model = ? OR model = '')
      ORDER BY CASE WHEN model = ? THEN 0 ELSE 1 END, detected_at DESC
      LIMIT 1
    `).get<ProviderLimitEventRow>(
      params.provider,
      toDiskProfileId(params.accountProfileId),
      params.now ?? Date.now(),
      model,
      model,
    );
    return row ? toEvent(row) : null;
  }

  /**
   * Profile IDs (`legacy` for pre-pools rows) that have an active limit for
   * this model or provider-wide.
   */
  getParkedProfileIds(params: { provider: ProviderId; model: string | null; now?: number }): string[] {
    const model = normalizeModel(params.model) ?? '';
    const rows = this.db.prepareCached(`
      SELECT DISTINCT account_profile_id
      FROM provider_limit_events
      WHERE provider = ? AND resume_at > ? AND (model = ? OR model = '')
    `).all<{ account_profile_id: string }>(params.provider, params.now ?? Date.now(), model);
    return rows.map((row) => row.account_profile_id || LEGACY_PROFILE_ID);
  }

  /**
   * When each parked profile's newest active limit was recorded, keyed like
   * {@link getParkedProfileIds}. A usage verdict observed after this time can
   * show the limit no longer holds (credits bought, reset credit applied).
   * Rows are scoped like {@link getActive}: the model's and the account-wide
   * ones. `anyModel` widens a null-model lookup to every model, matching what
   * {@link clearActive} removes for a null model.
   */
  getParkedSince(params: { provider: ProviderId; model: string | null; now?: number; anyModel?: boolean }): Map<string, number> {
    const model = normalizeModel(params.model) ?? '';
    const scope = params.anyModel && model === '' ? '' : "AND (model = ? OR model = '')";
    const args: Array<string | number> = [params.provider, params.now ?? Date.now()];
    if (scope) args.push(model);
    const rows = this.db.prepareCached(`
      SELECT account_profile_id, MAX(detected_at) AS detected_at
      FROM provider_limit_events
      WHERE provider = ? AND resume_at > ? ${scope}
      GROUP BY account_profile_id
    `).all<{ account_profile_id: string; detected_at: number }>(...args);
    return new Map(rows.map((row) => [row.account_profile_id || LEGACY_PROFILE_ID, row.detected_at]));
  }

  /**
   * "Provider parked" in an account pool: every eligible profile has an active
   * limit. With no eligible profiles listed this is the legacy profile's state,
   * which is exactly the pre-pools veto.
   */
  isProviderFullyParked(params: {
    provider: ProviderId;
    model: string | null;
    eligibleProfileIds: readonly string[];
    now?: number;
  }): boolean {
    const eligible = params.eligibleProfileIds.length > 0 ? params.eligibleProfileIds : [LEGACY_PROFILE_ID];
    const parked = new Set(this.getParkedProfileIds(params));
    return eligible.every((profileId) => parked.has(profileId));
  }

  /** Soonest active reset among the given profiles, for "all accounts exhausted; resuming at". */
  getSoonestResumeAt(params: {
    provider: ProviderId;
    model: string | null;
    profileIds: readonly string[];
    now?: number;
  }): number | null {
    let soonest: number | null = null;
    for (const profileId of params.profileIds) {
      const active = this.getActive({ ...params, accountProfileId: profileId });
      if (active && (soonest === null || active.resumeAt < soonest)) soonest = active.resumeAt;
    }
    return soonest;
  }

  list(params: { provider?: ProviderId } = {}): ProviderLimitEvent[] {
    const rows = params.provider
      ? this.db.prepareCached(`
          SELECT ${EVENT_COLUMNS}
          FROM provider_limit_events WHERE provider = ? ORDER BY detected_at ASC
        `).all<ProviderLimitEventRow>(params.provider)
      : this.db.prepareCached(`
          SELECT ${EVENT_COLUMNS}
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
  clearActive(params: {
    provider: ProviderId;
    model: string | null;
    accountProfileId?: string | null;
    now?: number;
  }): number {
    const model = normalizeModel(params.model);
    const now = params.now ?? Date.now();
    const profile = toDiskProfileId(params.accountProfileId);
    if (model === null) {
      return this.db.prepareCached(
        'DELETE FROM provider_limit_events WHERE provider = ? AND account_profile_id = ? AND resume_at > ?',
      ).run(params.provider, profile, now).changes;
    }
    return this.db.prepareCached(
      "DELETE FROM provider_limit_events WHERE provider = ? AND account_profile_id = ? AND (model = ? OR model = '') AND resume_at > ?",
    ).run(params.provider, profile, model, now).changes;
  }

  /** A successful turn after a reset clears that model and any account-wide gate for the profile. */
  clearAfterSuccessfulTurn(params: {
    provider: ProviderId;
    model: string | null;
    accountProfileId?: string | null;
    now?: number;
  }): number {
    const model = normalizeModel(params.model);
    const now = params.now ?? Date.now();
    const profile = toDiskProfileId(params.accountProfileId);
    if (model === null) {
      return this.db.prepareCached(
        "DELETE FROM provider_limit_events WHERE provider = ? AND account_profile_id = ? AND model = '' AND resume_at <= ?",
      ).run(params.provider, profile, now).changes;
    }
    return this.db.prepareCached(
      "DELETE FROM provider_limit_events WHERE provider = ? AND account_profile_id = ? AND (model = ? OR model = '') AND resume_at <= ?",
    ).run(params.provider, profile, model, now).changes;
  }
}

/**
 * Lazy runtime port for callers that construct before the RLM database is
 * initialized (notably InstanceManager's lightweight test and renderer paths).
 */
export type ProviderLimitLedgerPort = Pick<
  ProviderLimitLedger,
  'record' | 'getActive' | 'clearActive' | 'clearAfterSuccessfulTurn' | 'getParkedProfileIds' | 'getParkedSince' | 'isProviderFullyParked' | 'getSoonestResumeAt'
>;

export function getProviderLimitLedgerPort(): ProviderLimitLedgerPort {
  return {
    record: (event) => ProviderLimitLedger.getInstance().record(event),
    getActive: (query) => ProviderLimitLedger.getInstance().getActive(query),
    clearActive: (params) => ProviderLimitLedger.getInstance().clearActive(params),
    clearAfterSuccessfulTurn: (params) => ProviderLimitLedger.getInstance().clearAfterSuccessfulTurn(params),
    getParkedProfileIds: (params) => ProviderLimitLedger.getInstance().getParkedProfileIds(params),
    getParkedSince: (params) => ProviderLimitLedger.getInstance().getParkedSince(params),
    isProviderFullyParked: (params) => ProviderLimitLedger.getInstance().isProviderFullyParked(params),
    getSoonestResumeAt: (params) => ProviderLimitLedger.getInstance().getSoonestResumeAt(params),
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
  account_profile_id: string;
}

const LEGACY_PROFILE_ID = 'legacy';

/** '' on disk is the legacy profile; `legacy` and null/undefined map to it. */
function toDiskProfileId(profileId: string | null | undefined): string {
  const trimmed = profileId?.trim();
  return !trimmed || trimmed === LEGACY_PROFILE_ID ? '' : trimmed;
}

function fromDiskProfileId(value: string): string | null {
  return value || null;
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
    accountProfileId: fromDiskProfileId(row.account_profile_id ?? ''),
    detectedAt: row.detected_at,
    resumeAt: row.resume_at,
    source: row.source,
    instanceId: row.instance_id,
  };
}
