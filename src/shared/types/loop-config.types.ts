export interface LoopHardCaps {
  /** Max iterations before forced stop. Default 500. */
  maxIterations: number;
  /** Wall-time budget in milliseconds. Default 8h. */
  maxWallTimeMs: number;
  /** Token spend cap (approx - measured per iteration). Null means unbounded. */
  maxTokens: number | null;
  /**
   * Cost cap in cents. Null means unbounded. Default 50000 ($500) - a high
   * backstop so a loop started with no explicit spend config still has a
   * ceiling (LF-3) without biting normal subscription runs (where the dollar
   * estimate is inaccurate). Set to null only deliberately for fully unbounded
   * usage. A non-null cost cap is a precondition for operator-reviewed
   * completion and branch-and-select exploration (LF-3a / LF-5) - both can sit
   * paused/fan-out and burn spend.
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
