/**
 * CursorUsageSummaryProbe
 *
 * Independent Harness probe for Cursor quota. It mirrors the standalone
 * token-usage-monitor's Cursor path: read the Cursor dashboard session JWT
 * from Keychain, send it as the WorkOS dashboard cookie, and parse
 * `POST https://cursor.com/api/usage-summary`.
 *
 * Read-only discipline: this probe never touches Cursor's refresh token and
 * never writes credentials. Expired/missing session token means ok=false.
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
  CursorCredentialsReader,
  type CursorCredentialFailureReason,
} from './cursor-credentials-reader';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CursorUsageSummaryProbe');

const USAGE_URL = 'https://cursor.com/api/usage-summary';
const USER_AGENT = 'cursor-agent/usage-poller';
const DEFAULT_TIMEOUT_MS = 10_000;

export type CursorUsageFetch = (
  token: string,
  subject: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface CursorUsageSummaryProbeOptions {
  credentialsReader?: Pick<CursorCredentialsReader, 'read'>;
  fetchUsage?: CursorUsageFetch;
  timeoutMs?: number;
}

interface CursorUsageWindowSource {
  enabled?: boolean;
  used?: number | null;
  limit?: number | null;
  totalPercentUsed?: number | null;
}

interface CursorIndividualUsage {
  plan?: CursorUsageWindowSource | null;
  onDemand?: CursorUsageWindowSource | null;
}

interface CursorUsageSummaryPayload {
  membershipType?: string | null;
  billingCycleEnd?: string | null;
  individualUsage?: CursorIndividualUsage | null;
}

export class CursorUsageSummaryProbe implements ProviderQuotaProbe {
  readonly provider = 'cursor' as const;

  private readonly credentialsReader: Pick<CursorCredentialsReader, 'read'>;
  private readonly fetchUsage: CursorUsageFetch;
  private readonly timeoutMs: number;

  constructor(opts: CursorUsageSummaryProbeOptions = {}) {
    this.credentialsReader = opts.credentialsReader ?? new CursorCredentialsReader();
    this.fetchUsage = opts.fetchUsage ?? defaultFetchUsage;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();

    const { credential, reason } = await this.credentialsReader.read();
    if (!credential) {
      return failedSnapshot(takenAt, describeCredentialFailure(reason), {
        needsReauth: reason === 'expired' || reason === 'not-found' || reason === 'malformed',
      });
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchUsage(credential.token, credential.subject, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(
        takenAt,
        'Cursor session cookie rejected (401/403) — open Cursor and sign in to refresh',
        { needsReauth: true },
      );
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Cursor usage-summary endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Cursor usage-summary endpoint returned HTTP ${status}`);
    }

    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Cursor usage-summary endpoint returned an unexpected body');
    }

    const payload = body as CursorUsageSummaryPayload;
    const windows = parseCursorUsageSummaryPayload(payload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Cursor usage-summary endpoint returned no usage windows');
    }

    return {
      provider: 'cursor',
      takenAt,
      source: 'admin-api',
      ok: true,
      plan: typeof payload.membershipType === 'string' ? payload.membershipType : undefined,
      windows,
    };
  }
}

export function parseCursorUsageSummaryPayload(
  payload: CursorUsageSummaryPayload,
): ProviderQuotaWindow[] {
  const resetAt = parseResetsAt(payload.billingCycleEnd);
  const usage = payload.individualUsage;
  if (!usage || typeof usage !== 'object') return [];

  const windows: ProviderQuotaWindow[] = [];
  const plan = usage.plan;
  if (plan?.enabled) {
    const used = clampQuotaPercent(
      typeof plan.totalPercentUsed === 'number'
        ? plan.totalPercentUsed
        : percentageFromUsedLimit(plan.used, plan.limit),
    );
    windows.push(percentWindow('cursor.included', 'Included usage', used, resetAt));
  }

  const onDemand = usage.onDemand;
  if (onDemand?.enabled) {
    const used = clampQuotaPercent(percentageFromUsedLimit(onDemand.used, onDemand.limit));
    windows.push(percentWindow('cursor.on-demand', 'On-demand spend', used, resetAt));
  }

  return windows;
}

function percentWindow(
  id: string,
  label: string,
  used: number,
  resetsAt: number | null,
): ProviderQuotaWindow {
  return {
    kind: 'calendar-period',
    id,
    label,
    unit: 'usd',
    used,
    limit: 100,
    remaining: quotaRemaining(100, used),
    resetsAt,
  };
}

function percentageFromUsedLimit(used: number | null | undefined, limit: number | null | undefined): number {
  if (typeof used !== 'number' || !Number.isFinite(used)) return 0;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 0;
  return (used / limit) * 100;
}

function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function failedSnapshot(
  takenAt: number,
  error: string,
  extra?: { needsReauth?: boolean },
): ProviderQuotaSnapshot {
  return {
    provider: 'cursor',
    takenAt,
    source: 'admin-api',
    ok: false,
    error,
    needsReauth: extra?.needsReauth,
    windows: [],
  };
}

function describeCredentialFailure(reason: CursorCredentialFailureReason | undefined): string {
  switch (reason) {
    case 'expired':
      return 'Cursor session token is expired — open Cursor and sign in to refresh';
    case 'denied':
      return 'Keychain access denied reading the Cursor session token';
    case 'malformed':
      return 'Stored Cursor session token is malformed — open Cursor and sign in again';
    case 'unsupported':
      return 'Cursor usage polling currently requires the macOS Keychain session token';
    case 'not-found':
    default:
      return 'Cursor is not signed in — open Cursor and sign in';
  }
}

function classifyFetchError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError') return 'Cursor usage-summary request aborted/timed out';
  }
  return err instanceof Error
    ? `Cursor usage-summary request failed: ${err.message}`
    : 'Cursor usage-summary request failed';
}

const defaultFetchUsage: CursorUsageFetch = async (token, subject, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(USAGE_URL, {
      method: 'POST',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `WorkosCursorSessionToken=${subject}::${token}`,
        Origin: 'https://cursor.com',
        'User-Agent': USER_AGENT,
      },
      body: '{}',
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      logger.debug('Cursor usage-summary endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
