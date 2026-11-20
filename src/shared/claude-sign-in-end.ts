/**
 * When a Claude account's sign-in runs out, and how to say so.
 *
 * Claude Code gives every claude.ai sign-in a fixed end date that renewing the
 * short-lived access token does not move; only a fresh `claude auth login`
 * does. `claude auth status --json` reports it as `loginExpiresAt`, the latest
 * the sign-in can last. Claude Code 2.1.327 itself warns that the sign-in
 * "ends between" a date three days earlier and that one, so Harness treats the
 * same three days as the window and warns a week before it opens.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long before `loginExpiresAt` the sign-in may already end (Claude Code 2.1.327). */
export const CLAUDE_SIGN_IN_END_SPREAD_MS = 3 * DAY_MS;

/** Warn this long before the earliest end. */
export const CLAUDE_SIGN_IN_WARNING_LEAD_MS = 7 * DAY_MS;

/** Notification kind for the warning; the notification centre offers "Open accounts" on it. */
export const CLAUDE_SIGN_IN_ENDING_NOTIFICATION_KIND = 'claude-sign-in-ending';

export interface ClaudeSignInEnd {
  /** Earliest moment the sign-in may end. */
  earliest: number;
  /** `loginExpiresAt`: the latest it lasts. */
  latest: number;
}

/** The end window when it is close enough to warn about, otherwise null. */
export function claudeSignInEndingSoon(loginExpiresAt: number | undefined, now: number): ClaudeSignInEnd | null {
  if (loginExpiresAt === undefined || !Number.isFinite(loginExpiresAt)) return null;
  const earliest = loginExpiresAt - CLAUDE_SIGN_IN_END_SPREAD_MS;
  return now >= earliest - CLAUDE_SIGN_IN_WARNING_LEAD_MS ? { earliest, latest: loginExpiresAt } : null;
}

function dayMonth(time: number): string {
  return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/** "ends between 24 and 27 November", completing "This sign-in …". */
export function describeClaudeSignInEnd(end: ClaudeSignInEnd, now: number): string {
  if (now >= end.latest) return `may already have ended (on ${dayMonth(end.latest)} at the latest)`;
  if (now >= end.earliest) return `can end at any time before ${dayMonth(end.latest)}`;
  const from = new Date(end.earliest);
  const to = new Date(end.latest);
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  const start = sameMonth ? String(from.getDate()) : dayMonth(end.earliest);
  return `ends between ${start} and ${dayMonth(end.latest)}`;
}
