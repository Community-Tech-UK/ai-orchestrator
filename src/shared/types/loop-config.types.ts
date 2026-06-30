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
  /** Per-iteration tool-call cap. Default 200. */
  maxToolCallsPerIteration: number;
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
}
