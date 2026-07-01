// ============ Configuration ============

import type { LoopHardCaps } from './loop-config.types';
export type { LoopHardCaps } from './loop-config.types';
export type {
  LoopOutstanding,
  LoopOutstandingItem,
  LoopOutstandingItemKind,
  LoopOutstandingItemStatus,
} from './loop-outstanding.types';
import type {
  LoopPingPongConfig,
} from './loop-pingpong.types';
import type {
  LoopAuditConfig,
} from './loop-audit.types';
import { defaultLoopAuditConfig } from './loop-audit.types';
export type {
  LoopAuditConfig,
  LoopAuditFinding,
  LoopAuditStatus,
  LoopFinalAuditMode,
  LoopFinalAuditResult,
  LoopPhaseRecoveryState,
  LoopPhaseSpec,
  LoopPlanPacketMode,
  LoopPlanPacketSummary,
  LoopPreflightMode,
  LoopPreflightResult,
  LoopRepoBaselineSnapshot,
} from './loop-audit.types';
export { defaultLoopAuditConfig } from './loop-audit.types';
export type {
  LoopPingPongConfig,
  LoopPingPongState,
  PingPongIssue,
  PingPongIssueStatus,
  PingPongReviewerFault,
  PingPongReviewerVerdict,
  PingPongSeverity,
  PingPongSubject,
} from './loop-pingpong.types';
export {
  clampPingPongMaxRounds,
  defaultPingPongConfig,
  defaultPingPongState,
  isReviewerAvailabilityFault,
  PINGPONG_DEFAULT_MAX_ROUNDS,
  PINGPONG_MAX_MAX_ROUNDS,
  PINGPONG_MIN_MAX_ROUNDS,
} from './loop-pingpong.types';

export const DEFAULT_LOOP_MAX_WALL_TIME_MS = 50 * 60 * 60 * 1000;
export const DEFAULT_LOOP_MAX_ITERATIONS = 50;
/**
 * Total token budget across the whole loop. `null` = unbounded so the cost,
 * iteration, and wall-time caps govern instead. Previously 1,000,000, which
 * silently tripped `cap=tokens` after a single iteration on 1M-context models
 * (one deep read+implement turn can exceed 1M cumulative tokens while costing
 * only a few dollars). The cap is still configurable per-run via `caps.maxTokens`.
 */
export const DEFAULT_LOOP_MAX_TOKENS: number | null = null;
export const DEFAULT_LOOP_MAX_COST_CENTS: number | null = null;

/** What "fresh eyes" looks like at REVIEW stage. */
export type LoopReviewStyle =
  | 'single'         // single agent at REVIEW
  | 'debate'         // 3-agent in-process debate (Claude only)
  | 'star-chamber';  // Claude + Codex (Gemini deliberately excluded)

/** Where the iteration's LLM context comes from. */
export type LoopContextStrategy = 'fresh-child' | 'hybrid' | 'same-session';

/** Concrete provider for child iterations. `auto` is resolved before persistence. */
export type LoopProvider = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor';

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
  /** Consecutive identical tool calls within one iteration. */
  identicalToolCallConsecutiveCritical: number; // default 3
  /** Successful read-only tool calls returning the same result hash. */
  idempotentReadRepeatWarn: number;          // default 3
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
 *   work, fixes anything not done or done wrong, and only reports a clean
 *   review when — after a genuine fresh pass — it found nothing to fix and
 *   changed no production code. The loop stops after `requiredCleanReviewPasses`
 *   consecutive semantically clean passes. There is no verify-gate /
 *   rename-gate / evidence-ladder; the review IS the stop condition. Mirrors
 *   the proven manual workflow ("re-review with fresh eyes, fix anything not
 *   done") without a human typing it each round.
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
   * review-driven only: number of consecutive clean fresh-eyes passes required
   * before the loop stops. A clean pass is semantically classified as "no
   * actionable issues remain" and has no production-code changes. Default 2 —
   * one clean pass can be lazy, two in a row is a strong signal. Ignored in
   * `'gated'` mode.
   */
  requiredCleanReviewPasses?: number;
  /**
   * review-driven only: preferred wording for the model to signal "nothing
   * left to do." The runtime also accepts equivalent no-actionable-issues
   * sentiment; this phrase remains a high-confidence shortcut and prompt hint.
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
  /**
   * review-driven only: max consecutive iterations the `LOOP_TASKS.md`
   * open-item count may fail to reach a new low before the loop stops itself as
   * `completed-needs-review`. Unlike `maxStalledReviewIterations` (which resets
   * on ANY production file change), this keys off ledger *open-count* not
   * decreasing — so it catches a loop that edits files every round yet never
   * closes an item (e.g. an open-ended "continue remaining slices" bucket that
   * re-expands as fast as it drains). Default 8. Ignored in `'gated'` mode.
   */
  maxLedgerStallIterations?: number;
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
  /**
   * Conversational ping-pong review mode. When `{ enabled: true }`, the loop's
   * completion gate runs a full *agentic* reviewer (a fresh, different-provider
   * CLI instance with real repo + tool access) on EVERY builder
   * done-declaration, and only converges on a mutual APPROVED + done. Drives a
   * dedicated completion branch (`evaluatePingPongCompletion`); the thin
   * one-shot diff reviewer is NOT used in this mode. Undefined / disabled means
   * the legacy fresh-eyes gate behaviour.
   */
  pingPong?: LoopPingPongConfig;
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
 * Default per-iteration agentic-turn backstop passed to the child CLI as
 * `--max-turns`. Bounds the pathological runaway case (a single iteration
 * observed at 7.24M tokens / ~50+ turns) without touching healthy iterations,
 * which run a handful of turns. Deliberately generous: a too-low bound
 * truncates legitimate work, and a truncated iteration re-runs on a fresh
 * session via degraded-iteration retry — costing MORE than it saves.
 */
export const LOOP_DEFAULT_MAX_TURNS_PER_ITERATION = 100;

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

/**
 * G3 — serializable config for model-generated next objectives.
 *
 * The actual planner is a runtime function (`nextObjectivePlanner`) and cannot
 * cross IPC or persist to SQLite. This plain-data switch is what renderer/IPC
 * callers set; main-process start-config preparation attaches the runtime
 * planner when `enabled` is true.
 */
export interface LoopNextObjectivePlanningConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Run the planner every N completed iterations. Default 1. */
  cadence: number;
}

