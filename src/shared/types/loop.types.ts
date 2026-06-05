// ============ Configuration ============

/** What "fresh eyes" looks like at REVIEW stage. */
export type LoopReviewStyle =
  | 'single'         // single agent at REVIEW
  | 'debate'         // 3-agent in-process debate (Claude only)
  | 'star-chamber';  // Claude + Codex (Gemini deliberately excluded)

/** Where the iteration's LLM context comes from. */
export type LoopContextStrategy = 'fresh-child' | 'hybrid' | 'same-session';

/** Provider for child iterations. v1 supports Claude default, Codex for star-chamber. */
export type LoopProvider = 'claude' | 'codex';

export interface LoopHardCaps {
  /** Max iterations before forced stop. Default 500. */
  maxIterations: number;
  /** Wall-time budget in milliseconds. Default 8h. */
  maxWallTimeMs: number;
  /** Token spend cap (approx — measured per iteration). Default 1_000_000. */
  maxTokens: number;
  /**
   * Cost cap in cents. Null means unbounded. Default 50000 ($500) — a high
   * backstop so a loop started with no explicit spend config still has a
   * ceiling (LF-3) without biting normal subscription runs (where the dollar
   * estimate is inaccurate). Set to null only deliberately for fully unbounded
   * usage. A non-null cost
   * cap is a precondition for operator-reviewed completion and branch-and-select
   * exploration (LF-3a / LF-5) — both can sit paused/fan-out and burn spend.
   */
  maxCostCents: number | null;
  /** Per-iteration tool-call cap. Default 200. */
  maxToolCallsPerIteration: number;
  /**
   * LF-7: max number of completion attempts where verify PASSED but the
   * `*_Completed.md` rename belt-and-braces gate kept blocking, before the
   * loop stops oscillating and terminates as `cap-reached` with a clear
   * reason. Bounds the "declare done → rename gate rejects → re-declare" spin
   * (loopfixex §12.1) at this count instead of letting it run all the way to
   * `maxIterations`. Optional; defaults to 3 via `defaultLoopConfig` and is
   * read defensively (`?? 3`) so configs/tests that omit it still bound.
   */
  maxCompletionAttempts?: number;
}

export interface LoopProgressThresholds {
  /** Identical-work-hash WARN threshold. */
  identicalHashWarnConsecutive: number;     // default 2
  /** Identical-work-hash CRITICAL threshold (consecutive). */
  identicalHashCriticalConsecutive: number; // default 3
  /** Identical-work-hash CRITICAL threshold (within last 5). */
  identicalHashCriticalWindow: number;      // default 3 of 5
  /** Output-similarity WARN mean across last 3. */
  similarityWarnMean: number;               // default 0.85
  /** Output-similarity CRITICAL mean across last 3. */
  similarityCriticalMean: number;           // default 0.92
  /** Stage-stagnation WARN per stage. */
  stageWarnIterations: { PLAN: number; REVIEW: number; IMPLEMENT: number };
  /** Stage-stagnation CRITICAL per stage. */
  stageCriticalIterations: { PLAN: number; REVIEW: number; IMPLEMENT: number };
  /** Same error bucket repeats. */
  errorRepeatWarnInWindow: number;          // default 3 in 5
  errorRepeatCriticalInWindow: number;      // default 4 in 5
  /** Tokens spent without test-pass improvement. */
  tokensWithoutProgressWarn: number;        // default 25_000
  tokensWithoutProgressCritical: number;    // default 60_000
  /**
   * Opt-in to signal F (token-burn-without-test-progress).
   *
   * Default `false`. When false, signal F is suppressed entirely — the
   * detector never WARNs/CRITICALs on token spend alone, so the loop will
   * not pause just because a lot of tokens were used since the last test
   * pass count rose. Many useful tasks (e.g. implementing a new module
   * that has no tests yet) legitimately spend tens of thousands of tokens
   * without moving the test counter, and pausing on that is a usability
   * footgun. Set to true to opt back into the original strict heuristic.
   */
  pauseOnTokenBurn: boolean;                // default false
  /** Within-iteration tool repetition. */
  toolRepeatWarnPerIteration: number;       // default 5
  toolRepeatCriticalPerIteration: number;   // default 8
  /** Test-pass-count unchanged with file writes. */
  testStagnationWarnIterations: number;     // default 3
  testStagnationCriticalIterations: number; // default 5
  /** Edit-churn ratio over last 5. */
  churnRatioWarn: number;                   // default 0.30
  churnRatioCritical: number;               // default 0.50
  /** WARN-to-CRITICAL escalation: warns within 5 iterations. */
  warnEscalationWindow: number;             // default 5
  warnEscalationCount: number;              // default 3
}

