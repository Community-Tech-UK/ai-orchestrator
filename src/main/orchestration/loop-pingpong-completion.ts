import { getLogger } from '../logging/logger';
import type {
  LoopIteration,
  LoopStage,
  LoopState,
  LoopStatus,
  PingPongIssue,
  PingPongReviewerFault,
  PingPongSubject,
} from '../../shared/types/loop.types';
import {
  clampPingPongMaxRounds,
  createLoopPendingInput,
  defaultPingPongState,
  isReviewerAvailabilityFault,
} from '../../shared/types/loop.types';
import { collectWorkspaceDiff } from './loop-diff';
import { isReviewDrivenProductionChange } from './loop-coordinator-completion-gates';
import { resolvePingPongSubject } from './pingpong-intent-classifier';
import type { LoopCleanReviewClassifier } from './loop-clean-review-classifier';
import {
  agenticPingPongReviewer,
  type PingPongLedgerClassification,
  type PingPongReviewFinding,
  type PingPongReviewer,
  type PingPongReviewResult,
} from './agentic-pingpong-reviewer';
import {
  runLocalOnlyFreshEyesReview,
  type FreshEyesFinding,
  type LocalFreshEyesAdvisoryResult,
  type LocalFreshEyesAdvisoryReviewer,
} from './loop-fresh-eyes-reviewer';
import { settlePromise, waitForSettlementOrAbort } from './abortable-promise-settlement';

const logger = getLogger('LoopPingPong');

type LoopEmit = (eventName: string, payload: unknown) => void;

/** Default deep-dive timeout for an agentic reviewer round. */
const DEFAULT_REVIEWER_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * Repeated reviewer-QUALITY faults (the reviewer ran but emitted unusable
 * output) → reviewer-unreliable. Strict: a reviewer that keeps producing garbage
 * is genuinely unreliable.
 */
const MAX_UNRELIABLE_ROUNDS = 3;
/**
 * Repeated reviewer-AVAILABILITY faults (rate-limited / unreachable / no
 * eligible provider) → reviewer-unavailable. More lenient than the quality
 * ceiling: these are transient and self-heal once a provider frees up (each
 * round is a builder iteration apart, providing back-off), and the reviewer
 * being throttled says nothing about the code.
 */
const MAX_REVIEWER_UNAVAILABLE_ROUNDS = 6;
/** Repeated genuine disagreement rounds → needs-human-arbitration. */
const MAX_CONTRADICTORY_ROUNDS = 3;
/** Builder declares done but ignores blocking findings N rounds → builder-unreliable. */
const MAX_UNADDRESSED_ROUNDS = 3;
/** Consecutive low-only-churn rounds → converge-or-arbitrate (anti-nitpick). */
const MAX_LOW_ONLY_ROUNDS = 2;

export interface PingPongTerminal {
  status: LoopStatus;
  reason: string;
}

export interface PingPongGateDeps {
  state: LoopState;
  iteration: LoopIteration;
  fullOutput: string;
  seq: number;
  stage: LoopStage;
  classifyCleanReview: LoopCleanReviewClassifier;
  emit: LoopEmit;
  /** Cancellation predicate — true when the loop is paused or cancelled. */
  isCancelled: () => boolean;
  /** Abort signal tied to loop pause/cancel; aborts the in-flight reviewer. */
  signal: AbortSignal;
  /** Folds reviewer spend into the loop's budget accounting. */
  foldReviewerSpend: (tokens: number, costCents: number) => void;
  /** Injectable reviewer (tests). Defaults to the real agentic reviewer. */
  reviewer?: PingPongReviewer;
  /** Additional local-only advisory pass; never replaces the remote reviewer. */
  localAdvisoryReviewer?: LocalFreshEyesAdvisoryReviewer;
  /** Optional subject classifier (P6); falls back to config/heuristic. */
  resolveSubject?: (state: LoopState, fullOutput: string) => Promise<PingPongSubject>;
  /**
   * impl-mode verify hook (bigchange_pingpong_review §4.4 / R4). Run before
   * accepting an APPROVED convergence in impl mode; plan mode skips it (no code
   * to run). Returns `{ ok }` — when false, convergence is rejected and the
   * failure is injected as an intervention. Undefined ⇒ no verify gate.
   */
  runVerify?: () => Promise<{ ok: boolean; output: string }>;
}

