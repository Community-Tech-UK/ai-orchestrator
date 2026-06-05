import { getLogger } from '../logging/logger';
import type {
  LoopIteration,
  LoopStage,
  LoopState,
} from '../../shared/types/loop.types';
import type { LoopCompletionDetector } from './loop-completion-detector';
import { LOOP_STATE_DIR_NAME } from './loop-artifact-paths';
import { collectWorkspaceDiff } from './loop-diff';
import {
  computeReviewThreadSet,
  dedupeAndRankFindings,
  diffReviewThreads,
} from './review-thread-fingerprint';
import type {
  FreshEyesReviewer,
  FreshEyesReviewerResult,
} from './loop-fresh-eyes-reviewer';
import type { LoopStageMachine } from './loop-stage-machine';
import { excerpt } from './loop-coordinator-utils';

const logger = getLogger('LoopCoordinator');

type LoopEmit = (eventName: string, payload: unknown) => void;

/**
 * Result of the fresh-eyes cross-model review gate. `ran`/`errored` let the
 * evidence resolver tell a clean review verdict apart from a reviewer that was
 * never run or whose infrastructure failed.
 */
export interface FreshEyesGateResult {
  /** A blocking finding was raised - the loop must continue. */
  blocked: boolean;
  /** The reviewer was invoked (review enabled and attempted). */
  ran: boolean;
  /** The reviewer threw / infrastructure was unavailable. */
  errored: boolean;
}

export async function evaluateReviewDrivenCompletion(args: {
  state: LoopState;
  iteration: LoopIteration;
  fullOutput: string;
  stageMachine: LoopStageMachine;
  seq: number;
  stage: LoopStage;
  completionDetector: LoopCompletionDetector;
  runFreshEyesReviewGate: (
    signalId: string,
    iteration: LoopIteration,
    verifyOutput: string,
  ) => Promise<FreshEyesGateResult>;
  emit: LoopEmit;
}): Promise<{ status: 'completed' | 'completed-needs-review'; reason: string } | null> {
  const {
    state,
    iteration,
    fullOutput,
    stageMachine,
    seq,
    stage,
    completionDetector,
    runFreshEyesReviewGate,
    emit,
  } = args;
  const cfg = state.config.completion;
  const phrase = (cfg.noOutstandingPhrase ?? 'There are no outstanding issues').trim().toLowerCase();
  const required = Math.max(1, cfg.requiredCleanReviewPasses ?? 2);

  const productionChanges = iteration.filesChanged.filter(
    (f) => !f.path.includes(`${LOOP_STATE_DIR_NAME}/`) && !f.path.includes(`${LOOP_STATE_DIR_NAME}\\`),
  );
  const sentinelPresent = (fullOutput ?? '').toLowerCase().includes(phrase);
  const noProductionChanges = productionChanges.length === 0;

  let verifyOk = true;
  if (sentinelPresent && noProductionChanges && cfg.verifyCommand?.trim()) {
    const v = await completionDetector.runVerify(state.config);
    iteration.verifyStatus = v.status === 'skipped' ? 'not-run' : v.status;
    iteration.verifyOutputExcerpt = excerpt(v.output);
    if (v.status === 'failed') {
      verifyOk = false;
      state.pendingInterventions.push(
        'Your review reported no outstanding issues, but the configured verify command failed. ' +
        'Treat this as an outstanding issue and fix it before signalling done again:\n\n' +
        (excerpt(v.output, 8192) || '(verify produced no output)'),
      );
    }
  }

  const cleanPass = sentinelPresent && noProductionChanges && verifyOk;

  if (cleanPass) {
    state.consecutiveCleanReviewPasses = (state.consecutiveCleanReviewPasses ?? 0) + 1;
    const count = state.consecutiveCleanReviewPasses;
    emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: `Clean fresh-eyes review pass ${count}/${required}`,
      detail: { consecutiveCleanReviewPasses: count, required },
    });
    if (count >= required) {
      if (state.config.completion.crossModelReview?.enabled) {
        const review = await runFreshEyesReviewGate('self-declared', iteration, '');
        if (review.blocked) {
          state.consecutiveCleanReviewPasses = 0;
          return null;
        }
      }
      state.lastCompletionOutcome = 'accepted';
      const outstanding = await stageMachine.readOutstanding().catch(() => ({ raw: '', needsHuman: false }));
      if (outstanding.needsHuman) {
        return {
          status: 'completed-needs-review',
          reason:
            `Converged after ${required} consecutive clean fresh-eyes reviews. The agent flagged ` +
            `items that need a human in OUTSTANDING.md:\n\n${outstanding.raw.trim()}`,
        };
      }
      return {
        status: 'completed',
        reason: `Converged after ${required} consecutive clean fresh-eyes reviews - no outstanding issues found.`,
      };
    }
    return null;
  }

  const had = state.consecutiveCleanReviewPasses ?? 0;
  state.consecutiveCleanReviewPasses = 0;
  if (had > 0) {
    emit('loop:activity', {
      loopRunId: state.id,
      seq,
      stage,
      timestamp: Date.now(),
      kind: 'status',
      message: 'Clean-review streak reset - more work happened this iteration',
      detail: { previousStreak: had },
    });
  }
  return null;
}