/**
 * How the loop decides it is finished.
 *
 * - `'review-driven'` (the default for user-started loops): the loop's *engine*
 *   is a fresh-eyes self-review. Each iteration the model re-reviews its own
 *   work, fixes anything not done or done wrong, and only emits the
 *   `noOutstandingPhrase` when — after a genuine fresh pass — it found nothing
 *   to fix and changed no production code. The loop stops after
 *   `requiredCleanReviewPasses` consecutive such clean passes. There is no
 *   verify-gate / rename-gate / evidence-ladder; the review IS the stop
 *   condition. Mirrors the proven manual workflow ("re-review with fresh eyes,
 *   fix anything not done") without a human typing it each round.
 * - `'gated'`: the legacy evidence-ladder path — a sufficient completion signal
 *   (declared-complete / forensic markers) gated by verify + belt-and-braces +
 *   optional cross-model review. Still fully supported; opt in explicitly.
 */
export type LoopCompletionMode = 'review-driven' | 'gated';

export interface LoopCompletionConfig {
  /**
   * Completion strategy. Defaults to `'gated'` at the engine level
   * (`defaultLoopConfig`) so programmatic callers and the existing test suite
   * keep their behaviour; user-started loops are defaulted to `'review-driven'`
   * by `prepareLoopStartConfig`. Undefined is treated as `'gated'`.
   */
  mode?: LoopCompletionMode;
  /**
   * review-driven only: number of consecutive clean fresh-eyes passes (model
   * emits `noOutstandingPhrase` AND changed no production code) required before
   * the loop stops. Default 2 — one clean pass can be lazy, two in a row is a
   * strong signal. Ignored in `'gated'` mode.
   */
  requiredCleanReviewPasses?: number;
  /**
   * review-driven only: the exact line the model must emit (case-insensitive)
   * to signal "nothing left to do." Default 'There are no outstanding issues'.
   */
  noOutstandingPhrase?: string;
  /**
   * review-driven only: max consecutive CRITICAL no-progress iterations that
   * make NO production change AND do NOT advance the clean-review streak before
   * the loop stops itself as `completed-needs-review`. Review-driven loops are
   * exempt from the structural no-progress *pause* (their convergence looks
   * like a stall), so without this guard a loop that is neither converging nor
   * editing anything spins until a hard cap or the circuit breaker trips
   * (reported as a misleading `error`). Default 3 — CRITICAL already implies a
   * sustained stall, so a few more confirm "stuck re-reviewing" while bounding
   * wasted cost. Ignored in `'gated'` mode.
   */
  maxStalledReviewIterations?: number;
  /** Path glob matched against rename events. */
  completedFilenamePattern: string; // default '*_[Cc]ompleted.md'
  /** Regex applied to iteration output. */
  donePromiseRegex: string;         // default '<promise>\\s*DONE\\s*</promise>'
  /** Sentinel file that indicates "done". */
  doneSentinelFile: string;         // default 'DONE.txt'
  /**
   * Verify command (run before stop). User-facing LOOP_START flows reject an
   * empty command unless one can be inferred from the workspace or
   * `allowOperatorReviewedCompletion` is true. Programmatic callers that
   * still run empty-command loops get a skipped verify and the coordinator
   * pauses on completion for operator review.
   */
  verifyCommand: string;            // default empty; loop prompt asks agent to run appropriate checks
  /**
   * Explicit escape hatch for loops that cannot be independently verified.
   * When true and `verifyCommand` is empty, the loop may start, but it cannot
   * auto-complete: completion evidence pauses the run for operator review.
   */
  allowOperatorReviewedCompletion: boolean; // default false
  /** Verify timeout in ms. */
  verifyTimeoutMs: number;          // default 600_000 (10 min)
  /**
   * Optional cheap verify command run BEFORE the heavyweight `verifyCommand`.
   * When set, a completion attempt runs quick-verify first. If quick-verify
   * fails, the loop rejects completion without running the expensive full
   * verify — saving minutes of test/lint/build time per spurious completion
   * attempt. If quick-verify passes, the loop runs the full `verifyCommand`
   * exactly as before. Typical contents: `npx tsc --noEmit && npm run lint`
   * (fast feedback) while `verifyCommand` holds the full test suite.
   */
  quickVerifyCommand?: string;
  /** Quick-verify timeout in ms (if quickVerifyCommand is set). */
  quickVerifyTimeoutMs?: number;    // default 120_000 (2 min)
  /** Run verify twice (anti-flake) before final stop. */
  runVerifyTwice: boolean;          // default true
  /**
   * Belt-and-braces: also require a *_Completed.md rename to actually have
   * happened during the loop before stopping. This is useful for explicit
   * plan-file workflows, but it is not the general default because many loop
   * runs are direct continuation tasks with no plan file to rename.
   */
  requireCompletedFileRename: boolean; // default false
  /**
   * Optional fresh-eyes cross-model review before accepting completion.
   *
   * When this block is explicitly set with `{ enabled: true }` and the agent
   * declares done (sufficient signal + verify passed + belt-and-braces
   * passed), the coordinator invokes `CrossModelReviewService.runHeadlessReview`
   * against a different CLI provider. Any finding whose severity is in
   * `blockingSeverities` cancels the stop, injects the finding as a user
   * intervention, and lets the loop continue iterating.
   *
   * Undefined means no fresh-eyes gate. The coordinator does not auto-enable
   * this from uncompleted plan files; callers that want the gate must pass it.
   */
  crossModelReview?: LoopCrossModelReviewConfig;
}

