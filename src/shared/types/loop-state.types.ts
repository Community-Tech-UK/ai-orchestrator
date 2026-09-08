import type { LoopOutstanding } from './loop-outstanding.types';
import type { LoopInferredPhase, LoopNonConvergenceReason, LoopParkedLeaf } from './loop-health.types';
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

import type {
  LoopReviewAngleCacheEntry,
  LoopReviewArtifactEntry,
  LoopReviewCoverageReport,
} from './loop-review-state.types';

export type {
  LoopReviewAngleCacheEntry,
  LoopReviewAngleCoverageEntry,
  LoopReviewArtifactEntry,
  LoopReviewCoverageReport,
  LoopReviewCoverageStatus,
} from './loop-review-state.types';
export interface LoopFileChange {
  path: string;
  additions: number;
  deletions: number;
  /** Hash of the resulting line set after this iteration; used to compute churn (lines reverting to a prior state across iterations). */
  contentHash: string;
}

export interface LoopToolCallRecord {
  toolName: string;
  argsHash: string;
  /** `false` when the adapter exposed no argument material (Cursor ACP `rawInput: {}`): `argsHash` is then per-call and Signal I abstains. Absent means captured. */
  argsCaptured?: boolean;
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

export type LoopVerifyFailureKind = 'command' | 'timeout' | 'infra' | 'environment';

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
  | 'cap-wrap-up'
  | 'auto-unstick'
  /** L1: same-session "you are not done" nudge on a quiet turn. */
  | 'idle-nudge';

/** Last automatic change-of-approach nudge, if the coordinator injected one. */
export interface LoopAutoUnstickState {
  seq: number;
  attempt: number;
  max: number;
  signalId: string;
}

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
  /**
   * L8 lease. Set when the payload is handed to iteration `leaseSeq`; cleared
   * by the ack after delivery, or re-queued when the lease goes stale. See
   * `loop-intervention-lease.ts`.
   */
  leaseSeq?: number;
  /** L8 lease timestamp (epoch ms). */
  leasedAt?: number;
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
  /** WS7: provider this iteration failed over FROM (set on the first iteration after a switch). */
  failedOverFrom?: string;
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
   * parse the human-readable `detail` string. WS2: counts open LEAF items only —
   * a parent row with children is a structural summary, not blocking work.
   */
  openCount?: number;
  /**
   * WS2: stable ids of the unresolved LEAF tasks behind `openCount`, so
   * convergence tracking can tell "the same 4 items are still open" apart from
   * "4 different items are open" without re-parsing the ledger text. Present
   * only on the `ledger-complete` signal (empty array when fully resolved);
   * capped to the first 32 ids to bound evidence size.
   */
  openLeafIds?: string[];
}

/** Ledger task state as persisted in convergence tracking (mirrors the
 * `LoopTaskState` union in the main-process ledger parser). */
export type LoopLedgerTaskState = 'todo' | 'doing' | 'done' | 'deferred';

/**
 * WS2/WS3 (loop-convergence plan): persisted, versioned inventory of known
 * ledger leaf tasks. Replaces the historical-minimum stall counters: the first
 * non-empty ledger snapshot freezes `plannedLeafIds`; later ids are recorded in
 * `discoveredLeafIds` (still required for completion, but their arrival cannot
 * erase the history of previously resolved work). Optional on LoopState —
 * old checkpoints that carry only `ledgerOpenCountBest` /
 * `ledgerNoImprovementIterations` remain readable; migration happens when the
 * first new snapshot is observed.
 */
