export interface LoopHardCaps {
  /** Max iterations before forced stop. Null means unbounded. Default null. */
  maxIterations: number | null;
  /** Wall-time budget in milliseconds. Default 50h. */
  maxWallTimeMs: number;
  /** Token budget across the whole loop. Null means unbounded. Default null. */
  maxTokens: number | null;
  /**
   * Cost cap in cents. Null means unbounded. Default null for ordinary plan
   * loops, where subscription-plan usage makes the dollar estimate a poor
   * stopping signal. A non-null cost cap is still a precondition for
   * operator-reviewed completion and branch-and-select exploration (LF-3a /
   * LF-5) - both can sit paused/fan-out and burn spend.
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