export interface LoopCrossModelReviewConfig {
  enabled: boolean;
  /**
   * Provider names to use as reviewers, e.g. `['gemini', 'codex']`.
   * If empty/unset, the review service picks from available CLIs.
   */
  reviewers?: string[];
  /**
   * Severities that block completion. Any finding at or above these levels
   * causes the loop to continue with the finding injected as an
   * intervention. Default: `['critical', 'high']`.
   */
  blockingSeverities: ('critical' | 'high' | 'medium' | 'low')[];
  /** Per-review wall-clock timeout. Default 90s. */
  timeoutSeconds: number;
  /** Review depth — see CrossModelReviewService. Default 'structured'. */
  reviewDepth: 'structured' | 'tiered';
}

export function defaultCrossModelReviewConfig(): LoopCrossModelReviewConfig {
  return {
    enabled: true,
    blockingSeverities: ['critical', 'high'],
    timeoutSeconds: 90,
    reviewDepth: 'structured',
  };
}

/**
 * LF-2 — result of a single semantic-progress check. Records whether the
 * latest iteration measurably advanced the goal, a one-line explanation, and
 * the reviewer's confidence (0..1). Confidence below the configured floor is
 * ignored by the escalation logic, so a low-confidence guess never moves a
 * verdict.
 */
export interface LoopSemanticProgressResult {
  advanced: boolean;
  whatChanged: string;
  confidence: number;
}

/**
 * LF-2 — configuration for the semantic-progress escalation modifier. Default
 * OFF: a loop must opt in, and even then the signal only ever escalates a WARN
 * (confirmed no-progress) or softens a churn-only CRITICAL (confirmed
 * progress) — it is never the sole stop/continue authority.
 */
export interface LoopSemanticProgressConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Periodic check cadence (iterations) while the structural verdict is OK. Default 5. */
  cadence: number;
  /** Minimum confidence for a verdict to modify escalation. Default 0.6. */
  confidenceFloor: number;
}

export function defaultSemanticProgressConfig(): LoopSemanticProgressConfig {
  return { enabled: false, cadence: 5, confidenceFloor: 0.6 };
}

/**
 * LF-1 — context discipline. Same-session loops accumulate the whole transcript
 * across iterations with no orchestrator compaction → context rot → thrash.
 * This makes context management mandatory for the loop's own (non-borrowed)
 * adapter: when utilization crosses `resetAtUtilization`, the loop recycles its
 * persistent same-session adapter to a fresh session, re-anchoring from durable
 * disk state (STAGE/NOTES/ITERATION_LOG/plan + the goal persisted every
 * iteration). Borrowed *instance* adapters are never recycled here — the
 * instance owns its own compaction lifecycle.
 */
export interface LoopContextCompactionConfig {
  /** Master switch. Default true (one of the two default-on safety changes). */
  enabled: boolean;
  /**
   * Utilization (0..1 of the loop context window) at which the loop recycles
   * its own same-session adapter to a fresh session. Default 0.6 — conservative
   * so subtle constraints aren't dropped, and well under the dual-threshold
   * blocking band.
   */
  resetAtUtilization: number;
  /**
   * Hint that tool results may be cleared/offloaded to bound context. The
   * fresh-session recycle already discards accumulated tool output, so this is
   * secondary; reserved for finer-grained output-persistence offload.
   */
  clearToolResults: boolean;
}

export interface LoopContextConfig {
  compaction: LoopContextCompactionConfig;
}

