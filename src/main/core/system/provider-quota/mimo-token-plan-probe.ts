/**
 * MimoTokenPlanProbe
 *
 * Reports James's MiMo Token Plan allowance (the "MiMo Code" allowance — the
 * plan metering `xiaomi-token-plan-*` models) as the `opencode` provider's
 * quota snapshot, per the OpenCode provider plan's Task 3.7: OpenCode is the
 * CLI and the Token Plan is its backend when the configured model's provider
 * id starts with `xiaomi-token-plan-`.
 *
 * Source is the MiMo console's own read-only quota API —
 * `GET /api/v1/tokenPlan/usage` + `GET /api/v1/tokenPlan/detail` — which
 * accepts only the browser console session (the Token Plan API key is refused
 * with 401). Session cookies come from {@link MimoConsoleCredentialsReader}.
 * When the console session is rejected (401/403), the probe walks the
 * platform's own Xiaomi SSO renewal URL once
 * ({@link MimoConsoleSessionRenewer}, no credential entry) and re-pulls the
 * quota before surfacing a reauth state.
 *
 * One snapshot merges both responses: `usage` carries the token buckets,
 * `detail` the plan name and period end. Percentages come from used/limit
 * (the payload's `percent` fields are fractions and inconsistently rounded);
 * `currentPeriodEnd` is naive UTC, exactly as the console parses it.
 */

import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';
import {
  normalizeQuotaAmount,
  quotaRemaining,
} from '../../../../shared/util/provider-quota-format';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';
import {
  MimoConsoleCredentialsReader,
  type MimoConsoleSession,
  type MimoCredentialResult,
} from './mimo-console-credentials-reader';
import { MimoConsoleSessionRenewer } from './mimo-console-session-renewer';

const logger = getLogger('MimoTokenPlanProbe');

const PLATFORM = 'https://platform.xiaomimimo.com';
const USAGE_URL = `${PLATFORM}/api/v1/tokenPlan/usage`;
const DETAIL_URL = `${PLATFORM}/api/v1/tokenPlan/detail`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const DEFAULT_TIMEOUT_MS = 10_000;

