import { getLogger } from '../logging/logger';
import type {
  LoopIteration,
  LoopStage,
  LoopState,
} from '../../shared/types/loop.types';
import {
  createLoopPendingInput,
  defaultCrossModelReviewConfig,
} from '../../shared/types/loop.types';
import type { LoopCompletionDetector } from './loop-completion-detector';
import { LOOP_STATE_DIR_NAME } from './loop-artifact-paths';
import { collectWorkspaceDiff } from './loop-diff';
import {
  computeCompletionEvidenceHash,
  computeReviewThreadSet,
  dedupeAndRankFindings,
  diffReviewThreads,
  pushBoundedEvidence,
} from './review-thread-fingerprint';
import type { CompletionSignalEvidence } from '../../shared/types/loop-state.types';
import type { EvidenceResolution } from './evidence-resolver';
import type {
  FreshEyesReviewer,
  FreshEyesReviewerResult,
  FreshEyesSeverity,
} from './loop-fresh-eyes-reviewer';
import type { LoopCleanReviewClassifier } from './loop-clean-review-classifier';
import type { LoopStageMachine } from './loop-stage-machine';
import { applyVerifyOutcomeToIteration, verifyFailureIntervention } from './loop-coordinator-utils';

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
  /**
   * F2 (#22): distinct severities among the blocking findings (worst-first,
   * only set when `blocked`). Feeds the REVIEW→PLAN back-edge veto's
   * `architecturalStatus` field.
   */
  blockingSeverities?: FreshEyesSeverity[];
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
  classifyCleanReview: LoopCleanReviewClassifier;
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
    classifyCleanReview,
    emit,
  } = args;
  const cfg = state.config.completion;
  const required = Math.max(1, cfg.requiredCleanReviewPasses ?? 2);

  const productionChanges = iteration.filesChanged.filter((f) => isReviewDrivenProductionChange(f.path));
  const noProductionChanges = productionChanges.length === 0;
  const reviewVerdict = await classifyCleanReview({
    goal: state.config.initialPrompt,
    workspaceCwd: state.config.workspaceCwd,
    iterationOutput: fullOutput ?? '',
    config: cfg,
  });

  let verifyOk = true;
  if (reviewVerdict.clean && noProductionChanges && cfg.verifyCommand?.trim()) {
    const v = await completionDetector.runVerify(state.config);
    applyVerifyOutcomeToIteration(iteration, v);
    if (v.status === 'failed') {
      verifyOk = false;
      state.pendingInterventions.push(
        createLoopPendingInput(
          verifyFailureIntervention('verify', v.output, v.failureKind),
        ),
      );
    }
  }

  const cleanPass = reviewVerdict.clean && noProductionChanges && verifyOk;

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
      detail: { consecutiveCleanReviewPasses: count, required, reason: reviewVerdict.reason },
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

export function isReviewDrivenProductionChange(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized.includes(`${LOOP_STATE_DIR_NAME}/`)) return false;
  if (normalized === LOOP_STATE_DIR_NAME) return false;
  if (normalized.startsWith('server/')) return false;
  if (/\.(db|db-shm|db-wal|sqlite|sqlite3|mv\.db)$/i.test(normalized)) return false;
  if (/\/logs?\//i.test(normalized) || /(^|\/)latest\.log$/i.test(normalized)) return false;
  return true;
}

/**
 * claude2_todo #1c: record a completion attempt's *evidence hash* into a
 * bounded ring buffer on state. Identical evidence (same trigger signal, same
 * verify outcome, same belt-and-braces state, same unresolved review threads)
 * re-presented across attempts climbs `repeatedEvidenceCount`; the count only
 * resets when the evidence actually changes — so unchanged weak evidence can't
 * masquerade as progress. Surfaces a stuck-evidence convergence note (it feeds
 * describeCapReason) when the same evidence repeats on a continue decision.
 * Extracted verbatim from the coordinator's completion seam.
 */