export function defaultLoopContextConfig(): LoopContextConfig {
  return { compaction: { enabled: true, resetAtUtilization: 0.6, clearToolResults: true } };
}

/**
 * LF-1 — approximate loop context window in tokens. Utilization is measured as
 * cumulative same-session tokens / this window. ~200k mirrors a large Claude
 * context; the point is a *relative* ceiling, not an exact match to any model.
 */
export const LOOP_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * LF-5 — branch-and-select (best-of-N) on stuck. When a CRITICAL no-progress
 * would otherwise just pause for a human, fan out `fanout` candidate iterations
 * in isolated worktrees, verify each, pick the best via list-wise comparison,
 * adopt the winner and discard the losers. Opt-in (default OFF), and gated on a
 * non-null cost cap because fan-out multiplies spend.
 */
export interface LoopExplorationConfig {
  /** Master switch. Default false — pure no-op until a loop opts in. */
  enabled: boolean;
  /** Number of parallel candidate iterations. Default 3. */
  fanout: number;
  /** Fan out across providers (Claude + Codex) for diversity. Default false (Claude-only). */
  crossModel: boolean;
  /** Candidate selection strategy. Default verify+listwise. */
  selector: 'verify' | 'verify+listwise';
}

export function defaultLoopExplorationConfig(): LoopExplorationConfig {
  return { enabled: false, fanout: 3, crossModel: false, selector: 'verify+listwise' };
}

/**
 * LF-4 — RPI "disposable plan" behaviour. When the loop stalls (repeated
 * CRITICAL no-progress) instead of grinding, regenerate the plan from the goal:
 * inject a directive telling the agent to throw out the current plan/ledger and
 * re-derive it. Bounded (a few regenerations) so it can't loop forever; after
 * the cap the loop pauses normally. Opt-in (default off).
 */
export interface LoopPlanConfig {
  regenerateOnStall: boolean;
}

export function defaultLoopPlanConfig(): LoopPlanConfig {
  return { regenerateOnStall: false };
}

export interface LoopBlockSanityProbeConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Probe timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface LoopDegradedIterationRetryConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Max retries of the same iteration seq before accepting the result. Default 2. */
  maxRetries: number;
}

/** LF-4 — max disposable-plan regenerations per stall streak before pausing. */
export const LOOP_MAX_PLAN_REGENERATIONS = 2;

export interface LoopConfig {
  /** The goal/ask. Sent on iteration 0 — anchors what the loop drives toward. */
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. If omitted, the
   *  runtime re-uses `initialPrompt` every iteration. State on disk
   *  (`NOTES.md`, `STAGE.md`, the plan file) carries context between iters. */
  iterationPrompt?: string;
  /** Plan file (markdown) the loop should advance until renamed *_Completed.md. */
  planFile?: string;
  /** Working directory for the loop. Defaults to chat's cwd. */
  workspaceCwd: string;
  /** Per-iteration child provider. Default 'claude'. */
  provider: LoopProvider;
  /** Review style at REVIEW stage. */
  reviewStyle: LoopReviewStyle;
  /** Context strategy. */
  contextStrategy: LoopContextStrategy;
  /** Hard absolute caps. */
  caps: LoopHardCaps;
  /** Progress detector thresholds. */
  progressThresholds: LoopProgressThresholds;
  /** LF-2 semantic-progress signal (escalation modifier). Optional; default off. */
  semanticProgress?: LoopSemanticProgressConfig;
  /** LF-1 context discipline (compaction/recycle). Optional; default on. */
  context?: LoopContextConfig;
  /** LF-5 branch-and-select on stuck (best-of-N). Optional; default off. */
  exploration?: LoopExplorationConfig;
  /** LF-4 disposable-plan behaviour (regenerate on stall). Optional; default off. */
  plan?: LoopPlanConfig;
  /** Sanity gate: before honoring a toolchain/environment-class block intent or
   *  BLOCKED.md, run a cheap liveness probe in the workspace. If the toolchain is
   *  actually responsive, the block is self-refuting and is NOT honored. */
  blockSanityProbe?: LoopBlockSanityProbeConfig;
  /** Resilience: retry a transient invocation failure or a "void" iteration
   *  (no output, no files, no tool calls) with a fresh session before counting
   *  it — instead of killing the loop or miscounting it as no-progress.
   *  Optional; default on with maxRetries=2. */
  degradedIterationRetry?: LoopDegradedIterationRetryConfig;
  /** Completion detector config. */
  completion: LoopCompletionConfig;
  /** Allow destructive ops inside the loop (rm -rf, force-push). Default false. */
  allowDestructiveOps: boolean;
  /** Optional: agent's initial stage. Default 'IMPLEMENT'. */
  initialStage: LoopStage;
  /**
   * Whether the loop's goal is an implementation task or an investigation
   * (a question / audit / "explain X" / "is Y done?"). Optional — `undefined`
   * is treated as `'implementation'` everywhere. When `'investigation'`, the
   * loop answers the goal and writes a `REPORT.md` instead of editing
   * production code, and completion is gated on that report. Derived at
   * `startLoop` from the prompt when the caller doesn't set it; an explicit
   * caller value always wins. */
  goalIntent?: LoopGoalIntent;
  /** Wall-clock cap per iteration in ms. Defaults applied by the invoker
   *  if unset (currently 30 minutes). The loop's overall caps.maxWallTimeMs
   *  is enforced separately at the coordinator level. */
  iterationTimeoutMs?: number;
  /** Stream-idle advisory threshold per iteration in ms. The adapter emits
   *  warnings when stdout is silent this long, but Loop Mode relies on the
   *  per-iteration wall-clock timeout as the hard abort path. */
  streamIdleTimeoutMs?: number;
}

