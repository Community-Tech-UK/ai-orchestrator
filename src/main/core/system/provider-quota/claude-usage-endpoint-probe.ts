/**
 * ClaudeUsageEndpointProbe
 *
 * The real Claude quota probe: reads the on-machine OAuth token (read-only,
 * see {@link ClaudeCredentialsReader}) and calls Anthropic's undocumented
 * `GET https://api.anthropic.com/api/oauth/usage` endpoint — the same data
 * that powers Claude Code's `/usage` slash command.
 *
 * The endpoint returns a utilization percentage (0–100) and an ISO-8601
 * `resets_at` for each rate-limit "bucket":
 *
 *   {
 *     "five_hour":        { "utilization": 35.0, "resets_at": "…" } | null,
 *     "seven_day":        { "utilization": 14.0, "resets_at": "…" } | null,
 *     "seven_day_sonnet": { "utilization": 39.0, "resets_at": "…" } | null,
 *     "seven_day_opus":   { … } | null,
 *     "limits":           [{ "kind": "weekly_scoped", "percent": 10.0,
 *                            "scope": { "model": { "display_name": "Fable" }}}],
 *     "extra_usage":      { "is_enabled": true, "monthly_limit": 100000,
 *                           "used_credits": 0.0, "utilization": 11.18,
 *                           "currency": "EUR" } | null,
 *     …
 *   }
 *
 * Each bucket becomes a `ProviderQuotaWindow` with `used` = utilization and
 * `limit` = 100 (so the existing 75/90/100 % threshold machinery just works).
 * `extra_usage` becomes a USD "credits" window — the real-money overage guard.
 *
 * Best-effort by design: the endpoint is undocumented and may change or rate-
 * limit the poll. Any failure (no token, expired token, HTTP error, bad shape)
 * resolves to an `ok: false` snapshot with a human-readable `error`; we never
 * throw and never hard-depend on it.
 */