/** Short stable id for a finding/issue, derived from its title. */
function issueId(title: string): string {
  let h = 0;
  const s = title.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `pp-${(h >>> 0).toString(36)}`;
}

/** Reconcile the durable ledger with this round's classifications + findings. */
function applyLedgerUpdates(
  ledger: PingPongIssue[],
  classifications: readonly PingPongLedgerClassification[],
  findings: readonly PingPongReviewFinding[],
  round: number,
): void {
  const byId = new Map(ledger.map((i) => [i.id, i]));

  // 1) Apply explicit reviewer classifications of prior issues.
  for (const c of classifications) {
    const existing = byId.get(c.id);
    if (existing) {
      existing.status = c.status;
      existing.lastSeenRound = round;
    }
  }

  // 2) Fold this round's findings into the ledger.
  for (const f of findings) {
    const id = f.ledgerId && byId.has(f.ledgerId) ? f.ledgerId : issueId(f.title);
    const existing = byId.get(id);
    if (existing) {
      existing.lastSeenRound = round;
      existing.severity = f.severity;
      existing.evidence = f.evidence;
      existing.status = f.novelty === 'regression' ? 'regression' : 'open';
    } else {
      const issue: PingPongIssue = {
        id,
        title: f.title,
        severity: f.severity,
        status: f.novelty === 'regression' ? 'regression' : 'open',
        evidence: f.evidence,
        file: f.file,
        raisedRound: round,
        lastSeenRound: round,
      };
      ledger.push(issue);
      byId.set(id, issue);
    }
  }
}

/** Build the intervention text injected into the builder's next prompt. */
function buildIntervention(
  review: PingPongReviewResult,
  blocking: readonly PingPongReviewFinding[],
  advisory: readonly PingPongReviewFinding[],
  localAdvisory: readonly FreshEyesFinding[],
): string {
  const head =
    `Ping-pong reviewer (${review.reviewerProvider}) did NOT approve. ` +
    `${review.summary}\n`;
  const blockingBlock =
    blocking.length > 0
      ? `\nBLOCKING — you must fix or rebut each before re-declaring done:\n` +
        blocking
          .map(
            (f, i) =>
              `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file})` : ''}\n` +
              `   evidence: ${f.evidence}\n   ${f.body}`,
          )
          .join('\n')
      : '';
  const advisoryBlock =
    advisory.length > 0
      ? `\n\nNon-blocking suggestions (optional):\n` +
        advisory.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}`).join('\n')
      : '';
  const localAdvisoryBlock = buildLocalAdvisoryBlock(localAdvisory);
  const guidance =
    `\n\nEvaluate each finding on its merits. Fix the valid ones. For ones you ` +
    `disagree with, briefly justify and push back in your reply — do not capitulate ` +
    `to be agreeable. Then declare done only when you genuinely believe the work is complete.`;
  return head + blockingBlock + advisoryBlock + localAdvisoryBlock + guidance;
}

