import type { ContextUsage } from '../types/instance.types';

/**
 * Is `usage.percentage` usable as a measure of **context pressure**?
 *
 * Only when a provider actually reported occupancy (LT-018) and that reading is
 * a window occupancy rather than cumulative turn spend (LT-034). Providers
 * declaring `occupancyReporting !== 'current'` — Copilot/ACP, Cursor, Gemini,
 * non-resident Claude, Codex exec — publish a running spend total in `used`,
 * which is monotonically non-decreasing and clamped at 100. Any threshold
 * applied to it fires on tokens billed rather than on context filling up, and
 * then stays fired for the rest of the session.
 *
 * Exported as one shared predicate because this rule had already been written
 * out three separate times — the main process's context-warning threshold, the
 * renderer's own copy of that threshold, and the context-budget calculation
 * (itself duplicated across the in-process and worker paths). Each copy had to
 * be found and fixed independently, and the ones that were missed silently
 * degraded behaviour. New consumers of `percentage` should call this rather
 * than re-deriving the condition.
 */
export function isOccupancyPressureReading(
  usage: ContextUsage | undefined,
): usage is ContextUsage {
  return usage?.occupancyReported === true && usage.occupancyIsAggregate !== true;
}
