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
 *
 * A compaction that brings back no fresh reading keeps the old one for display only
 * ({@link POST_COMPACTION_ESTIMATE_SOURCE}). It describes the context before compaction, so no
 * decision may act on it: occupancy is unknown until the next measured reply (Phase D, section 4).
 */
export function isOccupancyPressureReading(
  usage: ContextUsage | undefined,
): usage is ContextUsage {
  return usage?.occupancyReported === true
    && usage.occupancyIsAggregate !== true
    && usage.source !== POST_COMPACTION_ESTIMATE_SOURCE;
}

/** `ContextUsage.source` of the pre-compaction reading kept after a compaction until a measured reply. */
export const POST_COMPACTION_ESTIMATE_SOURCE = 'awaiting-post-compaction-usage';

/** Claude's auto-compaction trigger, shared with the renderer's near-limit note. */
export function selfCompactThreshold(modelWindow: number, ceiling?: number): number {
  return Math.max(0, Math.min(modelWindow, ceiling ?? modelWindow) - 33_000);
}

/** Compact display of token counts in context notes and reason strings. */
export function formatTokensK(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}K` : `${Math.round(value)}`;
}
