import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';

const POST_TURN_FRESH_MS = 10 * 60_000;

export function shouldSkipPostTurnRefresh(snapshot: ProviderQuotaSnapshot | null | undefined, now: number): boolean {
  const age = snapshot ? now - snapshot.takenAt : Number.NaN;
  return snapshot?.ok === true && snapshot.source === 'header' && age >= 0 && age < POST_TURN_FRESH_MS;
}

/** Retry-After is either whole seconds or an HTTP date. Invalid hints use the default. */
export function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header?.trim()) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  const due = Date.parse(value);
  return Number.isFinite(due) ? Math.max(0, due - now) : undefined;
}

export function quotaCooldownMs(retryAfterMs: number | undefined): number {
  const delay = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 5 * 60_000;
  return Math.max(60_000, Math.min(60 * 60_000, delay));
}
