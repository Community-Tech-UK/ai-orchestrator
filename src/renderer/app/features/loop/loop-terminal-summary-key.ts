import type { LoopFinalSummary } from '../../core/state/loop-store.types';

/**
 * Refresh key for the past-runs panel. A finished run's worktree outcome
 * arrives as later state broadcasts for the same `loopRunId` (harvesting →
 * harvested → blocked/promoted/cleaned), so the key includes the lifecycle
 * phase; the run id alone re-pulled history only once (LT-640).
 */
export function terminalSummaryRefreshKey(
  summary: Pick<LoopFinalSummary, 'loopRunId' | 'worktreeLifecycle'> | null | undefined,
): string | null {
  if (!summary) return null;
  return `${summary.loopRunId}:${summary.worktreeLifecycle?.phase ?? ''}`;
}
