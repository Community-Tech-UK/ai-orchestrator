import type { LoopOutstanding } from './loop-outstanding.types';
import type { LoopPingPongState } from './loop-pingpong.types';
import type {
  LoopConfig,
  LoopFinalAuditResult,
  LoopPhaseRecoveryState,
  LoopPreflightResult,
  LoopRepoBaselineSnapshot,
  LoopSemanticProgressResult,
  LoopStage,
  LoopStatus,
} from './loop.types';

/**
 * LF-7: outcome of the most recent completion attempt. Drives the UI
 * completion-gate stepper (LF-8) and the runbook's "why didn't it stop"
 * diagnosis. Undefined until the first completion attempt.
 */
export type LoopCompletionOutcome =
  | 'accepted'
  | 'verify-failed'
  | 'unverifiable'
  | 'rename-gate'
  | 'review-blocked';

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
  /** Hash of the tool_result content when the adapter exposes it. */
  resultHash?: string;
  success: boolean;
  durationMs: number;
  /**
   * E2 (#12) capture half: the timeout the agent itself declared for this
   * call (e.g. Claude's Bash `timeout` arg, ms), when present and sane.
   * Lets the stall watchdog widen its kill threshold for a legit long build.
   */
  declaredTimeoutMs?: number;
}

export type LoopVerifyFailureKind = 'command' | 'timeout' | 'infra';

/**
 * Drain timing for a queued loop message (Pi Task 18 taxonomy):
 * - `queue`  ≙ next-iteration: embedded into the next prompt and drained then.
 * - `steer`  ≙ steering: intended as mid-iteration input; no current loop
 *              adapter accepts live input, so `intervene()` downgrades it to
 *              next-iteration and surfaces the downgrade (loop:steering-downgraded).
 * - `follow-up`: held back from prompt-build and only drained at the completion
 *              seam — "run this before you finish."
 */
export type LoopPendingInputKind = 'steer' | 'queue' | 'follow-up';
/**
 * Pi Task 18 drain policy for a queued message. `all` (default) drains the whole
 * queued batch together; `one-at-a-time` drains a single message per drain cycle
 * so the agent addresses queued items sequentially. Only meaningful for
 * `follow-up` messages today (they drain at the completion seam, one per
 * completion attempt when `one-at-a-time`).
 */
export type LoopQueueDrainMode = 'all' | 'one-at-a-time';
export type LoopPendingInputSource =
  | 'human'
  | 'block-override'
  | 'plan-regen'
  | 'phase-recovery'
  | 'context-survival'
  | 'announce-then-halt'
  | 'subagent-result'
  | 'wakeup'
  | 'cap-wrap-up';

export interface LoopPendingInput {
  id: string;
  kind: LoopPendingInputKind;
  message: string;
  enqueuedAt: number;
  source: LoopPendingInputSource;
  /**
   * Task 18 drain policy. Optional; absent is treated as `all`. Honored by the
   * follow-up drain: a `one-at-a-time` follow-up drains a single message per
   * completion seam instead of the whole batch.
   */
  drainMode?: LoopQueueDrainMode;
}

export function createLoopPendingInput(
  message: string,
  opts: {
    id?: string;
    kind?: LoopPendingInputKind;
    enqueuedAt?: number;
    source?: LoopPendingInputSource;
    drainMode?: LoopQueueDrainMode;
  } = {},
): LoopPendingInput {
  const enqueuedAt = opts.enqueuedAt ?? Date.now();
  return {
    id: opts.id ?? `pending-${enqueuedAt}-${Math.random().toString(36).slice(2, 10)}`,
    kind: opts.kind ?? 'queue',
    message,
    enqueuedAt,
    source: opts.source ?? 'human',
    ...(opts.drainMode ? { drainMode: opts.drainMode } : {}),
  };
}

export function coercePendingInput(input: string | LoopPendingInput): LoopPendingInput {
  return typeof input === 'string'
    ? createLoopPendingInput(input, { id: `legacy-${Math.abs(hashPendingMessage(input))}`, enqueuedAt: 0 })
    : input;
}

function hashPendingMessage(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(31, hash) + input.charCodeAt(i);
  }
  return hash;
}

