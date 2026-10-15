import type { LoopSpendPortion, LoopUsageProvenance } from '../../shared/types/loop-spend.types';
import { getLogger } from '../logging/logger';
import type {
  LoopIteration,
  LoopStage,
  LoopState,
  LoopStatus,
  PingPongReviewerFault,
  PingPongSubject,
} from '../../shared/types/loop.types';
import {
  clampPingPongMaxRounds,
  clampPingPongReviewerTimeoutSeconds,
  createLoopPendingInput,
  defaultPingPongState,
  isReviewerAvailabilityFault,
} from '../../shared/types/loop.types';
import { collectWorkspaceDiff } from './loop-diff';
import { loopExecutionCwd } from './loop-cwd';
import { redactForEgress } from '../security/content-egress-gate';
import { isReviewDrivenProductionChange } from './loop-coordinator-completion-gates';
import { excerptVerifyOutput } from './loop-coordinator-utils';
import { resolvePingPongSubject } from './pingpong-intent-classifier';
import type { LoopCleanReviewClassifier } from './loop-clean-review-classifier';
import { emitBuilderDoneSignalActivity, resolvePingPongBuilderDone } from './loop-pingpong-builder-done';
import {
  agenticPingPongReviewer,
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
import { applyLedgerUpdates, buildIntervention, issueId, summarizeOpen } from './pingpong-round-helpers';
import { parseBuilderFindingReplies } from './pingpong-builder-replies';
import { reviewDelta, snapshotReviewedFiles } from './pingpong-review-delta';
import { resolveLoopReviewEffort } from './loop-review-effort';
import { workspaceAnchorDigest } from './loop-review-reuse-anchor';
import { dataBlock } from '../util/prompt-data';
import { settlePromise, waitForSettlementOrAbort } from './abortable-promise-settlement';

const logger = getLogger('LoopPingPong');

type LoopEmit = (eventName: string, payload: unknown) => void;

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
const MAX_CONTRADICTORY_ROUNDS = 2;
/** Builder declares done but ignores blocking findings N rounds → builder-unreliable. */
const MAX_UNADDRESSED_ROUNDS = 3;

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
  foldReviewerSpend: (tokens: number, costCents: number, exactCostCents?: number, spendRecords?: number, basis?: LoopUsageProvenance, spendBreakdown?: LoopSpendPortion[]) => void;
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
  let maxRounds = clampPingPongMaxRounds(ppCfg.maxRounds);

  // User control: force a jump to human arbitration.
  if (pp.forceArbitration) {
    return {
      status: 'needs-human-arbitration',
      reason: `Operator forced arbitration after ${pp.roundCount} round(s). Open issues:\n${summarizeOpen(pp.ledger)}`,
    };
  }

  // 1) Has the builder declared done this iteration? (one side of mutual convergence)
  const builderVerdict = await resolvePingPongBuilderDone(iteration.completionSignalsFired, classifyCleanReview, {
    goal: state.config.initialPrompt,
    // Work product, not loop state — see `loop-cwd.ts`.
    executionCwd: loopExecutionCwd(state.config),
    iterationOutput: fullOutput ?? '',
    config: state.config.completion,
  }, {
    lastLedgerCompleteWorkHash: pp.lastLedgerCompleteWorkHash,
    currentWorkHash: iteration.workHash,
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

  if (builderVerdict.signal?.id === 'ledger-complete') {
    pp.lastLedgerCompleteWorkHash = iteration.workHash;
  }

  const subject = deps.resolveSubject
    ? await deps.resolveSubject(state, fullOutput).catch(() => resolvePingPongSubject(state, fullOutput))
    : resolvePingPongSubject(state, fullOutput);
  pp.subject = subject;

  const productionChanges = iteration.filesChanged.filter((f) => isReviewDrivenProductionChange(f.path));
  const noProductionChangeThisRound = productionChanges.length === 0;

  // When isolation is active the agent edits the worktree, not the repo root —
  // use the execution cwd so the ping-pong reviewer sees the actual changes.
  const diffCwd = loopExecutionCwd(state.config);
  const fullDiff = collectWorkspaceDiff(diffCwd);
  const effort = resolveLoopReviewEffort({ files: fullDiff.changedFiles, changedLines: fullDiff.truncated || fullDiff.source !== 'git' || /binary/i.test(fullDiff.diff) ? undefined : (fullDiff.diff.match(/^[+-](?![+-])/gm) ?? []).length });
  if (state.reviewEffort !== 'standard' && state.reviewEffort !== effort.level) {
    state.reviewEffort = effort.level;
    const budget = effort.level === 'light' ? Math.min(maxRounds, Math.max(2, Math.ceil(maxRounds / 3))) : maxRounds;
    emit('loop:activity', { loopRunId: state.id, seq, stage, timestamp: Date.now(), kind: 'status', message: `Review depth: ${effort.level} (${effort.reason}): ${effort.level === 'light' ? 'one reviewer and ' : ''}at most ${budget} review rounds.` });
  }
  if (state.reviewEffort === 'light') maxRounds = Math.min(maxRounds, Math.max(2, Math.ceil(maxRounds / 3)));
  if (pp.roundCount >= maxRounds) {
    return { status: 'cap-reached', reason: `Ping-pong hit its ${maxRounds}-round cap without mutual convergence. Open issues:\n${summarizeOpen(pp.ledger)}` };
  }
  const replies = parseBuilderFindingReplies(fullOutput, pp.ledger.filter(issue => issue.status !== 'resolved').map(issue => issue.id));
  for (const reply of replies) {
    const issue = pp.ledger.find(issue => issue.id === reply.id);
    if (issue) { issue.builderClaim = reply.claim; issue.builderResponse = reply.response; }
  }
  const digest = workspaceAnchorDigest(diffCwd);
  const mentionsOpen = pp.ledger.some(issue => issue.status !== 'resolved' && (fullOutput.includes(issue.id) || fullOutput.toLowerCase().includes(issue.title.toLowerCase())));
  if (digest && pp.lastChangesRequestedDigest === digest && pp.skippedReviewForDigest !== digest && !mentionsOpen && !replies.some(reply => reply.claim === 'rebutted')) {
    pp.skippedReviewForDigest = digest; pp.builderUnaddressedRounds += 1;
    emit('loop:activity', { loopRunId: state.id, seq, stage, timestamp: Date.now(), kind: 'status', message: 'Review skipped: nothing changed since the last review.' });
    state.pendingInterventions.push(createLoopPendingInput('Nothing changed since the last review, so the reviewer was not run again. These findings are still open; fix each one or rebut it by id, using the same reply form.\n' + dataBlock('review_findings', summarizeOpen(pp.ledger))));
    return pp.builderUnaddressedRounds >= MAX_UNADDRESSED_ROUNDS ? { status: 'builder-unreliable', reason: 'The builder kept declaring done without addressing the open findings.' } : null;
  }
  const priorPaths = pp.lastReviewedFiles?.map(file => file.path) ?? [];
  const currentFiles = snapshotReviewedFiles(diffCwd, [...new Set([...fullDiff.changedFiles, ...priorPaths])]);
  const delta = reviewDelta(pp.lastReviewedFiles, currentFiles, pp.roundCount + 1);
  // A reverted file disappears from the HEAD diff. Retain its hash in the
  // comparison and use the full packet so a reviewer cannot miss the revert.
  const allChangedInDiff = delta?.changed.every(file => fullDiff.changedFiles.includes(file));
  const useDelta = pp.roundCount > 0 && pp.roundCount + 1 < maxRounds && !!delta?.changed.length && allChangedInDiff;
  const workspaceDiff = useDelta ? collectWorkspaceDiff(diffCwd, { paths: delta!.changed }) : fullDiff;
  // WS3: the diff leaves the process for a different-provider reviewer session —
  // pass it through the egress gate (marker-preserving) before it reaches any
  // prompt. Idempotent, so downstream gates double-redacting is harmless.
  const diffEgress = redactForEgress(workspaceDiff.diff, { kind: 'diff' });
  if (diffEgress.secretsFound) {
    logger.warn('Ping-pong review diff contained potential secrets — redacted before reviewer egress', {
      loopRunId: state.id,
      secretCount: diffEgress.secretCount,
    });
  }
  const reviewDiff = diffEgress.content;
  const reviewer = deps.reviewer ?? agenticPingPongReviewer;
  const localAdvisoryReviewer = deps.localAdvisoryReviewer ?? runLocalOnlyFreshEyesReview;
  // A ping-pong round spawns a full agentic reviewer session, so it gets its own
  // budget. It must NOT inherit `crossModelReview.timeoutSeconds` (ships as 90s
  // for the one-shot headless reviewer) — that timed out ~half of all rounds,
  // and an UNRELIABLE round never advances `roundCount`, so convergence stalled.
  const timeoutMs = clampPingPongReviewerTimeoutSeconds(ppCfg.reviewerTimeoutSeconds) * 1000;

  emitBuilderDoneSignalActivity(emit, { loopRunId: state.id, seq, stage, verdict: builderVerdict });

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
    ...(iteration.model ? { builderModel: iteration.model } : {}),
    reviewerProviderSetting: ppCfg.reviewerProvider ?? 'auto',
    triedReviewerProviders: pp.triedReviewerProviders ?? [],
    ledger: pp.ledger,
    roundNumber: pp.roundCount + 1,
    maxRounds,
    diff: reviewDiff,
    diffSource: workspaceDiff.source,
    ...(useDelta ? { deltaNote: delta!.note } : {}),
    changedFiles: workspaceDiff.changedFiles,
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
    diff: reviewDiff,
    diffSource: workspaceDiff.source,
    filesChangedThisIteration: iteration.filesChanged.map((file) => file.path),
    uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
    verifyOutputExcerpt: '',
    signal: 'ping-pong',
    abortSignal: deps.signal,
    config: reviewCfg,
    builderProvider: state.config.provider,
    ...(iteration.model ? { builderModel: iteration.model } : {}),
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
  if (review.spendBreakdown) deps.foldReviewerSpend(review.tokensUsed, review.costCents, review.exactCostCents, review.spendRecords, review.costBasis, review.spendBreakdown);
  else if (review.exactCostCents !== undefined || review.spendRecords !== undefined) deps.foldReviewerSpend(review.tokensUsed, review.costCents, review.exactCostCents, review.spendRecords, review.costBasis);
  else deps.foldReviewerSpend(review.tokensUsed, review.costCents);
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

  // The reviewer can exhaust a cap while returning APPROVED. Spending limits
  // remain authoritative before any completion or another retry is accepted.
  if (costCapExceeded(state)) {
    return { status: 'cost-exceeded', reason: `Ping-pong stopped at the spending limit after the reviewer call (${state.totalTokens} tokens; $${(state.totalCostCents / 100).toFixed(2)}). Open issues:\n${summarizeOpen(pp.ledger)}` };
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

  // Reliable decisions follow blocking findings, including injected reviewers.
  const blockingSet = new Set(reviewCfg.blockingSeverities);
  const blocking = review.findings.filter(finding => blockingSet.has(finding.severity));
  const optional = review.findings.filter(finding => !blockingSet.has(finding.severity));
  advisoryFindings.push(...optional.map(finding => ({ ...finding, confidence: 1, advisory: true as const })));
  review.verdict = blocking.length > 0 ? 'CHANGES_REQUESTED' : 'APPROVED';
  if (currentFiles) pp.lastReviewedFiles = currentFiles;
  if (review.verdict === 'CHANGES_REQUESTED') pp.lastChangesRequestedDigest = digest ?? undefined;
  else { pp.lastChangesRequestedDigest = undefined; pp.skippedReviewForDigest = undefined; }
  const reRaisedRebuttal = blocking.find(finding => pp.ledger.some(issue => (finding.ledgerId ?? issueId(finding.title)) === issue.id && issue.builderClaim === 'rebutted'));
  if (reRaisedRebuttal) return { status: 'needs-human-arbitration', reason: `The reviewer raised the same finding again after the builder disputed it: ${reRaisedRebuttal.title}. Decide which is right.` };

  // Reliable round — reset unreliable tracking + provider rotation.
  pp.consecutiveUnreliableRounds = 0;
  pp.triedReviewerProviders = [];
  pp.roundCount += 1;
  const round = pp.roundCount;

  applyLedgerUpdates(pp.ledger, review.ledgerClassifications, blocking, round);

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
            dataBlock('verify_result', excerptVerifyOutput(verify.output, 8192) || '(verify produced no output)'),
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
        `APPROVED and builder declared done. The reviewer left ${advisoryFindings.length} optional suggestions.`,
    };
  }

  // 6) CHANGES_REQUESTED — classify findings, inject, and decide whether to
  // continue or hit a deadlock/anti-nitpick backstop.
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
    buildIntervention(review, blocking),
  ));

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
