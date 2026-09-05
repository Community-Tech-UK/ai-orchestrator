export interface LoopHardCaps {
  /** Max iterations before forced stop. Null means unbounded. Default 50. */
  maxIterations: number | null;
  /** Wall-time budget in milliseconds. Default 50h. */
  maxWallTimeMs: number;
  /** Token budget across the whole loop. Null means unbounded (the default) so
   *  the iteration/wall-time caps govern instead. */
  maxTokens: number | null;
  /**
   * Estimated cost cap in cents. Null means unbounded (the default). This is
   * an optional local safety cap, not a provider billing/subscription limit.
   */
  maxCostCents: number | null;
  /**
   * T40 (Decision 12): `maxToolCallsPerIteration` was removed. It was stored,
   * merged and clamped, but `checkLoopHardCaps` never read it and nothing else
   * in `src/main/orchestration` did either — a control that looked like a stop
   * and was not one. The number that actually fires is the doom-loop
   * `runawayCap`, a warn/critical EVENT gated by `toolLoopAutoInterrupt`.
   * `maxTurnsPerIteration` (on `LoopConfig`) IS wired and is the real
   * per-iteration bound. Do not reintroduce a second stop beside doom-loop
   * runaway without deciding which one owns the terminal decision (G30).
   * Legacy persisted configs carrying the key are ignored, not rejected.
   */
  /**
   * LF-7: max number of completion attempts where verify PASSED but the
   * `*_Completed.md` rename belt-and-braces gate kept blocking, before the
   * loop stops oscillating and terminates as `cap-reached` with a clear
   * reason. Bounds the "declare done -> rename gate rejects -> re-declare" spin
   * at this count instead of letting it run all the way to `maxIterations`.
   * Optional; defaults to 3 via `defaultLoopConfig` and is read defensively
   * (`?? 3`) so configs/tests that omit it still bound.
   */
  maxCompletionAttempts?: number;
  /**
   * D2 (#6, prompt-only interim): when a hard cap fires, run ONE final
   * iteration with a strong "summarize, do not start new work" directive so
   * the run ends with a structured hand-off instead of an abrupt mid-action
   * cut, then terminate. Not API-enforced (tools stay available) — the full
   * tools-disabled variant needs per-provider adapter plumbing and is
   * deferred. Optional; defaults to true, read defensively (`?? true`).
   */
  capWrapUpIteration?: boolean;
}
