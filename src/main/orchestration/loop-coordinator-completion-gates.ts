import { randomUUID } from 'node:crypto';
import { getLogger } from '../logging/logger';
import type {
  LoopIteration,
  LoopReviewAngleCoverageEntry,
  LoopStage,
  LoopState,
} from '../../shared/types/loop.types';
import {
  createLoopPendingInput,
  defaultCrossModelReviewConfig,
} from '../../shared/types/loop.types';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import { isReviewDrivenProductionChange, workspaceAnchorDigest } from './loop-review-reuse-anchor';

export { isReviewDrivenProductionChange, workspaceAnchorDigest } from './loop-review-reuse-anchor';
import { loopExecutionCwd } from './loop-cwd';
import { collectWorkspaceDiff } from './loop-diff';
import { redactForEgress } from '../security/content-egress-gate';
import {
  computeCompletionEvidenceHash,
  computeReviewThreadSet,
  dedupeAndRankFindings,
  diffReviewThreads,
  pushBoundedEvidence,
} from './review-thread-fingerprint';
import type { CompletionSignalEvidence } from '../../shared/types/loop-state.types';
import type { EvidenceResolution } from './evidence-resolver';
import {
  isBlockingFreshEyesFinding,
  type FreshEyesFinding,
  type FreshEyesReviewer,
  type FreshEyesReviewerResult,
  type FreshEyesSeverity,
} from './loop-fresh-eyes-reviewer';
import { getReviewArtifact, persistReviewArtifact } from './review-artifact-anchor';
import { classifyFreshEyesBlocking } from './fresh-eyes-blocking';
import { buildReviewAngleCacheHook, computeRequiredCoverageMet, persistReviewCoverageReport } from './review-coverage';
import {
  CLEAN_REVIEW_SENTINEL,
  UNCLEAR_CLEAN_REVIEW,
  type LoopCleanReviewClassifier,
} from './loop-clean-review-classifier';
import { hasTerminalSentinelLine } from './loop-terminal-sentinels';
import type { LoopStageMachine } from './loop-stage-machine';
import { applyVerifyOutcomeToIteration, excerptVerifyOutput, verifyFailureIntervention } from './loop-coordinator-utils';
import { runLoopVerify, type LoopVerifyReplayPort } from './loop-verify-runner';

const logger = getLogger('LoopCoordinator');

type LoopEmit = (eventName: string, payload: unknown) => void;

function shouldRunCleanReviewClassifier(
  output: string,
  noOutstandingPhrase: string | undefined,
  signals: readonly { sufficient: boolean }[],
): boolean {
  if (signals.some((signal) => signal.sufficient)) return true;
  if (hasTerminalSentinelLine(output, CLEAN_REVIEW_SENTINEL)) return true;
  const phrase = (noOutstandingPhrase ?? 'There are no outstanding issues').trim().toLowerCase();
  if (!phrase) return false;
  return output.replace(/\s+/g, ' ').toLowerCase().includes(phrase);
}

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
  /**
   * WS-A3: severity-blocking findings that were demoted to advisory because
   * their cited evidence could not be verified against the persisted
   * artifact for this review attempt (or they cited no evidence at all).
   * Never silently dropped — present (with `demotedReason` set) whenever a
   * demotion happened, on both the pass and the block outcome.
   */
  demotedFindings?: FreshEyesFinding[];
  /**
   * WS-B9: per-angle reviewer coverage for this attempt, when the reviewer
   * implementation reported it. A `required` angle other than `used`/`cached`
   * forces `errored: true` (see `computeRequiredCoverageMet` in
   * `review-coverage.ts`) — partial required coverage is never a clean pass.
   */
  coverage?: LoopReviewAngleCoverageEntry[];
}