function buildLocalAdvisoryBlock(localAdvisory: readonly FreshEyesFinding[]): string {
  return localAdvisory.length > 0
    ? `\n\nLocal-model advisory evidence (visible for consideration, but not blocking unless a remote reviewer independently finds it):\n` +
      localAdvisory.map((finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ''}\n` +
        `   ${finding.body}`,
      ).join('\n')
    : '';
}

function localAdvisoryFailure(error: unknown): LocalFreshEyesAdvisoryResult {
  const reason = error instanceof Error ? error.message : String(error);
  return { status: 'failed', findings: [], summary: reason, reason };
}

function emitLocalAdvisoryStatus(
  emit: LoopEmit,
  state: LoopState,
  seq: number,
  stage: LoopStage,
  local: LocalFreshEyesAdvisoryResult,
): void {
  const message = local.status === 'used'
    ? local.findings.length === 0
      ? 'Local advisory review completed cleanly.'
      : `Local advisory review reported ${local.findings.length} non-blocking finding(s): ${local.findings.map((finding) => finding.title).join('; ')}`
    : local.status === 'failed'
      ? `Local advisory review failed: ${local.reason ?? local.summary}`
      : `Local advisory review skipped: ${local.reason ?? local.summary}`;
  emit('loop:activity', {
    loopRunId: state.id,
    seq,
    stage,
    timestamp: Date.now(),
    kind: 'status',
    message,
    detail: {
      localAdvisoryStatus: local.status,
      advisoryFindings: local.findings,
    },
  });
}

function costCapExceeded(state: LoopState): boolean {
  const caps = state.config.caps;
  if (caps.maxCostCents !== null && state.totalCostCents >= caps.maxCostCents) return true;
  if (caps.maxTokens !== null && state.totalTokens >= caps.maxTokens) return true;
  return false;
}

/**
 * Dedicated ping-pong completion branch (bigchange_pingpong_review §4.3a).
 * Runs on EVERY builder completion attempt: when the builder declares done,
 * spawns a fresh different-provider agentic reviewer for ONE round. Converges
 * only on mutual APPROVED + done; otherwise injects findings and continues.
 * Fail-closed — an UNRELIABLE reviewer never silently passes.
 */
export async function evaluatePingPongCompletion(
  deps: PingPongGateDeps,
): Promise<PingPongTerminal | null> {
  const { state, iteration, fullOutput, seq, stage, classifyCleanReview, emit } = deps;
  const reviewCfg = state.config.completion.crossModelReview;
  const ppCfg = reviewCfg?.pingPong;
  if (!reviewCfg || !ppCfg?.enabled) return null;

  const pp = (state.pingPong ??= defaultPingPongState());
  const maxRounds = clampPingPongMaxRounds(ppCfg.maxRounds);

  // User control: force a jump to human arbitration.
  if (pp.forceArbitration) {
    return {
      status: 'needs-human-arbitration',
      reason: `Operator forced arbitration after ${pp.roundCount} round(s). Open issues:\n${summarizeOpen(pp.ledger)}`,
    };
  }

  // 1) Has the builder declared done this iteration? (one side of mutual convergence)
  const builderVerdict = await classifyCleanReview({
    goal: state.config.initialPrompt,
    workspaceCwd: state.config.workspaceCwd,
    iterationOutput: fullOutput ?? '',
    config: state.config.completion,
  });
  if (!builderVerdict.clean) {
    // Builder is still working — not a review round.
    return null;
  }

  // User control: skip this reviewer round (operator override).
  if (pp.skipNextRound) {
    pp.skipNextRound = false;
    emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: 'Ping-pong reviewer round skipped by operator',
    });
    return null;
  }

  // 2) Cost backstop BEFORE spawning an expensive reviewer.
  if (costCapExceeded(state)) {
    return {
      status: 'cost-exceeded',
      reason:
        `Ping-pong stopped on cost cap after ${pp.roundCount} round(s) ` +
        `(reviewer spend so far: ${pp.reviewerTokensUsed} tok / ${(pp.reviewerCostCents / 100).toFixed(2)} USD). ` +
        `Open issues:\n${summarizeOpen(pp.ledger)}`,
    };
  }

  // 3) Round cap backstop.
  if (pp.roundCount >= maxRounds) {
    return {
      status: 'cap-reached',
      reason:
        `Ping-pong hit its ${maxRounds}-round cap without mutual convergence. ` +
        `Open issues:\n${summarizeOpen(pp.ledger)}`,
    };
  }

  const subject = deps.resolveSubject
    ? await deps.resolveSubject(state, fullOutput).catch(() => resolvePingPongSubject(state, fullOutput))
    : resolvePingPongSubject(state, fullOutput);
  pp.subject = subject;

  const productionChanges = iteration.filesChanged.filter((f) => isReviewDrivenProductionChange(f.path));
  const noProductionChangeThisRound = productionChanges.length === 0;

  // When isolation is active the agent edits the worktree, not the repo root —
  // use executionCwd so the ping-pong reviewer sees the actual changes.
  const diffCwd = state.config.executionCwd ?? state.config.workspaceCwd;
  const workspaceDiff = collectWorkspaceDiff(diffCwd);
  const reviewer = deps.reviewer ?? agenticPingPongReviewer;
  const localAdvisoryReviewer = deps.localAdvisoryReviewer ?? runLocalOnlyFreshEyesReview;
  const timeoutMs = Math.max(60_000, (reviewCfg.timeoutSeconds || 0) * 1000 || DEFAULT_REVIEWER_TIMEOUT_MS);

  emit('loop:fresh-eyes-review-started', {
    loopRunId: state.id,
    signal: 'ping-pong',
    round: pp.roundCount + 1,
    maxRounds,
    subject,
  });

  const reviewerInput = {
    loopRunId: state.id,
    workspaceCwd: diffCwd,
    goal: state.config.initialPrompt,
    subject,
    planFile: state.config.planFile,
    builderProvider: state.config.provider,
    reviewerProviderSetting: ppCfg.reviewerProvider ?? 'auto',
    triedReviewerProviders: pp.triedReviewerProviders ?? [],
    ledger: pp.ledger,
    roundNumber: pp.roundCount + 1,
    maxRounds,
    diff: workspaceDiff.diff,
    diffSource: workspaceDiff.source,
    blockingSeverities: reviewCfg.blockingSeverities,
    timeoutMs,
    signal: deps.signal,
    isCancelled: deps.isCancelled,
    onSpawned: (id) => {
      pp.inFlightReviewerInstanceId = id;
      pp.inFlightRound = pp.roundCount + 1;
    },
  } satisfies Parameters<PingPongReviewer>[0];
  const localInput = {
    loopRunId: state.id,
    workspaceCwd: diffCwd,
    goal: state.config.initialPrompt,
    iterationOutput: fullOutput,
    diff: workspaceDiff.diff,
    diffSource: workspaceDiff.source,
    filesChangedThisIteration: iteration.filesChanged.map((file) => file.path),
    uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
    verifyOutputExcerpt: '',
    signal: 'ping-pong',
    abortSignal: deps.signal,
    config: reviewCfg,
    builderProvider: state.config.provider,
    planFile: state.config.planFile,
    subject,
  } satisfies Parameters<LocalFreshEyesAdvisoryReviewer>[0];

  let review: PingPongReviewResult;
  let localAdvisory: LocalFreshEyesAdvisoryResult;
  let roundCancelled = false;
  try {
    const remoteSettlement = settlePromise(() => reviewer(reviewerInput));
    const localSettlement = settlePromise(() => localAdvisoryReviewer(localInput));
    const remoteResult = await remoteSettlement;
    if (remoteResult.status === 'fulfilled') {
      review = remoteResult.value;
    } else {
      const err = remoteResult.reason;
      review = {
        verdict: 'UNRELIABLE',
        reviewerProvider: pp.lastReviewerProvider ?? '',
        findings: [],
        ledgerClassifications: [],
        summary: '',
        tokensUsed: 0,
        costCents: 0,
        reason: err instanceof Error ? err.message : String(err),
        fault: 'infra_error',
      };
    }
    const remoteCancelled = deps.signal.aborted || deps.isCancelled() ||
      (remoteResult.status === 'fulfilled' && remoteResult.value.spawnOutcome === 'cancelled');
    roundCancelled = remoteCancelled;
    if (remoteCancelled) {
      // The settlement promise consumes any eventual rejection, but its late
      // value is deliberately detached from completion authority and events.
      void localSettlement;
      localAdvisory = localAdvisoryFailure('cancelled with the ping-pong review');
    } else {
      const localResult = await waitForSettlementOrAbort(localSettlement, deps.signal);
      if (localResult.status === 'aborted') {
        roundCancelled = true;
        localAdvisory = localAdvisoryFailure('cancelled with the ping-pong review');
      } else {
        localAdvisory = localResult.status === 'fulfilled'
          ? localResult.value
          : localAdvisoryFailure(localResult.reason);
      }
    }
  } catch (err) {
    // A throw is treated as UNRELIABLE (fail-closed), never a pass. An unexpected
    // exception is an infrastructure problem with the reviewer, not the reviewer
    // judging the code — classify it as an availability fault.
    review = {
      verdict: 'UNRELIABLE',
      reviewerProvider: pp.lastReviewerProvider ?? '',
      findings: [],
      ledgerClassifications: [],
      summary: '',
      tokensUsed: 0,
      costCents: 0,
      reason: err instanceof Error ? err.message : String(err),
      fault: 'infra_error',
    };
    localAdvisory = localAdvisoryFailure(err);
  } finally {
    pp.inFlightReviewerInstanceId = undefined;
    pp.inFlightRound = undefined;
  }

  const advisoryFindings = localAdvisory.status === 'used'
    ? localAdvisory.findings.map((finding) => ({ ...finding, advisory: true as const }))
    : [];
  emitLocalAdvisoryStatus(emit, state, seq, stage, {
    ...localAdvisory,
    findings: advisoryFindings,
  });

  // Fold reviewer spend into the loop budget so the cost cap bounds ping-pong.
  pp.reviewerTokensUsed += review.tokensUsed;
  pp.reviewerCostCents += review.costCents;
  deps.foldReviewerSpend(review.tokensUsed, review.costCents);
  if (review.reviewerProvider) pp.lastReviewerProvider = review.reviewerProvider;

  // Cancellation (pause/cancel) — NOT a round, NOT unreliable. Let the loop's
  // top-of-iteration pause handling take over.
  if (roundCancelled || review.spawnOutcome === 'cancelled') {
    emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: 'Ping-pong reviewer round aborted (loop paused/cancelled)',
    });
    return null;
  }

  // 4) Fail-closed UNRELIABLE handling. Crucially, split "the reviewer was
  // UNAVAILABLE" (rate-limited / unreachable / no eligible provider — an
  // availability problem that says NOTHING about the code) from "the reviewer
  // ran but produced UNUSABLE output" (a genuine reviewer-quality fault). The
  // two escalate down separately-bounded paths so a throttled Codex never
  // masquerades as "the reviewer judged the code unreliable".
  if (review.verdict === 'UNRELIABLE') {
    const fault: PingPongReviewerFault = review.fault ?? 'malformed_output';
    const availability = isReviewerAvailabilityFault(fault);

    // One hard bound on consecutive unusable rounds (reset on any reliable
    // round). roundCount does NOT advance on UNRELIABLE, so this counter — with
    // the cost cap — is what prevents an unbounded reviewer-retry storm.
    pp.consecutiveUnreliableRounds += 1;

    // Rotate away from the provider that just failed so the next attempt tries a
    // different model. ('unavailable' carries no provider — nothing to rotate.)
    if (review.reviewerProvider) {
      pp.triedReviewerProviders = [
        ...new Set([...(pp.triedReviewerProviders ?? []), review.reviewerProvider]),
      ];
    }
    const triedSnapshot = [...(pp.triedReviewerProviders ?? [])];
    // A full-exhaustion 'unavailable' fault means every installed provider has
    // already been tried this run. Clear the rotation so they ALL get another
    // chance after back-off — transient throttling recovers with time, and the
    // builder's next iteration supplies that delay.
    if (fault === 'unavailable') {
      pp.triedReviewerProviders = [];
    }

    emit('loop:fresh-eyes-review-failed', {
      loopRunId: state.id,
      signal: 'ping-pong',
      round: pp.roundCount + 1,
      error: review.reason ?? 'reviewer unreliable',
      reviewerProvider: review.reviewerProvider,
      fault,
      advisoryFindings,
      localAdvisoryStatus: localAdvisory.status,
    });
    logger.warn('Ping-pong reviewer round UNRELIABLE', {
      loopRunId: state.id,
      consecutive: pp.consecutiveUnreliableRounds,
      fault,
      availability,
      reason: review.reason,
    });

    // Availability faults get a more lenient ceiling (they self-heal once a
    // provider frees up); quality faults escalate sooner. The terminal status is
    // chosen by the *last* fault so the surfaced state matches the real failure.
    const threshold = availability ? MAX_REVIEWER_UNAVAILABLE_ROUNDS : MAX_UNRELIABLE_ROUNDS;
    if (pp.consecutiveUnreliableRounds >= threshold) {
      const tried = triedSnapshot.join(', ') || 'none';
      const last = review.reason ?? 'n/a';
      return availability
        ? {
            status: 'reviewer-unavailable',
            reason:
              `Could not obtain a ping-pong review: the reviewer provider was ` +
              `UNAVAILABLE ${pp.consecutiveUnreliableRounds} rounds running (${fault}; tried: ${tried}). ` +
              `This is an availability problem with the reviewer — NOT a judgement on the code. ` +
              `Check the reviewer provider's auth/quota or set an explicit ` +
              `pingPongReviewerProvider. Last: ${last}.`,
          }
        : {
            status: 'reviewer-unreliable',
            reason:
              `Ping-pong reviewer produced UNUSABLE output ${pp.consecutiveUnreliableRounds} rounds ` +
              `running (${fault}; tried: ${tried}). Last: ${last}.`,
          };
    }
    // Below threshold → retry next iteration with the next eligible provider.
    return null;
  }

  // Reliable round — reset unreliable tracking + provider rotation.
  pp.consecutiveUnreliableRounds = 0;
  pp.triedReviewerProviders = [];
  pp.roundCount += 1;
  const round = pp.roundCount;

  applyLedgerUpdates(pp.ledger, review.ledgerClassifications, review.findings, round);

  // 5) Convergence — reviewer APPROVED AND builder declared done (both sides).
  if (review.verdict === 'APPROVED') {
    // impl mode: verify must also be green before converging (plan mode skips —
    // no code to run). A red verify re-opens the loop with the failure injected.
    if (subject === 'impl' && deps.runVerify) {
      const verify = await deps.runVerify().catch((error: unknown) => ({
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }));
      if (!verify.ok) {
        state.pendingInterventions.push(
          createLoopPendingInput(
            'The ping-pong reviewer APPROVED, but the configured verify command FAILED. ' +
            'Treat this as a blocking issue and fix it before re-declaring done:\n\n' +
            (verify.output.slice(0, 8192) || '(verify produced no output)') +
            buildLocalAdvisoryBlock(advisoryFindings),
          ),
        );
        emit('loop:fresh-eyes-review-blocked', {
          loopRunId: state.id,
          signal: 'ping-pong',
          round,
          reviewersUsed: [review.reviewerProvider],
          blockingFindings: [],
          summary: 'reviewer approved but verify failed',
          advisoryFindings,
          localAdvisoryStatus: localAdvisory.status,
        });
        return null;
      }
    }
    pp.builderUnaddressedRounds = 0;
    pp.consecutiveContradictoryRounds = 0;
    pp.lowOnlyChurnRounds = 0;
    emit('loop:fresh-eyes-review-passed', {
      loopRunId: state.id,
      signal: 'ping-pong',
      round,
      reviewersUsed: [review.reviewerProvider],
      summary: review.summary,
      advisoryFindings,
      localAdvisoryStatus: localAdvisory.status,
    });
    return {
      status: 'completed',
      reason:
        `Ping-pong converged after ${round} round(s): reviewer (${review.reviewerProvider}) ` +
        `APPROVED and builder declared done.`,
    };
  }

  // 6) CHANGES_REQUESTED — classify findings, inject, and decide whether to
  // continue or hit a deadlock/anti-nitpick backstop.
  const blockingSet = new Set(reviewCfg.blockingSeverities);
  const blocking = review.findings.filter((f) => blockingSet.has(f.severity));
  const advisory = review.findings.filter((f) => !blockingSet.has(f.severity));
  const persistedBlocking = blocking.filter((f) => f.novelty !== 'new');

  emit('loop:fresh-eyes-review-blocked', {
    loopRunId: state.id,
    signal: 'ping-pong',
    round,
    reviewersUsed: [review.reviewerProvider],
    blockingFindings: blocking,
    summary: review.summary,
    advisoryFindings,
    localAdvisoryStatus: localAdvisory.status,
  });

  state.pendingInterventions.push(createLoopPendingInput(
    buildIntervention(review, blocking, advisory, advisoryFindings),
  ));

  if (blocking.length === 0) {
    // Low-only churn round.
    pp.lowOnlyChurnRounds += 1;
    pp.builderUnaddressedRounds = 0;
    pp.consecutiveContradictoryRounds = 0;
    if (pp.lowOnlyChurnRounds >= MAX_LOW_ONLY_ROUNDS) {
      return {
        status: 'completed-needs-review',
        reason:
          `Ping-pong converged-or-arbitrated after ${round} rounds: only low-severity ` +
          `suggestions remained for ${pp.lowOnlyChurnRounds} rounds (no blocking issues). ` +
          `A human may glance at the remaining nits.`,
      };
    }
    return null;
  }

  // Blocking findings remain.
  pp.lowOnlyChurnRounds = 0;

  if (persistedBlocking.length > 0 && noProductionChangeThisRound) {
    // Builder declared done but changed nothing while blocking issues persist.
    pp.builderUnaddressedRounds += 1;
    pp.consecutiveContradictoryRounds = 0;
    if (pp.builderUnaddressedRounds >= MAX_UNADDRESSED_ROUNDS) {
      return {
        status: 'builder-unreliable',
        reason:
          `Builder declared done ${pp.builderUnaddressedRounds} rounds running without ` +
          `addressing the blocking findings. Contested issues:\n${summarizeOpen(pp.ledger)}`,
      };
    }
  } else if (persistedBlocking.length > 0) {
    // Builder DID change things but the same issue keeps being re-raised — a
    // genuine disagreement heading to deadlock.
    pp.consecutiveContradictoryRounds += 1;
    pp.builderUnaddressedRounds = 0;
    if (pp.consecutiveContradictoryRounds >= MAX_CONTRADICTORY_ROUNDS) {
      return {
        status: 'needs-human-arbitration',
        reason:
          `Builder and reviewer deadlocked over the same issue(s) for ` +
          `${pp.consecutiveContradictoryRounds} rounds. Contested:\n${summarizeOpen(pp.ledger)}`,
      };
    }
  } else {
    // All blocking findings are new — genuine progress, reset deadlock counters.
    pp.builderUnaddressedRounds = 0;
    pp.consecutiveContradictoryRounds = 0;
  }

  logger.info('Ping-pong round blocked — injected interventions, continuing', {
    loopRunId: state.id,
    round,
    blocking: blocking.length,
    persisted: persistedBlocking.length,
  });
  return null;
}

function summarizeOpen(ledger: readonly PingPongIssue[]): string {
  const open = ledger.filter((i) => i.status === 'open' || i.status === 'regression');
  if (open.length === 0) return '(no open issues recorded)';
  return open
    .map((i) => `- [${i.severity}] ${i.title}${i.file ? ` (${i.file})` : ''} — ${i.status}`)
    .join('\n');
}