export function defaultNextObjectivePlanningConfig(): LoopNextObjectivePlanningConfig {
  return { enabled: false, cadence: 1 };
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

/**
 * G3 — Optional next-objective planner (Phase 3, flag-gated, off by default).
 *
 * When set on LoopConfig, after each iteration where the evidence ladder says
 * `continue` (never on stop/pause branches), the planner may propose the next
 * iteration's focus objective. Its output is injected into pendingInterventions
 * so the next prompt template picks it up — exactly as an operator intervention.
 *
 * Hard invariant: the planner runs ONLY on the `continue` branch. It can never
 * produce a `stop`. Stop authority remains exclusively with evidence-resolver.
 *
 * @param context.lastOutput    Full output of the just-completed iteration.
 * @param context.originalGoal  The loop's original `initialPrompt` (pinned).
 * @param context.seq           Zero-based iteration sequence just completed.
 * @returns  Next-objective text to inject, or null/undefined to skip injection.
 */
export type NextObjectivePlanner = (context: {
  lastOutput: string;
  originalGoal: string;
  seq: number;
}) => Promise<string | null | undefined>;

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
  /** Supergoal-inspired planning, preflight, and final-audit controls. */
  audit: LoopAuditConfig;
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
  /**
   * Agentic-turn backstop per iteration, passed to the child CLI as
   * `--max-turns`. Bounds runaway single iterations (the wall-clock timeout
   * and `caps.maxIterations` bound iterations, not turns within one).
   * Defaults to {@link LOOP_DEFAULT_MAX_TURNS_PER_ITERATION}; `null` disables
   * the bound entirely.
   */
  maxTurnsPerIteration?: number | null;
  /**
   * G3 — Optional next-objective planner (Phase 3, off by default).
   * Plain-data config that can be submitted over IPC and persisted.
   * `prepareLoopStartConfig()` turns this into `nextObjectivePlanner`.
   */
  nextObjectivePlanning?: LoopNextObjectivePlanningConfig;
  /**
   * G3 — Optional next-objective planner (Phase 3, off by default).
   * When set, after each `continue` iteration, the planner proposes the next
   * focus objective. Injected as an intervention — never affects stop authority.
   * Runtime-only: stripped before broadcast/persistence and recreated from
   * `nextObjectivePlanning` when needed.
   * See `NextObjectivePlanner` for the invariant guarantees.
   */
  nextObjectivePlanner?: NextObjectivePlanner;
  /**
   * When true, startLoop acquires a per-session git worktree and sets
   * `executionCwd` automatically. Each loop session runs in its own isolated
   * working directory; `workspaceCwd` stays pinned to the repo root so durable
   * state (`.aio-loop-state`, `.aio-loop-control`, loop memory) is never reaped.
   * Default: false (backward-compatible).
   */
  isolateLoopWorkspaces?: boolean;
  /**
   * The directory the CLI child is spawned in. When `isolateLoopWorkspaces` is
   * true this is set to the per-session worktree path by the coordinator;
   * callers may also set it directly. Defaults to `workspaceCwd` when absent.
   * Serialized to the DB so recovery can rebuild the full config.
   */
  executionCwd?: string;
  /**
   * Branch name of the per-session worktree. Set by the coordinator alongside
   * `executionCwd` when `isolateLoopWorkspaces` is true. Persisted to the DB
   * via `config_json` and the dedicated `branch_name` column so boot-reconcile
   * can identify the branch for audit/recovery purposes.
   */
  worktreeBranch?: string;
  /**
   * When isolation is on, automatically integrate the session branch on
   * terminal-success: the orchestrator merges the harvested session branch into
   * a shared, accumulating integration branch (`integration/<baseBranch>`) via a
   * dedicated integration worktree — never the root checkout. On a clean merge
   * the worktree is reaped as usual; on conflict the session branch and worktree
   * output are preserved for manual resolution. Default: true when
   * `isolateLoopWorkspaces` is true (set false to harvest-to-branch only).
   */
  autoIntegrateWorktree?: boolean;
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
    maxTurnsPerIteration: LOOP_DEFAULT_MAX_TURNS_PER_ITERATION,
    caps: {
      maxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
      maxWallTimeMs: DEFAULT_LOOP_MAX_WALL_TIME_MS,
      maxTokens: DEFAULT_LOOP_MAX_TOKENS,
      maxCostCents: DEFAULT_LOOP_MAX_COST_CENTS,
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
      identicalToolCallConsecutiveCritical: 3,
      idempotentReadRepeatWarn: 3,
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
    audit: defaultLoopAuditConfig(),
    nextObjectivePlanning: defaultNextObjectivePlanningConfig(),
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
      maxLedgerStallIterations: 8,
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
  | 'cap-reached'
  /**
   * Usage-aware throttling state: the active provider signalled a usage/rate
   * limit (a provider notice in iteration output, or an exhausted quota
   * window) instead of grinding into paid overage as `cap-reached`.
   *
   * `endedAt === null` means the loop is parked/resumable; `endedAt !== null`
   * means no resume window was available and the provider-limit state is
   * terminal. Consumers must use `endedAt` to distinguish the two.
   */
  | 'provider-limit'
  /**
   * Ping-pong: the loop's cost cap was hit mid-ping-pong (fresh full reviewer
   * instances every round are expensive). Distinct from `cap-reached` so the UI
   * can surface the live spend that tripped it.
   */
  | 'cost-exceeded'
  /**
   * Ping-pong: builder and reviewer deadlocked — the reviewer keeps blocking
   * the same point and the builder keeps rebutting it for K consecutive rounds.
   * Surfaces the contested issue(s) for James to arbitrate instead of spinning.
   */
  | 'needs-human-arbitration'
  /**
   * Ping-pong: the reviewer repeatedly produced UNUSABLE output (empty,
   * unparseable, low-effort) — a reviewer-QUALITY fault. Fail-closed; distinct
   * from `reviewer-unavailable` (reviewer couldn't be reached at all).
   */
  | 'reviewer-unreliable'
  /**
   * Ping-pong: no review could be obtained — the reviewer provider was
   * UNAVAILABLE too long (rate-limited / unreachable / none eligible after
   * fallback). An availability problem, NOT a code judgement nor garbage output.
   */
  | 'reviewer-unavailable'
  /**
   * Ping-pong: the builder keeps declaring done without ever addressing or
   * rebutting the open findings. Surfaced rather than looping forever.
   */
  | 'builder-unreliable';
// LF-8: `idle` and `verify-failed` were dead enum values — the coordinator
// never emitted them (terminate() is only called with the states above), so
// they implied lifecycle states the system never reached. Removed.

export type {
  CompletionSignalEvidence,
  CompletionSignalId,
  LoopCompletionOutcome,
  LoopControlMetadata,
  LoopErrorRecord,
  LoopFileChange,
  LoopInFlightIteration,
  LoopIteration,
  LoopPendingInput,
  LoopPendingInputKind,
  LoopPendingInputSource,
  LoopQueueDrainMode,
  LoopState,
  LoopTerminalIntent,
  LoopTerminalIntentEvidence,
  LoopTerminalIntentEvidenceKind,
  LoopTerminalIntentKind,
  LoopTerminalIntentSource,
  LoopTerminalIntentStatus,
  LoopToolCallRecord,
  LoopVerifyFailureKind,
  LoopVerdict,
  ProgressSignalEvidence,
  ProgressSignalId,
} from './loop-state.types';

export {
  coercePendingInput,
  createLoopPendingInput,
} from './loop-state.types';

export type {
  LoopActivityEvent,
  LoopActivityKind,
  LoopRunSummary,
  LoopStreamEvent,
  LoopStreamTerminalStatus,
} from './loop-stream.types';
