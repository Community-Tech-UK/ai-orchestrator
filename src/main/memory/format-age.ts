/**
 * Human-readable, day-granularity age rendering for memory/lesson timestamps
 * surfaced into prompts (P0.3).
 *
 * Deliberately DAY granularity only (never hours/minutes) so a rendered
 * prompt block is stable across repeated calls within the same day — that
 * keeps prompt-cache prefixes intact instead of invalidating on every turn.
 *
 * Pure and dependency-free so it's safe to import from any main-process
 * memory/orchestration module without pulling in Electron or heavier
 * subsystems.
 */

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Render an elapsed-time duration (in ms) as a short, day-granularity phrase:
 * "today", "1 day ago", "N days ago" (2–6 days), or "N week(s) ago" (7+ days).
 *
 * Negative input (clock skew / future timestamps) is clamped to "today"
 * rather than producing a nonsensical "-N days ago".
 */
export function formatAge(ageMs: number): string {
  const days = Math.floor(Math.max(0, ageMs) / ONE_DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
}

/**
 * Whether a timestamp is old enough to warrant a "verify before trusting"
 * caveat. Shared threshold constant so callers stay in sync with the
 * `formatAge` day/week boundary language.
 */
export function isStaleAge(ageMs: number, staleDays: number): boolean {
  return ageMs >= staleDays * ONE_DAY_MS;
}