/** Default config factory. */
export function defaultLoopConfig(workspaceCwd: string, initialPrompt: string): LoopConfig {
  return {
    initialPrompt,
    // Default to undefined so legacy single-prompt loops keep their existing
    // behaviour (initialPrompt used on every iteration). The renderer fills
    // this in when the user types both a textarea goal and a panel directive.
    iterationPrompt: undefined,
    workspaceCwd,
    provider: 'claude',
    reviewStyle: 'debate',
    contextStrategy: 'same-session',
    caps: {
      maxIterations: 500,
      maxWallTimeMs: 8 * 60 * 60 * 1000,
      maxTokens: 1_000_000,
      // LF-3: default to a $500 backstop. Previously $10, which prematurely
      // killed subscription loops where the dollar estimate is inaccurate;
      // previously null (unbounded), flagged as a footgun. Renderer surfaces
      // this and lets the user clear it to null for no cap.
      maxCostCents: 50000,
      maxToolCallsPerIteration: 200,
      maxCompletionAttempts: 3,
    },
    progressThresholds: {
      identicalHashWarnConsecutive: 2,
      identicalHashCriticalConsecutive: 3,
      identicalHashCriticalWindow: 3,
      similarityWarnMean: 0.85,
      similarityCriticalMean: 0.92,
      stageWarnIterations: { PLAN: 3, REVIEW: 2, IMPLEMENT: 8 },
      stageCriticalIterations: { PLAN: 5, REVIEW: 3, IMPLEMENT: 12 },
      errorRepeatWarnInWindow: 3,
      errorRepeatCriticalInWindow: 4,
      tokensWithoutProgressWarn: 25_000,
      tokensWithoutProgressCritical: 60_000,
      // Default OFF: too many real tasks spend tokens without moving the
      // test pass count, and the user shouldn't have to babysit the loop.
      // Renderer panel exposes a checkbox to opt-in for tests-driven flows.
      pauseOnTokenBurn: false,
      toolRepeatWarnPerIteration: 5,
      toolRepeatCriticalPerIteration: 8,
      testStagnationWarnIterations: 3,
      testStagnationCriticalIterations: 5,
      churnRatioWarn: 0.30,
      churnRatioCritical: 0.50,
      warnEscalationWindow: 5,
      warnEscalationCount: 3,
    },
    semanticProgress: defaultSemanticProgressConfig(),
    context: defaultLoopContextConfig(),
    exploration: defaultLoopExplorationConfig(),
    plan: defaultLoopPlanConfig(),
    blockSanityProbe: { enabled: true, timeoutMs: 5000 },
    degradedIterationRetry: { enabled: true, maxRetries: 2 },
    completion: {
      // Engine default is the legacy gated ladder so the test suite and
      // programmatic callers are unaffected; `prepareLoopStartConfig` upgrades
      // user-started loops to 'review-driven'.
      mode: 'gated',
      requiredCleanReviewPasses: 2,
      noOutstandingPhrase: 'There are no outstanding issues',
      maxStalledReviewIterations: 3,
      completedFilenamePattern: '*_[Cc]ompleted.md',
      donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
      doneSentinelFile: 'DONE.txt',
      verifyCommand: '',
      allowOperatorReviewedCompletion: false,
      verifyTimeoutMs: 600_000,
      // FU-6 quick-verify defaults: undefined command means the optimization
      // is opt-in. A 2-minute timeout reflects "should be fast or it isn't
      // a quick verify". Callers wanting the split set both fields.
      quickVerifyCommand: undefined,
      quickVerifyTimeoutMs: 120_000,
      runVerifyTwice: true,
      requireCompletedFileRename: false,
    },
    allowDestructiveOps: false,
    initialStage: 'IMPLEMENT',
    goalIntent: 'implementation',
    iterationTimeoutMs: undefined,
    streamIdleTimeoutMs: undefined,
  };
}