export async function runFreshEyesReviewGate(args: {
  state: LoopState;
  signalId: string;
  iteration: LoopIteration;
  verifyOutput: string;
  reviewer: FreshEyesReviewer;
  emit: LoopEmit;
  setConvergenceNote: (note: string) => void;
}): Promise<FreshEyesGateResult> {
  const { state, signalId, iteration, verifyOutput, reviewer, emit, setConvergenceNote } = args;
  const reviewCfg = state.config.completion.crossModelReview;
  if (!reviewCfg || !reviewCfg.enabled) {
    return { blocked: false, ran: false, errored: false };
  }

  emit('loop:fresh-eyes-review-started', { loopRunId: state.id, signal: signalId });

  const workspaceDiff = collectWorkspaceDiff(state.config.workspaceCwd);
  const iterationFiles = iteration.filesChanged.map((f) => f.path);
  const filesChangedThisIteration = iterationFiles.length > 0
    ? iterationFiles
    : workspaceDiff.changedFiles;

  let reviewResult: FreshEyesReviewerResult;
  try {
    reviewResult = await reviewer({
      loopRunId: state.id,
      workspaceCwd: state.config.workspaceCwd,
      goal: state.config.initialPrompt,
      iterationOutput: iteration.outputExcerpt,
      diff: workspaceDiff.diff,
      diffSource: workspaceDiff.source,
      filesChangedThisIteration,
      uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
      verifyOutputExcerpt: verifyOutput.slice(0, 4096),
      signal: signalId,
      terminalIntent: state.terminalIntentPending?.kind === 'complete'
        ? state.terminalIntentPending
        : undefined,
      config: reviewCfg,
    });
  } catch (err) {
    logger.warn('Fresh-eyes reviewer threw - letting completion proceed', {
      loopRunId: state.id,
      error: err instanceof Error ? err.message : String(err),
    });
    emit('loop:fresh-eyes-review-failed', {
      loopRunId: state.id,
      signal: signalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { blocked: false, ran: true, errored: true };
  }

  const blocking = reviewResult.findings.filter((f) =>
    (reviewCfg.blockingSeverities as readonly string[]).includes(f.severity),
  );

  if (blocking.length === 0) {
    if (reviewResult.reviewersUsed.length === 0) {
      logger.warn(
        'Fresh-eyes review returned no reviewers - treating as unavailable, not a clean pass',
        {
          loopRunId: state.id,
          signal: signalId,
          infrastructureError: reviewResult.infrastructureError,
        },
      );
      emit('loop:fresh-eyes-review-failed', {
        loopRunId: state.id,
        signal: signalId,
        error:
          reviewResult.infrastructureError ??
          'no reviewers available for fresh-eyes review',
      });
      return { blocked: false, ran: true, errored: true };
    }

    state.unresolvedReviewThreads = [];
    emit('loop:fresh-eyes-review-passed', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: reviewResult.reviewersUsed,
      nonBlockingFindings: reviewResult.findings.length,
      summary: reviewResult.summary,
      infrastructureError: reviewResult.infrastructureError,
    });
    logger.info('Fresh-eyes review passed', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: reviewResult.reviewersUsed,
      findings: reviewResult.findings.length,
    });
    return { blocked: false, ran: true, errored: false };
  }

  // Collapse cross-reviewer duplicates and order worst-first so the agent sees
  // each distinct blocker once. This affects presentation only — the block
  // decision was already made above by the severity filter.
  const ranked = dedupeAndRankFindings(blocking);
  const dedupedFindings = ranked.map((r) => r.finding);
  const orderedSeverities = [...new Set(ranked.map((r) => r.finding.severity))];

  const prevThreads = state.unresolvedReviewThreads ?? [];
  const currThreads = computeReviewThreadSet(dedupedFindings);
  const threadDiff = diffReviewThreads(prevThreads, currThreads);
  state.unresolvedReviewThreads = currThreads;

  const persistenceNote =
    threadDiff.persisted.length > 0
      ? `\n\n${threadDiff.persisted.length} of these ` +
        `${threadDiff.persisted.length === 1 ? 'finding has' : 'findings have'} persisted UNRESOLVED ` +
        'across review rounds. Re-running the same change will be rejected again - actually fix ' +
        'them (or change approach) before re-declaring completion.'
      : '';

  const interventionMessage =
    `Fresh-eyes cross-model review (${reviewResult.reviewersUsed.join(', ') || 'reviewers'}) ` +
    `blocked completion with ${ranked.length} ${ranked.length === 1 ? 'issue' : 'issues'} ` +
    `(severities: ${orderedSeverities.join(', ')}):\n\n` +
    ranked
      .map((r, i) => {
        const f = r.finding;
        const corroboration =
          r.corroborations > 1 ? ` [flagged ${r.corroborations} times]` : '';
        return `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file})` : ''}${corroboration}\n   ${f.body}`;
      })
      .join('\n\n') +
    persistenceNote +
    `\n\nAddress each item, then re-attempt completion.`;

  state.pendingInterventions.push(interventionMessage);
  setConvergenceNote(
    `${ranked.length} blocking review finding(s) remained` +
      (threadDiff.persisted.length > 0
        ? `, ${threadDiff.persisted.length} unresolved across multiple rounds`
        : '') +
      (reviewResult.reviewersUsed.length > 0 ? ` (reviewers: ${reviewResult.reviewersUsed.join(', ')})` : ''),
  );
  emit('loop:fresh-eyes-review-blocked', {
    loopRunId: state.id,
    signal: signalId,
    reviewersUsed: reviewResult.reviewersUsed,
    blockingFindings: dedupedFindings,
    summary: reviewResult.summary,
  });
  logger.info('Fresh-eyes review blocked completion - injected interventions', {
    loopRunId: state.id,
    signal: signalId,
    blocking: ranked.length,
    severities: orderedSeverities,
  });
  return { blocked: true, ran: true, errored: false };
}
