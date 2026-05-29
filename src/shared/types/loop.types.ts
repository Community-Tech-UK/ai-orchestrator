/**
 * Loop Mode Types
 * Robust per-chat-session "Ralph loop" with fresh-context iterations,
 * aggressive no-progress detection, and verify-before-stop completion.
 *
 * See: plan_loop_mode.md
 */

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
  /** Max iterations before forced stop. Default 50. */
  maxIterations: number;
  /** Wall-time budget in milliseconds. Default 8h. */
  maxWallTimeMs: number;
  /** Token spend cap (approx — measured per iteration). Default 1_000_000. */
  maxTokens: number;
  /** Cost cap in cents. Null means unbounded. Default null for subscription usage. */
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

export interface LoopCompletionConfig {
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
  /** Completion detector config. */
  completion: LoopCompletionConfig;
  /** Allow destructive ops inside the loop (rm -rf, force-push). Default false. */
  allowDestructiveOps: boolean;
  /** Optional: agent's initial stage. Default 'IMPLEMENT'. */
  initialStage: LoopStage;
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
      maxIterations: 50,
      maxWallTimeMs: 8 * 60 * 60 * 1000,
      maxTokens: 1_000_000,
      maxCostCents: null,
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
    completion: {
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
    iterationTimeoutMs: undefined,
    streamIdleTimeoutMs: undefined,
  };
}

// ============ Stage / Status ============

export type LoopStage = 'PLAN' | 'REVIEW' | 'IMPLEMENT';

export type LoopStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'error'
  | 'no-progress'
  | 'verify-failed'
  | 'cap-reached';

export type LoopVerdict = 'OK' | 'WARN' | 'CRITICAL';

// ============ Iteration record ============

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

// ============ Progress (no-progress) detection ============

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

// ============ Completion detection ============

export type CompletionSignalId =
  | 'completed-rename'   // *_Completed.md rename
  | 'done-promise'       // <promise>DONE</promise>
  | 'done-sentinel'      // DONE.txt exists
  | 'all-green'          // verify command passes (transition from prev failing)
  | 'self-declared'      // "TASK COMPLETE" in output (auxiliary only)
  | 'plan-checklist'     // PLAN.md checkboxes 100%
  | 'declared-complete'; // explicit loop-control complete intent

export interface CompletionSignalEvidence {
  id: CompletionSignalId;
  /**
   * Whether this signal alone can stop the loop. self-declared is always false;
   * all others are true (subject to verify-before-stop).
   */
  sufficient: boolean;
  detail: string;
}

// ============ Explicit terminal control ============

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

// ============ Loop state (live) ============

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
}

// ============ Stream events (async generator) ============

export type LoopStreamEvent =
  | { type: 'started'; loopRunId: string; chatId: string }
  | { type: 'iteration-started'; loopRunId: string; seq: number; stage: LoopStage }
  | { type: 'activity'; event: LoopActivityEvent }
  | { type: 'iteration-complete'; loopRunId: string; seq: number; verdict: LoopVerdict }
  | { type: 'paused-no-progress'; loopRunId: string; signal: ProgressSignalEvidence }
  | { type: 'claimed-done-but-failed'; loopRunId: string; signal: CompletionSignalId; failure: string }
  | { type: 'terminal-intent-recorded'; loopRunId: string; intent: LoopTerminalIntent }
  | { type: 'terminal-intent-rejected'; loopRunId: string; intent: LoopTerminalIntent; reason: string }
  | { type: 'intervention-applied'; loopRunId: string; message: string }
  | { type: 'completed'; loopRunId: string; signal: CompletionSignalId; verifyOutput: string }
  | { type: 'failed'; loopRunId: string; reason: string }
  | { type: 'cap-reached'; loopRunId: string; cap: 'iterations' | 'wall-time' | 'tokens' | 'cost' | 'completion-attempts'; reason?: string }
  | { type: 'cancelled'; loopRunId: string }
  | { type: 'error'; loopRunId: string; error: string };

export type LoopActivityKind =
  | 'spawned'
  | 'status'
  | 'tool_use'
  | 'assistant'
  | 'system'
  | 'input_required'
  | 'error'
  | 'stream-idle'
  | 'complete'
  | 'heartbeat';

export interface LoopActivityEvent {
  loopRunId: string;
  seq: number;
  stage: LoopStage | string;
  kind: LoopActivityKind;
  message: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

// ============ Helpers ============

export interface LoopRunSummary {
  id: string;
  chatId: string;
  status: LoopStatus;
  totalIterations: number;
  totalTokens: number;
  totalCostCents: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  /** The goal/ask the loop was started with (iteration 0 prompt). Pulled
   *  from the persisted config so the renderer can let users copy/inspect/
   *  reattempt past prompts even after an app reload. */
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. Null when the
   *  loop re-used `initialPrompt` for every iteration. */
  iterationPrompt: string | null;
}
