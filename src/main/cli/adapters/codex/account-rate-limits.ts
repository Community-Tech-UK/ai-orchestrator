/**
 * Codex app-server account identity and rate-limit payloads
 * (`account/read`, `account/rateLimits/read`, `account/rateLimits/updated`).
 *
 * The generated protocol table only names these methods, so the shapes are
 * parsed defensively here: every field is optional and field-picked. Windows
 * are classified by `windowDurationMins` (300 = 5-hour, 10080 = weekly), never
 * by their primary/secondary position, as the protocol source requires.
 */

import type { ProviderQuotaSnapshot, ProviderQuotaWindow, ProviderUsageAccess } from '../../../../shared/types/provider-quota.types';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  /**
   * Purchased credits can pay for turns: `credits.hasCredits` or
   * `credits.unlimited`, and no spend-control limit reached. Null when the
   * payload carried no credits block (sparse updates usually do not).
   */
  creditsAvailable: boolean | null;
}

export interface CodexAccountRateLimitsRead {
  ordinaryUsageAllowed: boolean | null;
  rateLimits: CodexRateLimitSnapshot | null;
  accountId: string | null;
}

export interface CodexAccountIdentity {
  email: string | null;
  planType: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown, max = 320): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown): CodexRateLimitWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const usedPercent = num(raw['usedPercent'] ?? raw['used_percent']);
  if (usedPercent === null) return null;
  const resetsAtSeconds = num(raw['resetsAt'] ?? raw['resets_at']);
  return {
    usedPercent: Math.max(0, usedPercent),
    windowDurationMins: num(raw['windowDurationMins'] ?? raw['window_minutes']),
    resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
  };
}

function parseCreditsAvailable(raw: Record<string, unknown>): boolean | null {
  const credits = record(raw['credits']);
  if (!credits) return null;
  const hasCredits = credits['hasCredits'] ?? credits['has_credits'];
  const unlimited = credits['unlimited'];
  if (typeof hasCredits !== 'boolean' && typeof unlimited !== 'boolean') return null;
  const spendControlReached = raw['spendControlReached'] ?? raw['spend_control_reached'];
  return (hasCredits === true || unlimited === true) && spendControlReached !== true;
}

export function parseCodexRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    primary: parseWindow(raw['primary']),
    secondary: parseWindow(raw['secondary']),
    planType: str(raw['planType'] ?? raw['plan_type'], 64),
    rateLimitReachedType: str(raw['rateLimitReachedType'] ?? raw['rate_limit_reached_type'], 128),
    creditsAvailable: parseCreditsAvailable(raw),
  };
}

export function parseCodexAccountRateLimitsRead(value: unknown): CodexAccountRateLimitsRead {
  const raw = record(value) ?? {};
  const allowed = raw['ordinaryUsageAllowed'];
  return {
    ordinaryUsageAllowed: typeof allowed === 'boolean' ? allowed : null,
    rateLimits: parseCodexRateLimitSnapshot(raw['rateLimits']),
    accountId: str(raw['accountId'], 128),
  };
}

export function parseCodexAccountRead(value: unknown): CodexAccountIdentity {
  const raw = record(value) ?? {};
  const account = record(raw['account']) ?? {};
  return {
    email: str(account['email']),
    planType: str(account['planType'] ?? account['plan_type'], 64),
  };
}

export type CodexWindowKind = 'five-hour' | 'weekly' | 'other';

export function classifyCodexWindow(window: CodexRateLimitWindow): CodexWindowKind {
  if (window.windowDurationMins === 300) return 'five-hour';
  if (window.windowDurationMins === 10080) return 'weekly';
  return 'other';
}

/**
 * Reset time for a usage-limit rejection: the soonest reset among exhausted
 * windows, else the primary window's reset.
 */
export function codexLimitResetAt(snapshot: CodexRateLimitSnapshot | null): number | null {
  if (!snapshot) return null;
  const windows = [snapshot.primary, snapshot.secondary].filter((entry): entry is CodexRateLimitWindow => entry !== null);
  const exhausted = windows
    .filter((entry) => entry.usedPercent >= 100 && entry.resetsAt !== null)
    .map((entry) => entry.resetsAt as number);
  if (exhausted.length > 0) return Math.min(...exhausted);
  return snapshot.primary?.resetsAt ?? null;
}

/** Quota windows for the provider quota snapshot (`percent` unit). */
export function codexRateLimitsToQuotaWindows(snapshot: CodexRateLimitSnapshot): ProviderQuotaWindow[] {
  const result: ProviderQuotaWindow[] = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue;
    const kind = classifyCodexWindow(window);
    const id = kind === 'five-hour' ? 'codex.5h' : kind === 'weekly' ? 'codex.weekly' : `codex.${window.windowDurationMins ?? 'window'}m`;
    const label = kind === 'five-hour' ? '5-hour window' : kind === 'weekly' ? 'Weekly window' : 'Usage window';
    const used = Math.min(100, window.usedPercent);
    result.push({
      kind: 'rolling-window',
      id,
      label,
      unit: 'percent',
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      resetsAt: window.resetsAt,
    });
  }
  return result;
}

/** Merge a sparse `account/rateLimits/updated` snapshot into the last known one. */
export function mergeCodexRateLimitSnapshots(
  previous: CodexRateLimitSnapshot | null,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot {
  return {
    primary: update.primary ?? previous?.primary ?? null,
    secondary: update.secondary ?? previous?.secondary ?? null,
    planType: update.planType ?? previous?.planType ?? null,
    rateLimitReachedType: update.rateLimitReachedType ?? previous?.rateLimitReachedType ?? null,
    creditsAvailable: update.creditsAvailable ?? previous?.creditsAvailable ?? null,
  };
}

/**
 * Usage access for a snapshot. `ordinaryUsageAllowed` only comes from
 * `account/rateLimits/read`; a live update leaves it unknown rather than
 * carrying an older verdict past newer window numbers.
 */
export function codexUsageAccess(
  snapshot: CodexRateLimitSnapshot,
  ordinaryUsageAllowed: boolean | null = null,
): ProviderUsageAccess | null {
  return ordinaryUsageAllowed === null && snapshot.creditsAvailable === null
    ? null
    : { ordinaryUsageAllowed, creditsAvailable: snapshot.creditsAvailable };
}

export function codexQuotaSnapshot(
  snapshot: CodexRateLimitSnapshot,
  ordinaryUsageAllowed: boolean | null = null,
): Omit<ProviderQuotaSnapshot, 'takenAt' | 'source'> {
  const usageAccess = codexUsageAccess(snapshot, ordinaryUsageAllowed);
  return {
    provider: 'codex',
    ok: true,
    windows: codexRateLimitsToQuotaWindows(snapshot),
    ...(usageAccess ? { usageAccess } : {}),
    ...(snapshot.planType ? { plan: snapshot.planType } : {}),
  };
}