export type LoopStage = 'PLAN' | 'REVIEW' | 'IMPLEMENT';

/**
 * The kind of goal a loop is pursuing. `'implementation'` is the default
 * (build/fix/refactor — the agent makes code changes that converge to done).
 * `'investigation'` is a question/audit/explain goal: the agent answers it with
 * file:line evidence in a `REPORT.md` and does NOT edit production code. Kept
 * deliberately binary — finer routing belongs to the model-router, not here.
 */
export type LoopGoalIntent = 'implementation' | 'investigation';

export type LoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  /**
   * LF-7: a *successful* terminal state meaning "work is done and was accepted,
   * but a human should glance at it" — reached when an operator accepts a
   * manual-review loop, or when verify kept passing but a secondary gate
   * (the `*_Completed.md` rename) never did within `maxCompletionAttempts`.
   * Distinct from `completed` (fully auto-verified) and from `cap-reached`
   * (stopped without converging). NOT a failure state.
   */
  | 'completed-needs-review'
  | 'cancelled'
  | 'failed'
  | 'error'
  | 'no-progress'
  | 'cap-reached';
// LF-8: `idle` and `verify-failed` were dead enum values — the coordinator
// never emitted them (terminate() is only called with the states above), so
// they implied lifecycle states the system never reached. Removed.

/**
 * LF-7: outcome of the most recent completion attempt. Drives the UI
 * completion-gate stepper (LF-8) and the runbook's "why didn't it stop"
 * diagnosis. Undefined until the first completion attempt.
 */
export type LoopCompletionOutcome =
  | 'accepted'        // completion accepted → terminal completed / completed-needs-review
  | 'verify-failed'   // verify (or quick-verify) failed → rejected, keep iterating
  | 'unverifiable'    // no verify command → paused for operator review
  | 'rename-gate'     // verify passed but the *_Completed.md rename gate blocked
  | 'review-blocked'; // fresh-eyes cross-model review raised a blocking finding

export type LoopVerdict = 'OK' | 'WARN' | 'CRITICAL';

export interface LoopFileChange {
  path: string;
  additions: number;
  deletions: number;
  /**
   * Hash of the resulting line set after this iteration. Used to compute
   * churn (lines that revert to a prior state across iterations).
   */
  contentHash: string;
}

export interface LoopToolCallRecord {
  toolName: string;
  argsHash: string;
  success: boolean;
  durationMs: number;
}

export interface LoopErrorRecord {
  bucket: string;       // ChildErrorClassifier bucket id
  exactHash: string;    // sha256 of normalized message
  excerpt: string;
}

export interface LoopIteration {
  id: string;
  loopRunId: string;
  seq: number;
  stage: LoopStage;
  startedAt: number;
  endedAt: number | null;
  childInstanceId: string | null;
  tokens: number;
  costCents: number;
  filesChanged: LoopFileChange[];
  toolCalls: LoopToolCallRecord[];
  errors: LoopErrorRecord[];
  testPassCount: number | null;
  testFailCount: number | null;
  /** Hash of (sortedFileDiffPaths ‖ stage ‖ toolCallSignature). */
  workHash: string;
  /** Cosine/Jaccard similarity to previous iteration's output text (0..1). */
  outputSimilarityToPrev: number | null;
  /** First & last 2KB of stdout for inspection. */
  outputExcerpt: string;
  progressVerdict: LoopVerdict;
  progressSignals: ProgressSignalEvidence[];
  completionSignalsFired: CompletionSignalEvidence[];
  verifyStatus: 'not-run' | 'passed' | 'failed';
  verifyOutputExcerpt: string;
  /** LF-2 semantic-progress verdict for this iteration (present when the check ran). */
  semanticProgress?: LoopSemanticProgressResult;
}

/**
 * Identifiers from `plan_loop_mode.md` § A. Aggressive no-progress detection.
 * A: Identical work hash
 * B: Edit churn (revert oscillation)
 * C: Stage stagnation
 * D: Test oscillation
 * D'(prime): Test stagnation while files written
 * E: Error repeat
 * F: Token-burn-without-progress
 * G: Tool call repetition
 * H: Output similarity
 */
