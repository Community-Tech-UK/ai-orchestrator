/**
 * Plain rules for Claude's prompt cache (Oct-2 T13).
 *
 * Claude re-reads a long conversation cheaply while its cache is warm and pays
 * to rewrite the whole thing once the cache has expired. Three decisions use the
 * same numbers, so they live here once:
 *
 * - how long the cache lasts (measured from the replies, one hour until a reply
 *   says otherwise),
 * - whether a session that will sleep for a known time should shrink first,
 * - whether to suggest a fresh session to someone who has been away.
 *
 * Pure functions only: no clocks, no I/O, safe for the main process and the renderer.
 */

import type { ContextUsage } from '../types/instance.types';
import { isOccupancyPressureReading } from './context-occupancy';

/** Assumed until a reply reports its cache writes; Claude's main sessions write the 1-hour cache. */
export const CACHE_LIFETIME_FALLBACK_MS = 60 * 60_000;
/** Ignore a "lifetime" longer than this: it is not a reading we should trust. */
const MAX_PLAUSIBLE_LIFETIME_MS = 24 * 60 * 60_000;

/** Shrink before a known long sleep only when the session holds at least this much. */
export const SLEEP_COMPACT_MIN_TOKENS = 200_000;
/** Claude Code's own wording: suggest a fresh session after 75 idle minutes at 100K or more. */
export const IDLE_HINT_MIN_TOKENS = 100_000;
export const IDLE_HINT_AFTER_MS = 75 * 60_000;

/** The measured lifetime when it is a sensible number, else the one-hour assumption. */
export function resolveCacheLifetimeMs(measuredMs?: number | null): number {
  return typeof measuredMs === 'number' && Number.isFinite(measuredMs)
    && measuredMs > 0 && measuredMs <= MAX_PLAUSIBLE_LIFETIME_MS
    ? measuredMs
    : CACHE_LIFETIME_FALLBACK_MS;
}

/**
 * What the session really holds, or null when the provider has not told us.
 * Spend totals and placeholders are not a measure of the window, so they never count.
 */
export function trustedContextTokens(usage: ContextUsage | undefined): number | null {
  if (!isOccupancyPressureReading(usage)) return null;
  return Number.isFinite(usage.used) && usage.used > 0 ? usage.used : null;
}

export interface SleepContextInput {
  /** Time until the session is next used, or null when that is not known. */
  sleepMs: number | null | undefined;
  /** What the session holds now (see {@link trustedContextTokens}), or null when unknown. */
  contextTokens: number | null | undefined;
  /** Measured cache lifetime, when a reply has reported one. */
  cacheLifetimeMs?: number | null;
  /** A compaction can run now (it needs the provider to answer). */
  canCompact: boolean;
  /** Starting over from a hand-off note is acceptable and available. */
  canRecycle: boolean;
}

export type SleepContextDecision =
  | { action: 'none'; reason: string }
  | { action: 'compact' | 'recycle'; reason: string; cacheLifetimeMs: number };

/**
 * Break-even is a ~15% chance the session is used again; a session with a known
 * wake-up is used again with certainty, so a long enough sleep always qualifies.
 */
export function decideSleepContext(input: SleepContextInput): SleepContextDecision {
  const lifetimeMs = resolveCacheLifetimeMs(input.cacheLifetimeMs);
  const { sleepMs, contextTokens } = input;
  if (typeof sleepMs !== 'number' || !Number.isFinite(sleepMs)) {
    return { action: 'none', reason: 'the wake-up time is not known' };
  }
  if (sleepMs <= lifetimeMs) {
    return { action: 'none', reason: 'the session wakes before its cache expires' };
  }
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) {
    return { action: 'none', reason: 'the session size is not known' };
  }
  if (contextTokens < SLEEP_COMPACT_MIN_TOKENS) {
    return { action: 'none', reason: 'the session is small enough to re-read cheaply' };
  }
  if (input.canCompact) {
    return { action: 'compact', reason: 'long sleep with a large session', cacheLifetimeMs: lifetimeMs };
  }
  if (input.canRecycle) {
    return { action: 'recycle', reason: 'long sleep with a large session', cacheLifetimeMs: lifetimeMs };
  }
  return { action: 'none', reason: 'no safe way to shrink the session right now' };
}

export interface IdleHintInput {
  provider: string | undefined;
  status: string | undefined;
  /** Time since the session last did anything. */
  idleMs: number;
  /** See {@link trustedContextTokens}. */
  contextTokens: number | null | undefined;
  cacheLifetimeMs?: number | null;
  /** A loop wake-up or scheduled job is waiting to use this session. */
  wakeUpPending: boolean;
  /** Claude has background agents or shell tasks running. */
  backgroundWorkPending: boolean;
  /** A permission or question dialog is open. */
  dialogPending: boolean;
}

export type IdleHintDecision =
  | { show: false; reason: string }
  | { show: true; tokens: number; text: string };

/** Statuses where the person is simply away; anything else means something is happening. */
const RESTING_STATUSES: ReadonlySet<string> = new Set(['idle', 'hibernated']);

export function decideIdleHint(input: IdleHintInput): IdleHintDecision {
  if (input.provider !== 'claude') return { show: false, reason: 'not a Claude session' };
  if (!input.status || !RESTING_STATUSES.has(input.status)) return { show: false, reason: 'the session is busy' };
  if (input.wakeUpPending) return { show: false, reason: 'a wake-up is waiting for this session' };
  if (input.backgroundWorkPending) return { show: false, reason: 'background work is running' };
  if (input.dialogPending) return { show: false, reason: 'a dialog is waiting for an answer' };
  const tokens = input.contextTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < IDLE_HINT_MIN_TOKENS) {
    return { show: false, reason: 'the session is small' };
  }
  // The claim "a fresh session would skip re-reading" is only true once the cache has expired.
  const after = Math.max(IDLE_HINT_AFTER_MS, resolveCacheLifetimeMs(input.cacheLifetimeMs));
  if (!Number.isFinite(input.idleMs) || input.idleMs < after) return { show: false, reason: 'not idle long enough' };
  return { show: true, tokens, text: idleHintText(tokens) };
}

/** "230K", "1.2M": two significant figures, because the hint says "about". */
export function formatApproxTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  const thousands = tokens >= 100_000 ? Math.round(tokens / 10_000) * 10 : Math.max(1, Math.round(tokens / 1_000));
  return `${thousands}K`;
}

export function idleHintText(tokens: number): string {
  return `Starting something new? A fresh session would skip re-reading about ${formatApproxTokens(tokens)} tokens.`;
}
