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
  success: boolean;
  durationMs: number;
}

export type LoopPendingInputKind = 'steer' | 'queue';
export type LoopPendingInputSource =
  | 'human'
  | 'block-override'
  | 'plan-regen'
  | 'phase-recovery'
  | 'subagent-result'
  | 'wakeup';

export interface LoopPendingInput {
  id: string;
  kind: LoopPendingInputKind;
  message: string;
  enqueuedAt: number;
  source: LoopPendingInputSource;
}

export function createLoopPendingInput(
  message: string,
  opts: {
    id?: string;
    kind?: LoopPendingInputKind;
    enqueuedAt?: number;
    source?: LoopPendingInputSource;
  } = {},
): LoopPendingInput {
  const enqueuedAt = opts.enqueuedAt ?? Date.now();
  return {
    id: opts.id ?? `pending-${enqueuedAt}-${Math.random().toString(36).slice(2, 10)}`,
    kind: opts.kind ?? 'queue',
    message,
    enqueuedAt,
    source: opts.source ?? 'human',
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
  filesChanged: LoopFileChange[];
  toolCalls: LoopToolCallRecord[];
  errors: LoopErrorRecord[];
  testPassCount: number | null;
  testFailCount: number | null;
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
export type ProgressSignalId = 'A' | 'B' | 'C' | 'D' | 'D-prime' | 'E' | 'F' | 'G' | 'H' | 'BLOCKED';

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

export interface LoopInFlightIteration {
  seq: number;
  stage: LoopStage;
  startedAt: number;
  idempotencyKey: string;
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
  lastCompletionOutcome?: LoopCompletionOutcome;
  loopTasksLedgerResolvedAtStart: boolean;
  unresolvedReviewThreads?: string[];
  recentEvidenceHashes?: string[];
  repeatedEvidenceCount?: number;
  consecutiveCleanReviewPasses?: number;
  reviewDrivenStallIterations?: number;
  freshEyesForcedByContradiction?: boolean;
  pingPong?: LoopPingPongState;
}