export interface LoopErrorRecord {
  bucket: string;
  exactHash: string;
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
  /**
   * Cache-read input tokens. Billed at ~10% of the input rate, so folding these
   * into a flat per-token estimate massively overstates cost — see the pricing
   * note on {@link LoopIteration.costKnown}.
   */
  cacheReadTokens?: number;
  /** Cache-creation ("write") input tokens. Billed at the full input rate. */
  cacheWriteTokens?: number;
  /** Resolved model for this iteration, so cost can be re-derived per-model. */
  model?: string;
  /**
   * True when the provider reported an authoritative dollar cost
   * (e.g. Claude's `total_cost_usd`). False means `costCents` was derived from
   * token counts via `computeTokenCost` and is an estimate.
   */
  costKnown?: boolean;
  filesChanged: LoopFileChange[];
  /** Workspace-relative paths read by this iteration when the invoker can observe them. */
  filesRead?: string[];
  toolCalls: LoopToolCallRecord[];
  errors: LoopErrorRecord[];
  testPassCount: number | null;
  testFailCount: number | null;
  /** Adapter/provider stop reason, e.g. `end_turn`, `tool_use`, or `max_tokens`. */
  finishReason?: string;
  /** True when a tool_use was observed without a matching tool_result before the turn sealed. */
  unresolvedToolCalls?: boolean;
  /** Hash of (sortedFileDiffPaths ‖ stage ‖ toolCallSignature). */
  workHash: string;
  /** Cosine/Jaccard similarity to previous iteration's output text (0..1). */
  outputSimilarityToPrev: number | null;
  /**
   * First & last 2KB of stdout, used for similarity / no-progress /
   * completion detection. Deliberately small — see `excerpt()`.
   */
  outputExcerpt: string;
  /**
   * The agent's complete closing message (verbatim, bounded only by a
   * generous safety cap — see `boundFullOutput()`). Used purely for human
   * display (summary card, trace, chat recap); never fed to detection.
   * Empty string on pre-migration rows or iterations with no output.
   */
  outputFull: string;
  progressVerdict: LoopVerdict;
  progressSignals: ProgressSignalEvidence[];
  completionSignalsFired: CompletionSignalEvidence[];
  verifyStatus: 'not-run' | 'passed' | 'failed';
  verifyOutputExcerpt: string;
  /**
   * Why a failed verify failed. `command` means the command ran and returned a
   * non-zero exit; `timeout`/`infra` mean the verifier itself could not produce
   * reliable test evidence.
   */
  verifyFailureKind?: LoopVerifyFailureKind;
  /**
   * Optional local-model TL;DR of a FAILED verify command's output, produced
   * best-effort and asynchronously after the excerpt is stored. Purely operator
   * UX — never influences the completion decision. Absent when auxiliary models
   * are off/unavailable or the verify passed. In-memory + broadcast only (not
   * persisted across restarts).
   */
  verifySummary?: string;
  /** Supergoal-inspired final audit result captured at the completion seam. */
  finalAudit?: LoopFinalAuditResult;
  /** LF-2 semantic-progress verdict for this iteration (present when the check ran). */
  semanticProgress?: LoopSemanticProgressResult;
  /**
   * True when this iteration's assistant stream already landed in the chat /
   * instance transcript (the borrowed live-adapter path). The iteration→ledger
   * write skips these to avoid double-recording the same turn. Absent/false
   * means the iteration ran in a forked loop session and must be written into
   * the canonical thread explicitly (close-the-loop-write-gap).
   */
  transcriptBound?: boolean;
}

/**
 * Identifiers from `plan_loop_mode.md` § A. Aggressive no-progress detection.
 */
export type ProgressSignalId = 'A' | 'B' | 'C' | 'D' | 'D-prime' | 'E' | 'F' | 'G' | 'H' | 'I' | 'BLOCKED';

export interface ProgressSignalEvidence {
  id: ProgressSignalId;
  verdict: LoopVerdict;
  message: string;
  /** Optional structured payload for UI rendering. */
  detail?: Record<string, unknown>;
}

export type CompletionSignalId =
  | 'completed-rename'
  | 'done-promise'
  | 'done-sentinel'
  | 'all-green'
  | 'self-declared'
  | 'plan-checklist'
  | 'declared-complete'
  | 'ledger-complete';

export interface CompletionSignalEvidence {
  id: CompletionSignalId;
  /**
   * Whether this signal alone can stop the loop. self-declared is always false;
   * all others are true (subject to verify-before-stop).
   */
  sufficient: boolean;
  detail: string;
  /**
   * Structured open-item count for the `ledger-complete` signal (0 when the
   * ledger is fully resolved, >0 while items remain). Undefined for every other
   * signal id. Consumed by the ledger-progress stall tracker so it never has to
   * parse the human-readable `detail` string.
   */
  openCount?: number;
}

export type LoopTerminalIntentKind = 'complete' | 'block' | 'fail' | 'wakeup';
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
  receivedAt: number;
  status: LoopTerminalIntentStatus;
  statusReason?: string;
  filePath?: string;
  resumeAt?: number;
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