export type ProgressSignalId = 'A' | 'B' | 'C' | 'D' | 'D-prime' | 'E' | 'F' | 'G' | 'H' | 'BLOCKED';

export interface ProgressSignalEvidence {
  id: ProgressSignalId;
  verdict: LoopVerdict; // OK never recorded; only WARN or CRITICAL.
  message: string;
  /** Optional structured payload for UI rendering. */
  detail?: Record<string, unknown>;
}

export type CompletionSignalId =
  | 'completed-rename'   // *_Completed.md rename
  | 'done-promise'       // <promise>DONE</promise>
  | 'done-sentinel'      // DONE.txt exists
  | 'all-green'          // verify command passes (transition from prev failing)
  | 'self-declared'      // "TASK COMPLETE" in output (auxiliary only)
  | 'plan-checklist'     // PLAN.md checkboxes 100%
  | 'declared-complete'  // explicit loop-control complete intent
  | 'ledger-complete';   // LF-4: every LOOP_TASKS.md item is done/deferred

export interface CompletionSignalEvidence {
  id: CompletionSignalId;
  /**
   * Whether this signal alone can stop the loop. self-declared is always false;
   * all others are true (subject to verify-before-stop).
   */
  sufficient: boolean;
  detail: string;
}

export type LoopTerminalIntentKind = 'complete' | 'block' | 'fail';
export type LoopTerminalIntentStatus = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'superseded';
export type LoopTerminalIntentSource = 'loop-control-cli' | 'imported-file';
export type LoopTerminalIntentEvidenceKind = 'summary' | 'command' | 'file' | 'test' | 'note';

export interface LoopTerminalIntentEvidence {
  kind: LoopTerminalIntentEvidenceKind;
  label: string;
  value: string;
}

export interface LoopTerminalIntent {
  id: string;
  loopRunId: string;
  iterationSeq: number;
  kind: LoopTerminalIntentKind;
  summary: string;
  evidence: LoopTerminalIntentEvidence[];
  source: LoopTerminalIntentSource;
  createdAt: number;
  /**
   * Coordinator clock timestamp. Ordering and terminal eligibility use this
   * value, not the child-controlled createdAt.
   */
  receivedAt: number;
  status: LoopTerminalIntentStatus;
  statusReason?: string;
  filePath?: string;
}

