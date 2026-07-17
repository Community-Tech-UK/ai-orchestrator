import type { CliRateLimitInfo } from '../../shared/types/cli.types';
import { isProviderNotice } from '../cli/provider-notice';
import { extractProviderErrorDiagnostics } from './instance-communication.diagnostics';

/**
 * A turn that stopped on a provider rate/session limit, with the reset time (if
 * the provider told us one) and a short human reason. Returned by the detectors
 * below; `null` means "not a provider limit — handle normally".
 *
 * Extracted from InstanceCommunicationManager to keep that file within its size
 * ceiling and to unit-test the classification in isolation.
 */
export interface ProviderLimitTurnSignal {
  resetAtHint: number | null;
  reason: string;
}

/**
 * Reset time (epoch ms) from the CLI's own rate-limit telemetry
 * (`rate_limit_event`), or null when there is no active throttle window. The
 * raw `resetsAt` is in seconds; a past reset means the window already rolled
 * over, so stale telemetry from an earlier throttle never contributes.
 */
function telemetryResetAtMs(telemetry: CliRateLimitInfo | null | undefined): number | null {
  if (typeof telemetry?.resetsAt !== 'number') return null;
  const resetsAtMs = telemetry.resetsAt * 1000;
  return resetsAtMs > Date.now() ? resetsAtMs : null;
}

/**
 * Latest rate-limit telemetry from the adapter, when the concrete adapter
 * exposes it (currently the Claude adapter's `getLastRateLimitInfo()`); null
 * for adapters without telemetry, which keeps the text-based detection intact.
 */
export function readAdapterRateLimitTelemetry(adapter: unknown): CliRateLimitInfo | null {
  const candidate = adapter as { getLastRateLimitInfo?: () => CliRateLimitInfo | null } | null;
  return typeof candidate?.getLastRateLimitInfo === 'function'
    ? candidate.getLastRateLimitInfo()
    : null;
}

/** Classify a thrown adapter error as a provider limit (or not). */
export function detectErrorProviderLimit(
  error: unknown,
  errorMessage: string,
  telemetry?: CliRateLimitInfo | null,
): ProviderLimitTurnSignal | null {
  const diagnostics = extractProviderErrorDiagnostics(error);
  const telemetryResetAt = telemetryResetAtMs(telemetry);
  // A live "rejected" window means the provider is actively refusing turns, so
  // an errored turn is a limit stop even when the error text itself is generic
  // (e.g. a bare stream close after the CLI's rate_limit_event).
  const rejectedByTelemetry = telemetry?.status === 'rejected' && telemetryResetAt !== null;
  const looksLikeLimit =
    diagnostics.rateLimit !== undefined
    || diagnostics.quota !== undefined
    || isProviderNotice(errorMessage)
    || rejectedByTelemetry;
  if (!looksLikeLimit) return null;
  return {
    resetAtHint:
      diagnostics.rateLimit?.resetAt
      ?? diagnostics.quota?.resetAt
      ?? parseResetHintFromText(errorMessage, Date.now())
      ?? telemetryResetAt,
    reason: `provider limit on turn: ${errorMessage.slice(0, 160)}`,
  };
}

/**
 * Classify a *completed* turn (exit 0) whose assistant content is actually a
 * provider limit notice ("You've hit your session limit · resets 6:30pm").
 */
export function detectCompletionProviderLimit(
  response: { content?: string; metadata?: unknown },
  telemetry?: CliRateLimitInfo | null,
): ProviderLimitTurnSignal | null {
  if (!isProviderNotice(response.content)) return null;
  const diagnostics = extractProviderErrorDiagnostics(response.metadata);
  return {
    resetAtHint:
      diagnostics.rateLimit?.resetAt
      ?? diagnostics.quota?.resetAt
      ?? parseResetHintFromText(response.content ?? '', Date.now())
      ?? telemetryResetAtMs(telemetry),
    reason: `provider limit notice on completed turn: ${(response.content ?? '').slice(0, 160)}`,
  };
}

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

const ISO_RESET_RE = /\breset(?:s)?\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s.,;]+)/i;

// Codex weekly-limit errors state an absolute date: "try again at Jul 21st,
// 2026 9:37 PM." Month name + day (optional ordinal/comma/year) + clock time.
const MONTH_DATE_RESET_RE = /\b(?:try\s+again|resets?)\b(?:\s+at)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?,?\s+(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?|(?=[\s.,;]|$))/i;

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Requires an explicit am/pm marker; bare "HH:MM" falls through to the 24h regex below.
const CLOCK_12H_RE = /\b(?:try\s+again|resets?)\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?/i;

const CLOCK_24H_RE = /\b(?:try\s+again|resets?)\b(?:\s+at)?\s+([01]?\d|2[0-3]):([0-5]\d)\b/i;