export interface LoopInFlightIteration {
  seq: number;
  stage: LoopStage;
  startedAt: number;
  idempotencyKey: string;
}

export interface LoopContextWindowCalibration {
  provider: LoopConfig['provider'];
  model?: string;
  windowTokens: number;
  calibratedAt: number;
  source: 'provider-error';
  reason: string;
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
  endReason?: string;
  endEvidence?: Record<string, unknown>;
  outstanding?: LoopOutstanding;
  repoBaseline?: LoopRepoBaselineSnapshot;
  preflight?: LoopPreflightResult;
  latestFinalAudit?: LoopFinalAuditResult;
  phaseRecovery?: Record<string, LoopPhaseRecoveryState>;
  pendingInterventions: LoopPendingInput[];
  loopControl?: LoopControlMetadata;
  inFlightIteration?: LoopInFlightIteration;
  terminalIntentPending?: LoopTerminalIntent;
  terminalIntentHistory?: LoopTerminalIntent[];
  completedFileRenameObserved: boolean;
  doneSentinelPresentAtStart: boolean;
  planChecklistFullyCheckedAtStart: boolean;
  uncompletedPlanFilesAtStart: string[];
  manualReviewOnly: boolean;
  tokensSinceLastTestImprovement: number;
  highestTestPassCount: number;
  iterationsOnCurrentStage: number;
  recentWarnIterationSeqs: number[];
  completionAttempts: number;
  announceThenHaltNudgeCount?: number;
  lastCompletionOutcome?: LoopCompletionOutcome;
  /**
   * D6 (#7) edit-invalidates-proof: the iteration work-hash recorded when the
   * verify command last PASSED at the completion gate. Verify evidence only
   * satisfies the gate while the workspace still matches this fingerprint —
   * any later edit makes the recorded proof stale until verify is re-run.
   * Undefined until the first passing verify (or while `antiSelfGrading` is
   * off / the recording seam is not wired).
   */
  lastVerifiedWorkHash?: string;
  /**
   * B6: provider/model context window learned from a context-overflow response.
   * Runtime state, not immutable config; reused by LF-1 context discipline so
   * the next same-session recycle decision uses the server-reported window.
   */
  contextWindowCalibration?: LoopContextWindowCalibration;
  loopTasksLedgerResolvedAtStart: boolean;
  unresolvedReviewThreads?: string[];
  recentEvidenceHashes?: string[];
  repeatedEvidenceCount?: number;
  consecutiveCleanReviewPasses?: number;
  reviewDrivenStallIterations?: number;
  /**
   * F2 (#22): count of coordinator-enforced REVIEW→PLAN back-edges this run.
   * Incremented every time the post-REVIEW 3-field veto fires (whether or not
   * the coordinator had to overwrite STAGE.md itself); bounded by
   * `completion.maxReviewCycles` so review thrash converges. Dedicated counter,
   * deliberately separate from the global caps.
   */
  reviewCycles?: number;
  /**
   * A3 (#29): true when the loop is paused *because it is blocked on input*
   * (BLOCKED.md handshake or a terminal `block` intent) rather than stalled.
   * A sticky waiting state: idle/stall watchdogs must not count it toward a
   * kill. Cleared when the operator resumes the loop.
   */
  pausedForInput?: boolean;
  /**
   * Lowest `LOOP_TASKS.md` open-item count observed so far this run (undefined
   * until the first ledger reading). "Net ledger progress" = reaching a new low.
   * Paired with `ledgerNoImprovementIterations` to detect a loop that edits
   * files every iteration but never closes ledger items (see loop-ledger-progress).
   */
  ledgerOpenCountBest?: number;
  /** Consecutive iterations since the ledger open-count last reached a new low. */
  ledgerNoImprovementIterations?: number;
  /**
   * B5: set at the end of an iteration whose context was reset/compacted (LF-1
   * utilization recycle, PLAN→IMPLEMENT reset, or degraded-retry fresh session).
   * Consumed at the start of the next iteration to run the post-compaction health
   * canary, then cleared. Carries the compacting seq + reason for diagnostics.
   */
  justCompacted?: { seq: number; reason: string };
  freshEyesForcedByContradiction?: boolean;
  /**
   * D6 (#7) part 3: true while the last fresh-eyes gate review ran CLEAN and
   * no production file has changed since. Lets a completion attempt from a
   * status/summary-only iteration reuse the verdict (instant ALLOW, gated on
   * `completion.antiSelfGrading`) instead of re-running a multi-minute
   * cross-model review. Set only by a real clean review; cleared by the
   * coordinator on any later production-file change and by a blocked review.
   */
  freshEyesCleanForWorkState?: boolean;
  pingPong?: LoopPingPongState;
}