export type MimoTokenPlanFetch = (
  session: MimoConsoleSession,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{
  usage: { status: number; body: unknown };
  detail: { status: number; body: unknown };
}>;

/** Cookie source: the console session plus (optionally) Xiaomi account SSO. */
export interface MimoCredentialSource {
  read(): Promise<MimoCredentialResult>;
  readAccountSso?(): Promise<{ cookieHeader: string }>;
}

export interface MimoTokenPlanProbeOptions {
  /** Gate from the configured OpenCode model (Task 3.7). Required. */
  isTokenPlanModel: () => boolean;
  reader?: MimoCredentialSource;
  fetchPlans?: MimoTokenPlanFetch;
  /** Session auto-renewal on 401/403 (SSO walk). Injected in tests. */
  renewer?: Pick<MimoConsoleSessionRenewer, 'renew'>;
  timeoutMs?: number;
  now?: () => number;
}

interface MimoTokenPlanBucket {
  name?: unknown;
  used?: unknown;
  limit?: unknown;
  percent?: unknown;
}

interface MimoTokenPlanGroup {
  items?: unknown;
  percent?: unknown;
}

interface MimoTokenPlanUsageBody {
  data?: {
    usage?: MimoTokenPlanGroup | null;
    monthUsage?: MimoTokenPlanGroup | null;
  } | null;
}

interface MimoTokenPlanDetailBody {
  data?: {
    planName?: unknown;
    planCode?: unknown;
    currentPeriodEnd?: unknown;
    expired?: unknown;
  } | null;
}

const BUCKETS: ReadonlyArray<{ name: string; id: string; label: string }> = [
  { name: 'plan_total_token', id: 'opencode.plan', label: 'Plan' },
  { name: 'month_total_token', id: 'opencode.monthly', label: 'Monthly' },
  { name: 'compensation_total_token', id: 'opencode.compensation', label: 'Compensation' },
];

/**
 * Task 3.7's gate: the Token Plan numbers belong to the
 * `xiaomi-token-plan-*` backend only, so both the probe and the
 * token-usage-monitor fallback stay quiet for other OpenCode backends
 * (Zen, OpenRouter, …). `defaultModelByProvider.opencode` is the configured
 * model; the legacy global `defaultModel` is the fallback.
 */
export function isTokenPlanModelSetting(
  settings:
    | { defaultModelByProvider?: Record<string, string> | null; defaultModel?: string | null }
    | null
    | undefined,
): boolean {
  const model = settings?.defaultModelByProvider?.['opencode'] ?? settings?.defaultModel ?? '';
  return typeof model === 'string' && model.startsWith('xiaomi-token-plan-');
}

export class MimoTokenPlanProbe implements ProviderQuotaProbe {
  readonly provider = 'opencode' as const;

  private readonly isTokenPlanModel: () => boolean;
  private readonly reader: MimoCredentialSource;
  private readonly fetchPlans: MimoTokenPlanFetch;
  private readonly renewer: Pick<MimoConsoleSessionRenewer, 'renew'>;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: MimoTokenPlanProbeOptions) {
    this.isTokenPlanModel = opts.isTokenPlanModel;
    this.reader = opts.reader ?? new MimoConsoleCredentialsReader();
    this.fetchPlans = opts.fetchPlans ?? defaultFetchPlans;
    this.renewer = opts.renewer ?? new MimoConsoleSessionRenewer();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    if (!this.isTokenPlanModel()) {
      // A non-Token-Plan OpenCode backend (Zen, OpenRouter, …) has no numbers
      // here. Returning `null` would mean "no fresh info, keep the last
      // snapshot" (the service's general probe contract) and leave a stale
      // Token Plan allowance on screen after a model switch (LT-650) — so
      // this gate returns an explicit `notApplicable` snapshot instead,
      // which the service stores in place of whatever was there before.
      // No credential read happens on this path.
      return {
        provider: 'opencode',
        takenAt: this.now(),
        source: 'admin-api',
        ok: false,
        notApplicable: true,
        windows: [],
      };
    }
    const takenAt = this.now();
    const credential = await this.reader.read();
    if (!credential.session) {
      return failedSnapshot(takenAt, reauthErrorFor(credential.reason), {
        needsReauth: credential.reason === 'not-found' || credential.reason === 'malformed',
      });
    }

    let usage: { status: number; body: unknown };
    let detail: { status: number; body: unknown };
    try {
      ({ usage, detail } = await this.fetchPlans(credential.session, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (usage.status === 401 || detail.status === 401 || usage.status === 403 || detail.status === 403) {
      // The platform's 401 body publishes the Xiaomi SSO renewal URL. Walk it
      // once (persistent account cookies from Chrome — no credential entry)
      // and re-pull the quota before declaring the session dead; a rejection
      // under heavy polling is often a stale/risk-controlled session that SSO
      // re-mints instantly (verified live 2026-09-25).
      const revived = await this.attemptSessionRenewal(usage.body, detail.body, credential.session, signal);
      if (revived) {
        try {
          const retry = await this.fetchPlans(revived, { signal, timeoutMs: this.timeoutMs });
          const parsedRetry = retry.usage.status >= 200 && retry.usage.status < 300
            && retry.detail.status >= 200 && retry.detail.status < 300
            ? parseMimoTokenPlanResponses(retry.usage.body, retry.detail.body)
            : null;
          if (parsedRetry && parsedRetry.windows.length > 0) {
            logger.info('MiMo console session renewed through Xiaomi SSO');
            return {
              provider: 'opencode',
              takenAt: this.now(),
              source: 'admin-api',
              ok: true,
              windows: parsedRetry.windows,
              ...(parsedRetry.plan ? { plan: parsedRetry.plan } : {}),
            };
          }
        } catch (err) {
          logger.debug(`MiMo quota re-pull after session renewal failed: ${(err as Error).message}`);
        }
      }
      return failedSnapshot(
        takenAt,
        'MiMo console session rejected (401/403) — sign in to the MiMo console in Chrome again',
        { needsReauth: true },
      );
    }
    if (usage.status < 200 || usage.status >= 300) {
      return failedSnapshot(takenAt, `MiMo Token Plan usage endpoint returned HTTP ${usage.status}`);
    }
    if (detail.status < 200 || detail.status >= 300) {
      return failedSnapshot(takenAt, `MiMo Token Plan detail endpoint returned HTTP ${detail.status}`);
    }

    const parsed = parseMimoTokenPlanResponses(usage.body, detail.body);
    if (parsed.windows.length === 0) {
      return failedSnapshot(takenAt, 'MiMo Token Plan endpoints returned no usage windows');
    }

    return {
      provider: 'opencode',
      takenAt,
      source: 'admin-api',
      ok: true,
      windows: parsed.windows,
      ...(parsed.plan ? { plan: parsed.plan } : {}),
    };
  }

  /**
   * Walk the platform's SSO renewal URL with the account cookies already in
   * Chrome. Returns the session to retry with (merging any rotated platform
   * cookies the walk minted), or null when renewal is impossible — no
   * loginUrl in the body, throttled, or the walk failed. The SSO cookie read
   * is a lazy supplier so skipped walks never pay a Keychain/cookie-DB read.
   */
  private async attemptSessionRenewal(
    usageBody: unknown,
    detailBody: unknown,
    session: MimoConsoleSession,
    signal: AbortSignal,
  ): Promise<MimoConsoleSession | null> {
    const loginUrl = extractLoginUrl(usageBody) ?? extractLoginUrl(detailBody);
    if (!loginUrl) return null;
    const result = await this.renewer.renew(loginUrl, async () => {
      const sso = await this.reader.readAccountSso?.();
      return sso?.cookieHeader ?? '';
    }, { signal });
    if (!result.completed) return null;
    return {
      cookieHeader: mergeSessionCookies(session.cookieHeader, result.setCookies),
      userId: session.userId,
    };
  }
}

/** The platform's 401 body: `{ code: 401, loginUrl: "https://account.xiaomi.com/..." }`. */
function extractLoginUrl(body: unknown): string | null {
  const url = asRecord(body)?.['loginUrl'];
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

/** Overlay wins per cookie name — a rotated session cookie replaces the stale one. */
function mergeSessionCookies(header: string, overlay: Map<string, string>): string {
  if (overlay.size === 0) return header;
  const merged = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const [name, value] of overlay) merged.set(name, value);
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function parseMimoTokenPlanResponses(
  usageBody: unknown,
  detailBody: unknown,
): { windows: ProviderQuotaWindow[]; plan?: string } {
  const usageData = asRecord(asRecord(usageBody)?.['data']);
  const detailData = asRecord(asRecord(detailBody)?.['data']);
  const resetsAt = parsePeriodEndMs(asString(detailData?.['currentPeriodEnd']));
  const plan = asString(detailData?.['planName']) ?? undefined;

  // usage first (plan_total_token is the headline allowance), then monthUsage;
  // a name reported twice keeps its first occurrence.
  const buckets: MimoTokenPlanBucket[] = [];
  const seen = new Set<string>();
  for (const groupKey of ['usage', 'monthUsage'] as const) {
    const group = asRecord(usageData?.[groupKey]);
    const items = Array.isArray(group?.['items']) ? group['items'] : [];
    for (const raw of items) {
      const bucket = asRecord(raw) as MimoTokenPlanBucket | null;
      const name = bucket && asString(bucket.name);
      if (!bucket || !name || seen.has(name)) continue;
      seen.add(name);
      buckets.push(bucket);
    }
  }

  const windows: ProviderQuotaWindow[] = [];
  for (const bucket of buckets) {
    const name = asString(bucket.name) ?? 'quota';
    const used = asNumber(bucket.used);
    const limit = asNumber(bucket.limit);
    if (used === null && limit === null) continue; // shape change: no figures
    // A bucket with no real cap (compensation 0/0) is not a meter. Figures
    // that are present but not numbers cannot produce a window without
    // inventing one, so the bucket is dropped (AIO's snapshot has no note
    // field; the standalone monitor names it outright).
    if (limit !== null && limit <= 0) continue;
    if (used === null || limit === null) continue;

    const known = BUCKETS.find((entry) => entry.name === name);
    windows.push({
      kind: 'calendar-period',
      id: known?.id ?? `opencode.${slug(name)}`,
      label: known?.label ?? name.replace(/_/g, ' '),
      unit: 'tokens',
      used: normalizeQuotaAmount(used),
      limit: normalizeQuotaAmount(limit),
      remaining: quotaRemaining(limit, used),
      resetsAt,
      // Plan allowance (prepaid tokens) and granted renewal credit, never
      // paid overage — set explicitly so the unit fallback cannot claim it.
      overage: false,
    });
  }

  return { windows, ...(plan ? { plan } : {}) };
}

/** Naive `currentPeriodEnd` strings are UTC (the console parses them so). */
function parsePeriodEndMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function reauthErrorFor(reason: string | undefined): string {
  switch (reason) {
    case 'denied':
      return 'Harness could not read the Chrome Safe Storage Keychain item — allow access and retry';
    case 'unsupported':
      return 'MiMo Token Plan usage needs macOS (Chrome session cookies)';
    case 'malformed':
      return 'MiMo console cookies could not be read — sign in to the MiMo console in Chrome again';
    default:
      return 'No MiMo console session in Chrome — sign in to the MiMo console in Chrome to see Token Plan usage';
  }
}

function failedSnapshot(
  takenAt: number,
  error: string,
  extra?: { needsReauth?: boolean },
): ProviderQuotaSnapshot {
  return {
    provider: 'opencode',
    takenAt,
    source: 'admin-api',
    ok: false,
    error,
    needsReauth: extra?.needsReauth,
    windows: [],
  };
}

function classifyFetchError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    if ((err as { name?: unknown }).name === 'AbortError') {
      return 'MiMo Token Plan request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `MiMo Token Plan request failed: ${err.message}`
    : 'MiMo Token Plan request failed';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'quota';
}

const defaultFetchPlans: MimoTokenPlanFetch = async (session, { signal, timeoutMs }) => {
  const call = async (url: string) => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onCallerAbort = () => timeoutController.abort();
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const separator = url.includes('?') ? '&' : '?';
      const response = await fetch(
        `${url}${separator}userId=${encodeURIComponent(session.userId)}`,
        {
          method: 'GET',
          signal: timeoutController.signal,
          headers: {
            Accept: 'application/json',
            Cookie: session.cookieHeader,
            'User-Agent': USER_AGENT,
            Referer: `${PLATFORM}/console/plan-manage`,
          },
        },
      );
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        logger.debug('MiMo Token Plan endpoint returned a non-JSON body');
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onCallerAbort);
    }
  };
  return { usage: await call(USAGE_URL), detail: await call(DETAIL_URL) };
};