const RELATIVE_ANCHOR_RE = /\b(?:try\s+again\s+|retry\s+)?in\s+/gi;
const RELATIVE_HOURS_RE = /(\d+)\s*(?:hours?|hrs?)\b/i;
const RELATIVE_MINUTES_RE = /(\d+)\s*(?:minutes?|mins?)\b/i;
const RELATIVE_SECONDS_RE = /(\d+)\s*(?:seconds?|secs?)\b/i;

/**
 * Parse a provider reset hint out of free-form error/notice text — "try again
 * at 5:01 PM", "resets 6:30pm", "in 45 minutes", or an ISO timestamp. Returns
 * epoch-ms or null. `now` is injected — never call `Date.now()` in here
 * (testability).
 */
export function parseResetHintFromText(text: string, now: number): number | null {
  if (!text) return null;

  const iso = parseIsoResetTimestamp(text);
  if (iso !== null) return clampReasonable(iso, now);

  const monthDate = parseMonthDateResetTimestamp(text, now);
  if (monthDate !== null) return clampReasonable(monthDate, now);

  const relativeMs = parseRelativeDuration(text);
  if (relativeMs !== null) return clampReasonable(now + relativeMs, now);

  const clock = parseClockTime(text, now);
  if (clock !== null) return clampReasonable(clock, now);

  return null;
}

function parseIsoResetTimestamp(text: string): number | null {
  const match = ISO_RESET_RE.exec(text);
  if (!match?.[1]) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

// "try again at Jul 21st, 2026 9:37 PM" → local epoch-ms. A missing year means
// the nearest upcoming occurrence of that date (year rolls forward when the
// date already passed). A 12-hour time requires its am/pm marker to disambiguate.
function parseMonthDateResetTimestamp(text: string, now: number): number | null {
  const match = MONTH_DATE_RESET_RE.exec(text);
  if (!match) return null;

  const month = MONTH_INDEX[match[1].toLowerCase()];
  const day = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : null;
  let hour = Number(match[4]);
  const minute = match[5] ? Number(match[5]) : 0;
  const meridiem = match[6]?.toLowerCase();
  if (day < 1 || day > 31 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12;
    if (meridiem === 'p') hour += 12;
  } else if (hour > 23) {
    return null;
  }

  const year = explicitYear ?? new Date(now).getFullYear();
  const candidate = new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (!Number.isFinite(candidate)) return null;
  if (explicitYear === null && candidate <= now) {
    return new Date(year + 1, month, day, hour, minute, 0, 0).getTime();
  }
  return candidate;
}

// Tries every "in " anchor in the text, not just the first — a spurious
// earlier "in " (e.g. "configured in your settings...") must not shadow a
// real duration later in the string ("...try again in 45 minutes").
function parseRelativeDuration(text: string): number | null {
  for (const anchor of text.matchAll(RELATIVE_ANCHOR_RE)) {
    const start = (anchor.index ?? 0) + anchor[0].length;
    const rest = text.slice(start, start + 40);
    const hourMatch = RELATIVE_HOURS_RE.exec(rest);
    const minuteMatch = RELATIVE_MINUTES_RE.exec(rest);
    const secondMatch = RELATIVE_SECONDS_RE.exec(rest);
    if (!hourMatch && !minuteMatch && !secondMatch) continue;
    const hours = hourMatch ? Number(hourMatch[1]) : 0;
    const minutes = minuteMatch ? Number(minuteMatch[1]) : 0;
    const seconds = secondMatch ? Number(secondMatch[1]) : 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return null;
}

function parseClockTime(text: string, now: number): number | null {
  const twelveHour = CLOCK_12H_RE.exec(text);
  if (twelveHour) {
    const hour12 = Number(twelveHour[1]);
    const minute = twelveHour[2] ? Number(twelveHour[2]) : 0;
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
    const meridiem = twelveHour[3].toLowerCase();
    let hour24 = hour12 % 12;
    if (meridiem === 'p') hour24 += 12;
    return buildClockCandidate(hour24, minute, now);
  }
  const twentyFourHour = CLOCK_24H_RE.exec(text);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    if (hour > 23 || minute > 59) return null;
    return buildClockCandidate(hour, minute, now);
  }
  return null;
}

// Rolls forward a day when the time-of-day has already passed today. Uses
// simple local-date arithmetic (via the Date constructor's local fields), not
// DST-aware math — acceptable given the <=1-day rollover window.
function buildClockCandidate(hour: number, minute: number, now: number): number {
  const base = new Date(now);
  let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
  if (candidate <= now) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

function clampReasonable(candidateMs: number, now: number): number | null {
  if (candidateMs <= now) return null;
  return candidateMs - now > EIGHT_DAYS_MS ? null : candidateMs;
}