export interface LedgerConvergenceState {
  version: 1;
  /** Last observed state per known leaf task id. */
  knownTaskStates: Record<string, LoopLedgerTaskState>;
  /** Leaf ids present in the first non-empty ledger snapshot (frozen). */
  plannedLeafIds: string[];
  /** Leaf ids that appeared after the planned set was frozen. */
  discoveredLeafIds: string[];
  /** Consecutive iterations without a meaningful task transition. */
  noMeaningfulTransitionIterations: number;
  /** Dedup key of the last objective evidence (verify pass / test-count high). */
  lastObjectiveEvidenceKey?: string;
  /**
   * True while the last snapshot had duplicate/malformed explicit ids. Lets a
   * later repair ("previously malformed/duplicate inventory becomes valid")
   * count as a meaningful transition. Absent = valid.
   */
  inventoryInvalid?: boolean;
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

export interface LoopCapWrapUpIntent {
  cap: 'iterations' | 'wall-time' | 'tokens' | 'cost';
  originalReason: string;
  triggerIteration: number;
  measurement?: number;
  limit?: number;
  phase: 'pending-turn' | 'turn-complete';
}

export type LoopWorktreeLifecyclePhase =
  | 'acquired'
  | 'harvesting'
  | 'harvested'
  | 'integrating'
  | 'integrated'
  | 'promoting'
  | 'promoted'
  | 'blocked'
  | 'preserved'
  | 'cleaned';

export interface LoopWorktreeLifecycle {
  /** Present only when AIO created and durably reserved this worktree. */
  managedByAio?: true;
  phase: LoopWorktreeLifecyclePhase;
  baseBranch: string;
  sessionBranch: string;
  /** Exact AIO-owned session ref tip used to reject branch-name reuse. */
  sessionTip?: string;
  integrationBranch?: string;
  /** Exact AIO-owned integration ref tip approved for promotion. */
  integrationTip?: string;
  lastError?: string;
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
  endReason?: string;
  endEvidence?: Record<string, unknown>;
  /** Durable AIO-owned worktree finalization state. */
  worktreeLifecycle?: LoopWorktreeLifecycle;
  /** Persisted cap terminal intent. A restored run terminalizes under this cap. */
  capWrapUpIntent?: LoopCapWrapUpIntent;
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
  /**
   * L6: ledger leaves deferred because they demonstrably could not converge.
   * The work is NEVER dropped — a parked leaf keeps its id, its reason and the
   * iteration it was parked at, and stays visible on OUTSTANDING.md.
   */
  parkedLeaves?: LoopParkedLeaf[];
  /**
   * L6: consecutive CRITICAL stalls on the current ledger leaf. Its own
   * counter on purpose — see `trackLeafStall`.
   */
  leafStall?: { leafId: string; criticalIterations: number };
  /** L6: the named reason this run stopped converging, when one was found. */
  nonConvergence?: { reason: LoopNonConvergenceReason; message: string; seq: number };
  /** L7: completion attempts rejected for stale build output (bounded retry). */
  staleArtifactRejections?: number;
  /** L1: same-session idle nudges queued this run (bounded by MAX_IDLE_NUDGES). */
  idleNudgeCount?: number;
  /** L1: iteration the last idle nudge was queued for — one per iteration. */
  idleNudgeSeq?: number;
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
   * WS7 Phase A: provider switches performed this run (bounded by
   * `config.failover.maxSwitches`). Persisted so a restored run cannot reset
   * its switch budget.
   */
  failoverSwitches?: number;
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
   * WS2/WS3: transition-based convergence tracker (known leaf-task inventory).
   * Optional — absent on checkpoints written before the field existed; those
   * keep using the two legacy count fields above until the first new snapshot
   * initializes this tracker.
   */
  ledgerConvergence?: LedgerConvergenceState;
  /**
   * B5: set at the end of an iteration whose context was reset/compacted (LF-1
   * utilization recycle, PLAN→IMPLEMENT reset, or degraded-retry fresh session).
   * Consumed at the start of the next iteration to run the post-compaction health
   * canary, then cleared. Carries the compacting seq + reason for diagnostics.
   */
  justCompacted?: { seq: number; reason: string };
  /**
   * T2: capabilities of the child thread that last completed successfully.
   * Cleared on recycle / failover / missing snapshot so the next prompt
   * re-anchors. Coordinator never reads the adapter map for this.
   */
  lastThreadCaps?: {
    supportsResume: boolean;
    sameThreadContinuation: boolean;
    model: string | null;
  };
  freshEyesForcedByContradiction?: boolean;
  /**
   * D6 (#7) part 3: the last fresh-eyes review ran CLEAN, so a later completion
   * attempt with no git-reported change reuses that verdict (instant ALLOW)
   * instead of paying for another cross-model review. Un-gated from
   * `completion.antiSelfGrading` by Decision 15(b), 2026-09-07.
   *
   * The flag is NOT sufficient authority on its own — reuse also requires
   * {@link freshEyesCleanWorkspaceDigest} to still match the tree, because the
   * observed per-attempt delta under-reports writes that land between attempts
   * (concurrent editor, paused or provider-limit-parked loop) and reports an
   * empty delta when git observation fails outright.
   */
  freshEyesCleanForWorkState?: boolean;
  /**
   * Anchor for the cached clean verdict: the commit, the porcelain status, and
   * the full content of every changed or untracked file at the moment it was
   * issued. Reuse requires an exact match.
   *
   * Read from git directly rather than from the reviewer's payload, which is
   * truncated to fit a prompt — anchoring to that let an edit past the cap go
   * unnoticed. It covers what git reports for this repository; gitignored and
   * skip-worktree paths and submodule/nested-repo contents are outside it (see
   * `loop-review-reuse-anchor.ts` for the enumerated list). Undefined when
   * there is no readable HEAD or status, which makes the verdict non-reusable
   * rather than assumed-good.
   */
  freshEyesCleanWorkspaceDigest?: string;
  /**
   * L4: advisory intra-iteration phase inferred from the child's command
   * stream (`loop-phase-inference.ts`). HUD-only — no terminal decision reads
   * it, and it is deliberately absent until the first classifiable tool call.
   */
  inferredPhase?: LoopInferredPhase;
  /** When {@link inferredPhase} was last set (epoch ms). */
  inferredPhaseAt?: number;
  pingPong?: LoopPingPongState;
  /**
   * WS-A3: durably persisted reviewed-artifact snapshots, keyed by
   * `${reviewAttemptId}:${artifactType}`. See {@link LoopReviewArtifactEntry}.
   */
  reviewArtifacts?: Record<string, LoopReviewArtifactEntry>;
  /**
   * WS-B9: per-attempt reviewer/angle coverage, keyed by `reviewAttemptId`.
   * See {@link LoopReviewCoverageReport}.
   */
  reviewCoverageReports?: Record<string, LoopReviewCoverageReport>;
  /**
   * WS-B9: per-angle cache of successful reviewer verdicts, keyed by the
   * composite cache key from `buildAngleCacheKey` (`review-coverage.ts`). See
   * {@link LoopReviewAngleCacheEntry}.
   */
  reviewAngleCache?: Record<string, LoopReviewAngleCacheEntry>;
  /**
   * Last automatic change-of-approach nudge. Set when the coordinator injects
   * an `auto-unstick` intervention after a fixable CRITICAL; cleared on OK or
   * a passing verify. The HUD uses this so it does not ask for a hint while
   * the next iteration is already being steered.
   */
  autoUnstick?: LoopAutoUnstickState;
}