import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';
import {
  clampQuotaPercent,
  quotaRemaining,
} from '../../../../shared/util/provider-quota-format';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import {
  ClaudeCredentialsReader,
  type CredentialFailureReason,
} from './claude-credentials-reader';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('ClaudeUsageEndpointProbe');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
/** Sent so the undocumented endpoint doesn't aggressively rate-limit us. */
const USER_AGENT = 'claude-code/2.0.32';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Pluggable HTTP fetch returning the raw `oauth/usage` body. Tests inject a fake. */
export type UsageFetch = (
  token: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface ClaudeUsageEndpointProbeOptions {
  /** Injected credentials reader (tests). Defaults to a real keychain/file reader. */
  credentialsReader?: Pick<ClaudeCredentialsReader, 'read'>;
  /** Injected fetch (tests). Defaults to a global-`fetch` wrapper. */
  fetchUsage?: UsageFetch;
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

/** Shape of one time-based bucket in the `oauth/usage` payload. */
interface UsageBucket {
  utilization?: number | null;
  resets_at?: string | null;
}

/** Shape of the `extra_usage` (credits/overage) bucket. */
interface ExtraUsageBucket {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string;
}

interface UsageLimit {
  kind?: string | null;
  percent?: number | null;
  resets_at?: string | null;
  scope?: {
    model?: {
      display_name?: string | null;
      id?: string | null;
    } | null;
  } | null;
}

interface UsagePayload {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  limits?: UsageLimit[] | null;
  extra_usage?: ExtraUsageBucket | null;
}

/** Buckets we render, in display order, with stable ids + labels. */
const TIME_BUCKETS: readonly {
  key: keyof UsagePayload;
  id: string;
  label: string;
}[] = [
  { key: 'five_hour', id: 'claude.5h', label: '5-hour session' },
  { key: 'seven_day', id: 'claude.weekly', label: 'Weekly (all models)' },
  { key: 'seven_day_sonnet', id: 'claude.weekly-sonnet', label: 'Weekly (Sonnet)' },
  { key: 'seven_day_opus', id: 'claude.weekly-opus', label: 'Weekly (Opus)' },
];

export class ClaudeUsageEndpointProbe implements ProviderQuotaProbe {
  readonly provider = 'claude' as const;

  private readonly credentialsReader: Pick<ClaudeCredentialsReader, 'read'>;
  private readonly fetchUsage: UsageFetch;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeUsageEndpointProbeOptions = {}) {
    this.credentialsReader = opts.credentialsReader ?? new ClaudeCredentialsReader();
    this.fetchUsage = opts.fetchUsage ?? defaultFetchUsage;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();

    const { credential, reason } = await this.credentialsReader.read();
    if (!credential) {
      return failedSnapshot(takenAt, describeCredentialFailure(reason));
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchUsage(credential.accessToken, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(takenAt, 'Claude OAuth token rejected (401/403) — re-login may be required');
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Claude usage endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Claude usage endpoint returned HTTP ${status}`);
    }

    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Claude usage endpoint returned an unexpected body');
    }

    const windows = parseUsagePayload(body as UsagePayload);
    return {
      provider: 'claude',
      takenAt,
      source: 'admin-api',
      ok: true,
      plan: credential.subscriptionType?.toLowerCase(),
      windows,
    };
  }
}

// ─── parsing ─────────────────────────────────────────────────────────────

/** Convert the raw `oauth/usage` payload into quota windows. Exported for tests. */
export function parseUsagePayload(payload: UsagePayload): ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [];

  for (const bucket of TIME_BUCKETS) {
    const raw = payload[bucket.key] as UsageBucket | null | undefined;
    if (!raw || typeof raw.utilization !== 'number') continue;
    const used = clampQuotaPercent(raw.utilization);
    windows.push({
      kind: 'rolling-window',
      id: bucket.id,
      label: bucket.label,
      unit: 'messages',
      used,
      limit: 100,
      remaining: quotaRemaining(100, used),
      resetsAt: parseResetsAt(raw.resets_at),
    });
  }

  appendScopedLimitWindows(windows, payload.limits);

  const extra = payload.extra_usage;
  if (extra && extra.is_enabled) {
    // Credits are reported in cents; keep raw values (the used/limit ratio is
    // scale-invariant for thresholds, and the UI divides by 100 for display).
    const used = numberOr(extra.used_credits, 0);
    const limit = numberOr(extra.monthly_limit, 0);
    windows.push({
      kind: 'calendar-period',
      id: 'claude.credits',
      label: 'Extra usage credits',
      unit: 'usd',
      used,
      limit,
      remaining: limit > 0 ? quotaRemaining(limit, used) : Number.NaN,
      resetsAt: null,
    });
  }

  return windows;
}

function appendScopedLimitWindows(windows: ProviderQuotaWindow[], limits: UsageLimit[] | null | undefined): void {
  if (!Array.isArray(limits)) return;

  const seenIds = new Set(windows.map((w) => w.id));
  for (const limit of limits) {
    if (limit.kind !== 'weekly_scoped' || typeof limit.percent !== 'number') continue;
    const modelName = limit.scope?.model?.display_name?.trim();
    if (!modelName) continue;

    const id = `claude.weekly-${slug(modelName)}`;
    if (seenIds.has(id)) continue;

    const used = clampQuotaPercent(limit.percent);
    windows.push({
      kind: 'rolling-window',
      id,
      label: `Weekly (${modelName})`,
      unit: 'messages',
      used,
      limit: 100,
      remaining: quotaRemaining(100, used),
      resetsAt: parseResetsAt(limit.resets_at),
    });
    seenIds.add(id);
  }
}

function numberOr(n: number | null | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** ISO-8601 → epoch ms, or null when absent/unparseable. */
function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

// ─── helpers ───────────────────────────────────────────────────────────────

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'claude',
    takenAt,
    source: 'admin-api',
    ok: false,
    error,
    windows: [],
  };
}

function describeCredentialFailure(reason: CredentialFailureReason | undefined): string {
  switch (reason) {
    case 'expired':
      return 'Claude OAuth token is expired (skipped — never refreshed read-only)';
    case 'denied':
      return 'Keychain access denied reading the Claude OAuth token';
    case 'malformed':
      return 'Stored Claude OAuth credential is malformed';
    case 'unsupported':
      return 'No known Claude credential location on this platform';
    case 'not-found':
    default:
      return 'Claude Code is not signed in (no OAuth token found)';
  }
}

function classifyFetchError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError') return 'Claude usage request aborted/timed out';
  }
  return err instanceof Error
    ? `Claude usage request failed: ${err.message}`
    : 'Claude usage request failed';
}

/** Production fetch wrapper around the global `fetch` with a timeout. */
const defaultFetchUsage: UsageFetch = async (token, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  // Abort if either the caller's signal or our timeout fires.
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON body (e.g. an HTML error page). Leave body null; the caller
      // maps non-2xx to an error and a 2xx-with-bad-body to its own message.
      logger.debug('Claude usage endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
