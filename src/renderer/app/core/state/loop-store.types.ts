// Presentational types for the renderer LoopStore. Split out of loop.store.ts
// to keep that file under its LOC ceiling. Re-exported from loop.store.ts so
// existing consumers can keep importing them from the store.

export interface LoopBannerNoProgress {
  kind: 'no-progress';
  loopRunId: string;
  signalId: string;
  message: string;
  shownAt: number;
}

export interface LoopBannerClaimedFailed {
  kind: 'claimed-failed';
  loopRunId: string;
  signal: string;
  failure: string;
  shownAt: number;
}

export type LoopBanner = LoopBannerNoProgress | LoopBannerClaimedFailed;

/**
 * Compact snapshot of the loop's final iteration. Captured into the
 * summary card so the renderer can show "what was changed / what the
 * agent said at the end" without a follow-up `getIterations` IPC.
 *
 * This is intentionally a subset of `LoopIterationPayload` — only the
 * fields the summary card needs — so a future iteration-shape change
 * doesn't ripple into store consumers that just want a recap.
 */
export interface LoopFinalSummaryLastIteration {
  seq: number;
  stage: 'PLAN' | 'REVIEW' | 'IMPLEMENT';
  outputExcerpt: string;
  /** The agent's complete closing message (already bounded upstream by
   *  `boundFullOutput`). The summary card renders this instead of the
   *  detection excerpt so the user sees the whole final response. Falls
   *  back to `outputExcerpt` for pre-migration runs. */
  outputFull: string;
  filesChanged: { path: string; additions: number; deletions: number }[];
  testPassCount: number | null;
  testFailCount: number | null;
  verifyStatus: 'not-run' | 'passed' | 'failed';
  verifyOutputExcerpt: string;
  progressVerdict: 'OK' | 'WARN' | 'CRITICAL';
}

export interface LoopFinalSummary {
  loopRunId: string;
  status: 'completed' | 'completed-needs-review' | 'cancelled' | 'failed' | 'cap-reached' | 'error' | 'no-progress' | 'provider-limit';
  reason: string;
  iterations: number;
  tokens: number;
  costCents: number;
  startedAt: number;
  endedAt: number;
  /** The goal/ask the loop was started with (iteration 0 prompt). Captured
   *  so the user can copy/inspect it after the loop ends without having to
   *  re-open the loop config panel. */
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. Empty when the
   *  loop re-used `initialPrompt` for every iteration. */
  iterationPrompt?: string;
  /** Snapshot of the loop's final iteration so the summary card can show
   *  the agent's closing message + diff stats without round-tripping to
   *  the main process. Absent when the loop terminated before any
   *  iteration completed. */
  lastIteration?: LoopFinalSummaryLastIteration;
}

export interface LoopRunningIteration {
  loopRunId: string;
  seq: number;
  stage: string;
  startedAt: number;
}
