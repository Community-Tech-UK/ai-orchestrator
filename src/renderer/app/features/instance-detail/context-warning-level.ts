import { RESTORED_CONTEXT_USAGE_SOURCE } from '../../../../shared/types/instance.types';
import { isOccupancyPressureReading } from '../../../../shared/utils/context-occupancy';
import type { ContextUsage } from '../../core/state/instance/instance.types';

/**
 * Severity of the renderer's own context-pressure banner.
 *
 * `'emergency'` is not cosmetic — `instance-detail.component.html` binds it to
 * `[disabled]` on the composer, so getting this wrong locks the user out of the
 * session.
 */
export type ContextWarningLevel = 'warning' | 'critical' | 'emergency';

/**
 * Decide the banner level from a context reading.
 *
 * Extracted from `InstanceDetailComponent` so the three suppression rules are
 * stated once and testable directly, rather than living in a computed inside a
 * component with a large dependency graph and no spec. The main process has its
 * own copy of this threshold (`checkContextWarningThreshold`); the two are
 * independent, which is exactly how LT-034 survived being "fixed" — suppressing
 * the backend warning did nothing for this one.
 *
 * Returns `null` (no banner, composer never disabled) when:
 *
 * 1. the adapter self-manages auto-compaction (Claude CLI always; Codex in
 *    app-server mode) — it handles context internally, so the orchestrator's
 *    warning is redundant and its input-block is misleading;
 * 2. no provider has reported occupancy (LT-018) — the create-time seed is a
 *    placeholder, not a reading;
 * 3. the reading is cumulative turn spend rather than window occupancy
 *    (LT-034). This one matters most: spend is monotonically non-decreasing and
 *    clamped at 100, so *every* long session on an aggregate-only provider
 *    (Copilot/ACP, Gemini, non-resident Claude, Codex exec) eventually crosses
 *    95 % and disables its own composer, over a context that may be nearly
 *    empty.
 */
export function resolveContextWarningLevel(
  usage: ContextUsage | undefined,
  selfManagesAutoCompaction: boolean | undefined,
): ContextWarningLevel | null {
  if (selfManagesAutoCompaction) return null;
  // LT-034: one shared predicate, not a fourth hand-rolled copy of this rule.
  if (!isOccupancyPressureReading(usage)) return null;

  const pct = usage.percentage;
  // LT-034: a reading restored from persisted state is evidence the context
  // *was* full — worth a banner — but it is not fresh enough to justify locking
  // the composer, and locking it blocks the only thing that produces a fresh
  // reading. Cap a restored reading at 'critical' (banner shows, input stays
  // usable); the next turn's real context event promotes it if still true.
  //
  // Without this, any session hibernated before `occupancyIsAggregate` existed
  // wakes with a pinned spend percentage, no flag, and a disabled composer.
  const isRestored = usage.source === RESTORED_CONTEXT_USAGE_SOURCE;
  if (pct >= 95) return isRestored ? 'critical' : 'emergency';
  if (pct >= 80) return 'critical';
  if (pct >= 75) return 'warning';
  return null;
}