export function trackRepeatedCompletionEvidence(args: {
  state: LoopState;
  candidate: CompletionSignalEvidence;
  verifyStatus: 'passed' | 'failed' | 'skipped';
  beltAndBracesPassed: boolean;
  resolution: Pick<EvidenceResolution, 'decision' | 'outcome'>;
  convergenceNotes: Map<string, string>;
}): void {
  const { state, candidate, verifyStatus, beltAndBracesPassed, resolution, convergenceNotes } = args;
  const evidenceHash = computeCompletionEvidenceHash({
    candidateId: candidate.id,
    verifyStatus,
    beltAndBracesPassed,
    unresolvedReviewThreads: state.unresolvedReviewThreads ?? [],
  });
  const evidence = pushBoundedEvidence(state.recentEvidenceHashes, evidenceHash);
  state.recentEvidenceHashes = evidence.buffer;
  state.repeatedEvidenceCount = evidence.repeatCount;
  if (resolution.decision === 'continue' && evidence.repeatCount >= 2) {
    const stuck =
      `the same completion evidence has now been presented ${evidence.repeatCount} times without change`;
    const existingNote = convergenceNotes.get(state.id);
    convergenceNotes.set(state.id, existingNote ? `${existingNote}; ${stuck}` : stuck);
    logger.info('Loop completion attempt re-presented identical evidence', {
      loopRunId: state.id,
      signal: candidate.id,
      repeatCount: evidence.repeatCount,
      outcome: resolution.outcome,
    });
  }
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
  // A4: consume the one-shot contradiction flag before the enabled check so a
  // contradiction-forced review runs even when crossModelReview is off/absent.
  const forcedByContradiction = state.freshEyesForcedByContradiction === true;
  if (forcedByContradiction) {
    state.freshEyesForcedByContradiction = false;
  }
  const effectiveCfg = (reviewCfg?.enabled ? reviewCfg : null) ?? (forcedByContradiction ? defaultCrossModelReviewConfig() : null);
  if (!effectiveCfg) {
    return { blocked: false, ran: false, errored: false };
  }
  if (forcedByContradiction && !reviewCfg?.enabled) {
    logger.info('Running forced fresh-eyes review after verify contradiction', { loopRunId: state.id });
  }

  // D6 (#7) part 3: instant ALLOW for non-edit turns. A clean cross-model
  // verdict is cached on state (`freshEyesCleanForWorkState`) and stays valid
  // while no production file changes land; a completion attempt from a
  // status/summary-only iteration reuses it instead of paying another
  // multi-minute cross-model review. This never fabricates authority: the
  // flag is ONLY set by a real clean review below, and the coordinator
  // invalidates it on any later iteration that touches production files
  // (edit-invalidates-proof, symmetric with the stale-verify rung). A
  // contradiction-forced review always runs for real. Opt-in via
  // `completion.antiSelfGrading`.
  if (
    state.config.completion.antiSelfGrading === true
    && !forcedByContradiction
    && state.freshEyesCleanForWorkState === true
    && !iteration.filesChanged.some((f) => isReviewDrivenProductionChange(f.path))
  ) {
    logger.info('Fresh-eyes gate: instant ALLOW — clean verdict cached, no production changes since', {
      loopRunId: state.id,
      signal: signalId,
    });
    emit('loop:fresh-eyes-review-passed', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: [],
      nonBlockingFindings: 0,
      summary: 'instant ALLOW — no production changes since the last clean fresh-eyes review',
      instantAllow: true,
    });
    return { blocked: false, ran: true, errored: false };
  }

  emit('loop:fresh-eyes-review-started', { loopRunId: state.id, signal: signalId });

  // When isolation is active the agent edits the worktree, not the repo root —
  // use executionCwd so the reviewer sees the actual changes.
  const diffCwd = state.config.executionCwd ?? state.config.workspaceCwd;
  const workspaceDiff = collectWorkspaceDiff(diffCwd);
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
      config: effectiveCfg,
    });
  } catch (err) {
    logger.warn('Fresh-eyes reviewer threw - no clean review verdict produced', {
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
    (effectiveCfg.blockingSeverities as readonly string[]).includes(f.severity),
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
    // D6 (#7) part 3: cache the clean verdict for the current work state. The
    // coordinator clears this on any later production-file change.
    state.freshEyesCleanForWorkState = true;
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
  // D6 (#7) part 3: a blocked review invalidates any cached clean verdict.
  state.freshEyesCleanForWorkState = false;

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

  state.pendingInterventions.push(createLoopPendingInput(interventionMessage));
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
  return { blocked: true, ran: true, errored: false, blockingSeverities: orderedSeverities };
}