export async function evaluateReviewDrivenCompletion(args: {
  state: LoopState;
  iteration: LoopIteration;
  fullOutput: string;
  stageMachine: LoopStageMachine;
  seq: number;
  stage: LoopStage;
  completionDetector: LoopCompletionDetector;
  /**
   * T30: route review-driven verifies through the coordinator's recorded
   * runner so this path lands in the verification ledger like the gated one.
   * Falls back to the raw detector when a caller does not supply it.
   */
  runRecordedVerify?: (kind: 'verify' | 'quick-verify') => Promise<VerifyOutcome>;
  /** L2: identical-tree replay port, owned by the verification run ledger. */
  verifyReplay?: LoopVerifyReplayPort<VerifyOutcome>;
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
  const reviewVerdict = shouldRunCleanReviewClassifier(
    fullOutput ?? '',
    cfg.noOutstandingPhrase,
    iteration.completionSignalsFired,
  )
    ? await classifyCleanReview({
      goal: state.config.initialPrompt,
      // The classifier is told where the work is, not where loop state lives.
      executionCwd: loopExecutionCwd(state.config),
      iterationOutput: fullOutput ?? '',
      config: cfg,
    })
    : UNCLEAR_CLEAN_REVIEW;

  let verifyOk = true;
  if (reviewVerdict.clean && noProductionChanges && cfg.verifyCommand?.trim()) {
    const runVerifyOfKind = args.runRecordedVerify
      ?? ((kind: 'verify' | 'quick-verify') => (kind === 'quick-verify'
        ? completionDetector.runQuickVerify(state.config, state.id)
        : completionDetector.runVerify(state.config, state.id)));
    const { final: v, verifyLabel } = await runLoopVerify({
      runQuickVerify: () => runVerifyOfKind('quick-verify'),
      runVerify: () => runVerifyOfKind('verify'),
      runVerifyTwice: cfg.runVerifyTwice === true,
      replay: args.verifyReplay,
    });
    applyVerifyOutcomeToIteration(iteration, v);
    if (v.status === 'failed') {
      verifyOk = false;
      state.pendingInterventions.push(
        createLoopPendingInput(
          verifyFailureIntervention(verifyLabel, v.output, v.failureKind),
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

/**
 * Fable WS6 Task 4: a blocking fresh-eyes verdict is a durable lesson. The
 * coordinator supplies this to distill the blocking findings into the lesson
 * store (fire-and-forget; must never affect the gate outcome).
 */
export interface ReviewVerdictForLesson {
  reviewers: string[];
  findings: { title: string; body: string; severity?: string; file?: string }[];
  summary: string;
}

export async function runFreshEyesReviewGate(args: {
  state: LoopState;
  signalId: string;
  iteration: LoopIteration;
  verifyOutput: string;
  reviewer: FreshEyesReviewer;
  emit: LoopEmit;
  setConvergenceNote: (note: string) => void;
  /** WS6 Task 4: capture a lesson from a blocking verdict (best-effort). */
  captureReviewLesson?: (verdict: ReviewVerdictForLesson) => void;
}): Promise<FreshEyesGateResult> {
  const { state, signalId, iteration, verifyOutput, reviewer, emit, setConvergenceNote, captureReviewLesson } = args;
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

  // When isolation is active the agent edits the worktree, not the repo root —
  // use the execution cwd so the reviewer sees the actual changes. Collected
  // BEFORE the instant-ALLOW check because that check is anchored to it, and
  // reused by the real review path below so a completion attempt never pays
  // for two `git diff` passes.
  const diffCwd = loopExecutionCwd(state.config);
  const workspaceDiff = collectWorkspaceDiff(diffCwd);
  // Deliberately NOT derived from `workspaceDiff`: that is the reviewer's
  // payload and is truncated to fit a prompt, so past its bounds an edit can
  // leave it byte-identical. The anchor reads its own unbounded git inputs.
  const workspaceDigest = workspaceAnchorDigest(diffCwd);

  // D6 (#7) part 3: instant ALLOW for non-edit turns. A clean cross-model
  // verdict is cached on state and reused by a later completion attempt that
  // did not change the tree, instead of paying for another multi-minute
  // review. A contradiction-forced review always runs for real.
  //
  // **Decision 15(b), 2026-09-07: this rule alone is un-gated.** It ran behind
  // `completion.antiSelfGrading` (default off), so it never fired and every
  // repeat "done" claim on an unchanged tree bought another review. Caveat
  // demotion, the verdict-discipline block and the stale-verify rung stay
  // behind the flag.
  //
  // **The reuse is anchored to the workspace, not to what we observed.** The
  // first version tested only `iteration.filesChanged`, which is the delta the
  // coordinator *saw* for this attempt — and a fresh-eyes gate pass found two
  // ways that under-reports. `createAttemptDeltaObserver` re-baselines per
  // attempt, so a write landing between two attempts (a concurrent agent, an
  // editor, a background job, an operator pause or provider-limit park lasting
  // hours) is absorbed into the next baseline and never appears; and a failed
  // git comparison returns `changes: []` with degraded coverage, which is
  // indistinguishable from "nothing happened". Either one turns an edit turn
  // into a free pass, and the un-gating is what made that reachable by default.
  //
  // So the flag alone is not sufficient authority. `freshEyesCleanWorkspaceDigest`
  // records the commit, `git diff HEAD --raw` (which carries every tracked
  // add/modify/delete/rename and the file modes), and the content of every
  // changed or untracked file at the moment the verdict was issued; reuse
  // requires an exact match. Porcelain status is deliberately NOT part of it —
  // see the anchor module for why. That covers what the observed delta misses — an
  // unobserved editor write, a between-attempt write, a degraded observation,
  // and work the agent committed. It sees what git reports for THIS repo and
  // no more: gitignored and skip-worktree paths, and the contents of a
  // submodule or nested repository, are outside it. See the anchor module for
  // the enumerated list — do not shorten this to "any change".
  // A workspace with no readable HEAD or status is unanchorable rather than
  // unchanged, yields a null digest, and never reuses.
  if (
    !forcedByContradiction
    && state.freshEyesCleanForWorkState === true
    // `!== null` is redundant against the equality below (a stored `undefined`
    // never equals `null`) and is kept only to guard a persisted null. The
    // equality is what actually fails a non-git workspace closed.
    && workspaceDigest !== null
    && state.freshEyesCleanWorkspaceDigest === workspaceDigest
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

  // WS3: the diff is reviewer egress — gate it here so EVERY reviewer
  // implementation (not just the default cross-model service, which gates
  // again idempotently) receives a redacted copy.
  const diffEgress = redactForEgress(workspaceDiff.diff, { kind: 'diff' });
  if (diffEgress.secretsFound) {
    logger.warn('Fresh-eyes review diff contained potential secrets — redacted before reviewer egress', {
      loopRunId: state.id,
      secretCount: diffEgress.secretCount,
    });
  }
  const iterationFiles = iteration.filesChanged.map((f) => f.path);
  const filesChangedThisIteration = iterationFiles.length > 0
    ? iterationFiles
    : workspaceDiff.changedFiles;

  // WS-A3: durably persist the exact material this review attempt is shown
  // (diff + verify excerpt) BEFORE dispatching the reviewer, so a later
  // evidence-anchor check proves a finding's quote against what was actually
  // reviewed, not a freshly-recomputed (and possibly different) workspace
  // diff. Keyed by a fresh id per attempt so a resumed/retried gate never
  // verifies a finding against a stale attempt's artifact.
  const reviewAttemptId = `fer_${randomUUID()}`;
  const verifyOutputExcerpt = excerptVerifyOutput(verifyOutput, 4096);
  persistReviewArtifact({
    state,
    iterationSeq: iteration.seq,
    reviewAttemptId,
    artifactType: 'diff',
    content: diffEgress.content,
  });
  persistReviewArtifact({
    state,
    iterationSeq: iteration.seq,
    reviewAttemptId,
    artifactType: 'output',
    content: verifyOutputExcerpt,
  });

  let reviewResult: FreshEyesReviewerResult;
  try {
    reviewResult = await reviewer({
      loopRunId: state.id,
      // The reviewer reads files and runs commands against the work product, so
      // it gets the same cwd the diff was collected from — matching ping-pong
      // (`loop-pingpong-completion.ts`). Passing the repo root here made the
      // local fresh-eyes reviewer inspect a different tree than it reviewed.
      workspaceCwd: diffCwd,
      goal: state.config.initialPrompt,
      // Without these the headless path cannot tell who built the work, and
      // used to assume Claude did — which barred Claude from checking a Codex
      // or Copilot build, and let Codex review its own work.
      builderProvider: state.config.provider,
      ...(iteration.model ? { builderModel: iteration.model } : {}),
      iterationOutput: iteration.outputExcerpt,
      diff: diffEgress.content,
      diffSource: workspaceDiff.source,
      filesChangedThisIteration,
      uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
      verifyOutputExcerpt,
      signal: signalId,
      terminalIntent: state.terminalIntentPending?.kind === 'complete'
        ? state.terminalIntentPending
        : undefined,
      config: effectiveCfg,
      // WS-B9: bind the per-angle cache to THIS run's LoopState.
      reviewAngleCache: buildReviewAngleCacheHook(state),
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

  const severityBlockingCandidates = reviewResult.findings.filter((finding) =>
    isBlockingFreshEyesFinding(finding, effectiveCfg.blockingSeverities),
  );
  // The classification below MUST check against what was actually persisted
  // (not `diffEgress.content` directly) — the stored copy is the bounded,
  // authoritative record of "the artifact for this review attempt".
  const diffArtifactContent = getReviewArtifact(state, reviewAttemptId, 'diff')?.content ?? '';
  const { blocking, demoted } = classifyFreshEyesBlocking(severityBlockingCandidates, diffArtifactContent);
  if (demoted.length > 0) {
    logger.info(
      'Fresh-eyes review: severity-blocking finding(s) demoted to advisory - evidence not verified',
      {
        loopRunId: state.id,
        signal: signalId,
        reviewAttemptId,
        demotedCount: demoted.length,
        reasons: demoted.map((f) => f.demotedReason),
      },
    );
  }

  // WS-B9: per-angle coverage for this attempt. Only present when the
  // reviewer implementation actually reports it (the default headless
  // reviewer always does when at least one angle was dispatched/reused; test
  // stubs and other implementations that don't opt in are treated as "not
  // applicable" — this can never newly BLOCK a pass that was already clean
  // under the pre-WS-B9 rules).
  const coverageAngles: LoopReviewAngleCoverageEntry[] = reviewResult.coverage ?? [];
  const requiredCoverageMet = computeRequiredCoverageMet(coverageAngles);
  if (coverageAngles.length > 0) {
    persistReviewCoverageReport(state, {
      reviewAttemptId,
      createdAt: Date.now(),
      angles: coverageAngles,
      requiredCoverageMet,
    });
  }

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
        ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}),
      });
      return { blocked: false, ran: true, errored: true, ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}) };
    }

    // WS-B9: at least one reviewer produced a verdict, but a REQUIRED angle
    // (dispatched or expected to be reused this attempt) ended
    // skipped/failed/parse_failed — partial required coverage is never a
    // clean pass. Follows the exact same fail-closed `errored` path as the
    // "zero reviewers" case above (see `evidence-resolver.ts`
    // `freshEyesErrored` — the main coordinator's completion authority
    // treats this as "no independently confirmed verdict", not silent
    // acceptance).
    if (!requiredCoverageMet) {
      const shortfall = coverageAngles
        .filter((a) => a.required && a.status !== 'used' && a.status !== 'cached')
        .map((a) => `${a.angle}:${a.status}`);
      logger.warn(
        'Fresh-eyes review: required reviewer/angle coverage was incomplete - treating as unavailable, not a clean pass',
        { loopRunId: state.id, signal: signalId, reviewAttemptId, shortfall },
      );
      emit('loop:fresh-eyes-review-failed', {
        loopRunId: state.id,
        signal: signalId,
        error: `required reviewer/angle coverage was incomplete this attempt (${shortfall.join(', ')})`,
        coverage: coverageAngles,
      });
      return { blocked: false, ran: true, errored: true, coverage: coverageAngles };
    }

    state.unresolvedReviewThreads = [];
    // D6 (#7) part 3: cache the clean verdict, anchored to the tree it was
    // issued against. A null digest (workspace cannot produce a diff) stores
    // nothing, so the reuse above can never match and this attempt's verdict
    // is simply not reusable — fail closed rather than guess.
    state.freshEyesCleanForWorkState = true;
    state.freshEyesCleanWorkspaceDigest = workspaceDigest ?? undefined;
    emit('loop:fresh-eyes-review-passed', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: reviewResult.reviewersUsed,
      nonBlockingFindings: reviewResult.findings.length,
      summary: reviewResult.summary,
      infrastructureError: reviewResult.infrastructureError,
      // WS-A3: never silently drop a demoted finding — it stays visible on
      // the pass event too, since demotion (not the review) is why nothing
      // blocked.
      demotedFindings: demoted,
      ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}),
    });
    logger.info('Fresh-eyes review passed', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: reviewResult.reviewersUsed,
      findings: reviewResult.findings.length,
      demoted: demoted.length,
    });
    return {
      blocked: false,
      ran: true,
      errored: false,
      ...(demoted.length > 0 ? { demotedFindings: demoted } : {}),
      ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}),
    };
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
  state.freshEyesCleanWorkspaceDigest = undefined;

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
    // WS-A3: never silently drop a demoted finding — a reader of this event
    // can see both what actually blocked and what almost did but wasn't
    // trusted enough to.
    demotedFindings: demoted,
    ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}),
  });
  logger.info('Fresh-eyes review blocked completion - injected interventions', {
    loopRunId: state.id,
    signal: signalId,
    blocking: ranked.length,
    severities: orderedSeverities,
    demoted: demoted.length,
  });
  // WS6 Task 4: a blocking cross-model verdict is a durable lesson — distill it
  // into the lesson store. Fire-and-forget: never let it affect the gate result.
  captureReviewLesson?.({
    reviewers: reviewResult.reviewersUsed,
    findings: dedupedFindings.map((f) => ({
      title: f.title,
      body: f.body,
      severity: f.severity,
      file: f.file,
    })),
    summary: reviewResult.summary,
  });
  return {
    blocked: true,
    ran: true,
    errored: false,
    blockingSeverities: orderedSeverities,
    ...(demoted.length > 0 ? { demotedFindings: demoted } : {}),
    ...(coverageAngles.length > 0 ? { coverage: coverageAngles } : {}),
  };
}