export interface LoopControlMetadata {
  version: 1;
  loopRunId: string;
  workspaceCwd: string;
  controlDir: string;
  controlFile: string;
  intentsDir: string;
  currentIterationSeq: number;
  cliPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoopState {
  id: string;
  chatId: string;
  config: LoopConfig;
  status: LoopStatus;
  startedAt: number;
  endedAt: number | null;
  totalIterations: number;
  totalTokens: number;
  totalCostCents: number;
  currentStage: LoopStage;
  /** Most recent iteration (or undefined if not yet started). */
  lastIteration?: LoopIteration;
  /**
   * Reason and evidence for the loop ending (populated when status enters a
   * terminal state).
   */
  endReason?: string;
  endEvidence?: Record<string, unknown>;
  /** Pending interventions to inject at next iteration. */
  pendingInterventions: string[];
  /** Workspace-local loop-control transport metadata, excluding the secret. */
  loopControl?: LoopControlMetadata;
  /** Current unconsumed terminal intent, if any. */
  terminalIntentPending?: LoopTerminalIntent;
  /** Full accepted/rejected/deferred terminal-intent audit trail for this run. */
  terminalIntentHistory?: LoopTerminalIntent[];
  /** Whether a *_Completed.md rename has been observed during this run. */
  completedFileRenameObserved: boolean;
  /**
   * Workspace snapshot captured at startLoop. Used to differentiate
   * "evidence the agent finished during this run" from "stale artefact
   * left over from a prior run". Without these snapshots, completion
   * signals like done-sentinel and plan-checklist would trigger immediately
   * on iteration 0 whenever a workspace already contains a DONE.txt or a
   * fully-ticked PLAN.md — terminating the loop with zero useful work.
   *
   * Not persisted in SQL columns: re-captured fresh on resume, which is
   * the correct semantic (the workspace may have changed during the pause).
   */
  doneSentinelPresentAtStart: boolean;
  /**
   * True iff the configured planFile (if any) had all checkbox items
   * checked at startLoop. When true, a "fully checked" plan-checklist is
   * already the baseline state and is NOT treated as in-run completion.
   * False when no planFile is configured or the plan was incomplete.
   */
  planChecklistFullyCheckedAtStart: boolean;
  /**
   * Root-level `.md` files that look like uncompleted planning docs at
   * startLoop. Empty when the workspace has none. Drives auto-enabling
   * of `requireCompletedFileRename`: when this list is non-empty and the
   * caller did not explicitly set `requireCompletedFileRename`, the
   * coordinator treats DONE.txt-alone as insufficient and demands at
   * least one `*_Completed.md` rename to fire during the run. This is
   * what catches the failure mode where an agent writes `DONE.txt` but
   * forgets to rename the plan files it was asked to implement.
   */
  uncompletedPlanFilesAtStart: string[];
  /**
   * True when the loop has no configured `verifyCommand` — every
   * completion attempt will be paused for human review instead of
   * auto-completing. Set once at startLoop based on the materialized
   * config; surfaced to the renderer so the UI can label these runs,
   * and to the prompt builder so the agent learns the constraint
   * before its first completion attempt.
   */
  manualReviewOnly: boolean;
  /** Tracks tokens since last test-pass-count improvement. */
  tokensSinceLastTestImprovement: number;
  /** Highest test-pass-count seen so far. */
  highestTestPassCount: number;
  /** Iterations spent on the current stage (resets on stage change). */
  iterationsOnCurrentStage: number;
  /** WARN history for escalation logic — timestamps of recent WARN verdicts. */
  recentWarnIterationSeqs: number[];
  /**
   * LF-7: count of completion attempts where verify passed but the
   * `*_Completed.md` rename gate blocked. When it reaches
   * `caps.maxCompletionAttempts`, the loop terminates as `cap-reached`
   * instead of oscillating. Initialised to 0; persisted with `.default(0)`
   * for back-compat with rows written before the field existed.
   */
  completionAttempts: number;
  /**
   * LF-7: outcome of the most recent completion attempt, for observability +
   * the UI completion-gate stepper. Undefined until the first attempt.
   */
  lastCompletionOutcome?: LoopCompletionOutcome;
  /**
   * LF-4: true iff `LOOP_TASKS.md` was already fully resolved (every item
   * done/deferred) at startLoop. Like `planChecklistFullyCheckedAtStart`, this
   * is a staleness guard — a pre-resolved ledger from a prior run is the
   * baseline, not in-run completion, so `ledger-complete` only fires on an
   * in-run transition. Defaults false (no ledger, or had open items at start).
   */
  loopTasksLedgerResolvedAtStart: boolean;
  /**
   * claude2_todo #1b: fingerprints of the BLOCKING review-thread IDs that the
   * fresh-eyes gate has flagged and that remain unresolved. Persists across
   * completion attempts and is emptied ONLY when a fresh-eyes review returns
   * clean — so the loop "converges only when it empties", and a re-run that
   * surfaces the same findings is recognized as the same unresolved thread
   * (not fresh progress). In-memory only (not persisted). Undefined until the
   * first blocking review.
   */
  unresolvedReviewThreads?: string[];
  /**
   * claude2_todo #1c: bounded ring buffer of recent completion-attempt
   * evidence hashes (most-recent last). Used to detect when the agent
   * re-presents identical, unchanged completion evidence. In-memory only.
   */
  recentEvidenceHashes?: string[];
  /**
   * claude2_todo #1c: number of consecutive completion attempts whose evidence
   * hash was unchanged from the previous attempt (>=1 once any attempt has
   * been made). Resets to 1 the moment the evidence actually changes — so
   * "unchanged weak evidence can't reset counters", but genuine new evidence
   * does. In-memory only.
   */
  repeatedEvidenceCount?: number;
  /**
   * review-driven mode: count of consecutive clean fresh-eyes passes (model
   * emitted the no-outstanding phrase AND changed no production code this
   * iteration). Resets to 0 on any iteration that changes production code or
   * does not emit the phrase. The loop converges when this reaches
   * `completion.requiredCleanReviewPasses`. In-memory only; undefined/0 in
   * gated mode.
   */
  consecutiveCleanReviewPasses?: number;
  /**
   * review-driven mode: count of consecutive iterations that hit CRITICAL
   * no-progress while making NO production change AND not advancing the
   * clean-review streak (i.e. the agent is re-reviewing settled work without
   * converging or editing). Resets to 0 on any non-stalled iteration. When it
   * reaches `completion.maxStalledReviewIterations` the loop self-terminates as
   * `completed-needs-review` instead of spinning to a cap / circuit breaker.
   * In-memory only; undefined/0 in gated mode.
   */
  reviewDrivenStallIterations?: number;
}

export type { LoopActivityEvent, LoopActivityKind, LoopRunSummary, LoopStreamEvent } from './loop-stream.types';
