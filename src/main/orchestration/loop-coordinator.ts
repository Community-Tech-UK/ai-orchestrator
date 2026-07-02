/**
 * Loop Coordinator
 *
 * Per-chat-session loop orchestration with structural progress detection,
 * verification-gated completion, and boundary-only child invocation through
 * `loop:invoke-iteration`. The coordinator never asks the agent whether it is
 * stuck; stuck/done decisions come from hashes, counters, files, and gates.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import {
  defaultCrossModelReviewConfig,
  type LoopConfig,
  type LoopFinalAuditResult,
  type LoopIteration,
  type LoopStage,
  type LoopState,
  type LoopStreamEvent,
  type CompletionSignalEvidence,
  type ProgressSignalEvidence,
  type LoopTerminalIntent,
  type NextObjectivePlanner,
  coercePendingInput,
  createLoopPendingInput,
  type LoopPendingInput,
  type LoopPendingInputKind,
  type LoopQueueDrainMode,
} from '../../shared/types/loop.types';
import {
  LoopCompletionDetector,
  CompletedFileWatcher,
  parseAgentMoreWorkRemaining,
} from './loop-completion-detector';
import { maybeQueueAnnounceThenHaltContinuation } from './loop-announce-then-halt';
import { wireLoopCompletionWatcher } from './loop-completion-watcher-runtime';
import { LoopProgressDetector } from './loop-progress-detector';
import { LoopStageMachine } from './loop-stage-machine';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import {
  saveLoopAttachments,
  cleanupLoopAttachments,
  renderAttachmentBlock,
  ensureLoopAttachmentsIgnored,
} from './loop-attachments';
import type { LoopAttachment } from '@contracts/schemas/loop';
import {
  buildLoopControlEnv,
  cleanupLoopControl,
  cloneIntentWithStatus,
  listArchivedImportedIntents,
  prepareLoopControl,
  publicLoopControlMetadata,
  summarizeLoopControlPrompt,
  writeLoopControlFile,
  type LoopControlRuntime,
} from './loop-control';
import { invokeLoopChildIteration } from './loop-child-invoker';
import { computeWorkHash } from './loop-work-hash';
import { detectConvergeUntilCleanIntent, detectLoopGoalIntent } from './loop-intent';
import {
  boundFullOutput,
  applyVerifyOutcomeToIteration,
  buildOperatorReviewPauseMessages,
  completedPlanWatchDirs,
  confirmLoopStablyStopped,
  excerpt,
  jaccard,
  selectedVerifyFailureKind,
  sleep,
  type VerifyOutcomeLike,
  verifyFailureIntervention,
} from './loop-coordinator-utils';
import { resolveCompletion, type EvidenceResolution } from './evidence-resolver';
import {
  captureAndPersistLoopRepoBaseline,
  effectiveLoopRepoCwd,
  ensureLoopRepoBaselineForRestore,
  runLoopFinalAudit,
  runLoopPreflight,
  writeLoopPreflightArtifact,
} from './loop-audit-runtime';
import { EvidenceStore } from './evidence-store';
import { summarizeVerifyOutput } from './verify-output-summarizer';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  defaultFreshEyesReviewer,
  type FreshEyesReviewer,
} from './loop-fresh-eyes-reviewer';
import {
  applySemanticProgressModifier,
  defaultSemanticProgressReviewer,
  type LoopSemanticProgressReviewer,
} from './loop-semantic-progress';
import {
  defaultCleanReviewClassifier,
  type LoopCleanReviewClassifier,
} from './loop-clean-review-classifier';
import { enforceReviewBackEdgeAction } from './loop-review-backedge';
import {
  buildEnvelopeRewrapCorrection,
  detectMalformedCompletionEnvelope,
} from './loop-envelope-rewrap';
import {
  defaultBranchSelector,
  type LoopBranchSelector,
} from './loop-branch-select';
import {
  defaultLoopMemoryStore,
  type LoopMemoryStore,
} from './loop-memory';
import { applyLoopContextSurvivalDecision, defaultLoopContextSurvivalManager, type LoopContextSurvivalManager } from './loop-context-survival';
import {
  classifyDegradedIteration as classifyDegradedIterationHelper,
  drainFollowUpsForCompletion,
  evaluatePostCompactionCanaryPause,
  getBlockOverrideInterventionText as getBlockOverrideInterventionTextHelper,
  isCircuitBreakerOpenError,
  isToolchainClassBlock as isToolchainClassBlockHelper,
  partitionPendingByDrainTiming,
  runWorkspaceLivenessProbe as runWorkspaceLivenessProbeHelper,
} from './loop-coordinator-block-utils';
import { defaultLoopExplorationConfig } from '../../shared/types/loop.types';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../shared/types/provider-quota.types';
import { isProviderNotice } from '../cli/provider-notice';
import { isParkingDecision } from './loop-quota-throttle';
import {
  COST_PER_M_TOKENS_CENTS,
  DEFAULT_ITERATION_TIMEOUT_MS,
  LOOP_BREAKER_OPEN_BACKOFF_MS,
  LOOP_MAX_BREAKER_OPEN_WAITS,
  type LoopAdapterCleanupHook,
  type LoopChildResult,
  type LoopIntentPersistHook,
  type LoopIterationHook,
  type LoopPreIterationHook,
  type LoopRuntimeContext,
  type PauseGate,
  type ProviderLimitResumeScheduler,
} from './loop-coordinator.types';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';
import { streamLoopEvents } from './loop-stream';
import {
  evaluateReviewDrivenCompletion as evaluateReviewDrivenCompletionGate,
  isReviewDrivenProductionChange,
  runFreshEyesReviewGate as runFreshEyesReviewGateHelper,
  trackRepeatedCompletionEvidence,
  type FreshEyesGateResult,
} from './loop-coordinator-completion-gates';
import {
  evaluatePingPongCompletion as evaluatePingPongCompletionGate,
  type PingPongTerminal,
} from './loop-pingpong-completion';
import { handleLoopFinalAuditBlockedCompletion, handleVerifiedNoChangeReviewDrivenCompletion } from './loop-final-audit-blocked-completion';
import { isVerifiedNoChangeCompletionClaim } from './loop-verified-completion-claim';
import type { PingPongReviewer } from './agentic-pingpong-reviewer';
import type { PingPongSubject } from '../../shared/types/loop-pingpong.types';
import {
  applyLoopPlanRegenerationOnStall,
  buildCapWrapUpDirective,
  captureLoopOutstanding,
  canRegenerateLoopPlanOnStall,
  checkLoopHardCaps,
  cloneLoopStateForBroadcast,
  describeLoopCapReason,
  materializeLoopConfig,
  moveBlockedFileAside as moveBlockedFileAsideHelper,
  preflightBlockedSignal,
  rememberLoopTerminalIntent,
  readBlockedFileIfPresent as readBlockedFileIfPresentHelper,
  reconcileRestoredLoopState,
  resourceGovernorPauseSignal,
  syntheticChildResultFromTerminalIntent as syntheticChildResultFromTerminalIntentHelper,
} from './loop-coordinator-state-helpers';
import {
  pauseForBlockIntentAction,
  scheduleWakeupIntent,
  type ScheduledWakeup,
} from './loop-terminal-intent-actions';
import {
  isActiveLoopRuntimeState,
  isParkedLoopRuntimeState,
  isStickyWaitingForInput,
  isTerminalLoopRuntimeState,
  isTerminalLoopRuntimeStatus,
} from './loop-runtime-status';
import { recordLoopLearningForState } from './loop-learning-recorder';
import {
  extractLedgerOpenCount,
  updateLedgerProgress,
  isLedgerStalled,
} from './loop-ledger-progress';
import { lintTaskLedger } from './loop-ledger-lint';
import { importTerminalIntentsForBoundary as importTerminalIntentsForBoundaryHelper } from './loop-terminal-intent-importer';
import type { LoopCheckpoint } from './loop-checkpoint';
import type { LongRunResourceDecision } from '../runtime/long-run-resource-governor';
import { createAuxiliaryNextObjectivePlanner } from './loop-next-objective-planner';
import { LoopPingPongReviewAbortRegistry } from './loop-pingpong-review-abort';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { routeClassifiedLoopInvocationFailure } from './loop-invocation-error-routing';
import { cleanupLoopWorktreeAfterTerminate } from './loop-worktree-termination-cleanup';
export { computeWorkHash } from './loop-work-hash';
export type {
  FreshEyesFinding,
  FreshEyesReviewer,
  FreshEyesReviewerInput,
  FreshEyesReviewerResult,
  FreshEyesSeverity,
} from './loop-fresh-eyes-reviewer';
export type {
  LoopAdapterCleanupHook,
  LoopChildInvocationCallbackResult,
  LoopChildInvocationError,
  LoopChildResult,
  LoopIntentPersistHook,
  LoopIterationHook,
  LoopRuntimeContext,
  ProviderLimitResumeScheduleRequest,
  ProviderLimitResumeScheduler,
} from './loop-coordinator.types';

const logger = getLogger('LoopCoordinator');
type LoopResourceGovernor = (state: LoopState) => LongRunResourceDecision | null;

export class LoopCoordinator extends EventEmitter {
  private static instance: LoopCoordinator | null = null;

  private active = new Map<string, LoopState>();
  private pauseGates = new Map<string, PauseGate>();
  private cancelFlags = new Map<string, boolean>();
  private histories = new Map<string, LoopIteration[]>();
  /**
   * Why the loop most recently *failed to converge* on a stop, keyed by
   * loopRunId. Set whenever a completion attempt is rejected (verify red,
   * unverifiable, rename gate unmet) or blocked (fresh-eyes review). Cleared
   * when a stop is accepted. Read when a hard cap fires so `cap-reached`
   * reports *why* it stopped (e.g. "while verify was failing") instead of a
   * bare `cap=iterations`. Held off-`LoopState` so no DB/schema column is
   * needed for a purely diagnostic, in-memory hint.
   */
  private convergenceNotes = new Map<string, string>();
  /**
   * LF-4: count of disposable-plan regenerations this stall streak, keyed by
   * loopRunId. Held off-`LoopState` (in-memory, like `convergenceNotes`) — it's
   * a transient control hint, not persisted run state. Bounded by
   * `LOOP_MAX_PLAN_REGENERATIONS`.
   */
  private planRegenerations = new Map<string, number>();
  /**
   * LF-4: loopRunIds whose next iteration should start in a fresh context
   * because the stage just transitioned PLAN→IMPLEMENT (RPI context reset).
   */
  private pendingContextReset = new Set<string>();
  private watchers = new Map<string, CompletedFileWatcher>();
  private restoredLoops = new Set<string>();
  private runtimeContexts = new Map<string, LoopRuntimeContext>();
  private loopControls = new Map<string, LoopControlRuntime>();
  private nextObjectivePlanners = new Map<string, NextObjectivePlanner>();
  private preIterationHooks: LoopPreIterationHook[] = [];
  private iterationHooks: LoopIterationHook[] = [];
  private intentPersistHook: LoopIntentPersistHook | null = null;
  private adapterCleanupHook: LoopAdapterCleanupHook | null = null;
  /**
   * In-flight terminal-cleanup promises, keyed by loopRunId. Populated
   * inside `terminate()` when an adapter-cleanup hook is registered;
   * `awaitTerminalCleanup` returns the matching promise so callers
   * (e.g. `cancelLoop`) can wait for full shutdown.
   */
  private terminalCleanupPromises = new Map<string, Promise<void>>();
  private resourceGovernor: LoopResourceGovernor | null = null;
  /**
   * P2: maps loopRunId → worktree session id. Populated when `isolateLoopWorkspaces`
   * is true, cleared in terminate(). Used for harvest+cleanup on terminal.
   */
  private worktreeSessionIds = new Map<string, string>();
  private pingPongReviewAborts = new LoopPingPongReviewAbortRegistry();

  private progressDetector = new LoopProgressDetector();
  private completionDetector = new LoopCompletionDetector();
  /**
   * Injectable cross-model fresh-eyes reviewer. Defaults to the production
   * implementation that calls `CrossModelReviewService.runHeadlessReview`,
   * but tests (and future alternate runners) can swap it out without
   * mocking the entire orchestration service.
   */
  private freshEyesReviewer: FreshEyesReviewer = defaultFreshEyesReviewer;

  /** Override the fresh-eyes reviewer (tests / DI). */
  setFreshEyesReviewer(reviewer: FreshEyesReviewer): void {
    this.freshEyesReviewer = reviewer;
  }

  /**
   * Ping-pong agentic reviewer. Undefined ⇒ the dedicated branch uses the real
   * `agenticPingPongReviewer`. Resolved per-run inside the branch (NOT a shared
   * mutable global), so concurrent ping-pong + normal loops can't corrupt each
   * other. Injectable for tests.
   */
  private pingPongReviewer: PingPongReviewer | undefined;

  /** Optional plan/impl subject resolver (P6 intent classifier). */
  private pingPongSubjectResolver:
    | ((state: LoopState, fullOutput: string) => Promise<PingPongSubject>)
    | undefined;

  /** Override the ping-pong reviewer (tests / DI). */
  setPingPongReviewerForTesting(reviewer: PingPongReviewer): void {
    this.pingPongReviewer = reviewer;
  }

  /** Inject the ping-pong subject (plan/impl) resolver. */
  setPingPongSubjectResolver(
    resolver: (state: LoopState, fullOutput: string) => Promise<PingPongSubject>,
  ): void {
    this.pingPongSubjectResolver = resolver;
  }

  /**
   * LF-2 — semantic-progress reviewer. Injectable like the fresh-eyes
   * reviewer; defaults to a cheap single-LLM-call implementation. Only invoked
   * when `LoopConfig.semanticProgress.enabled` is true.
   */
  private semanticProgressReviewer: LoopSemanticProgressReviewer = defaultSemanticProgressReviewer;

  /** Override the semantic-progress reviewer (tests / DI). */
  setSemanticProgressReviewer(reviewer: LoopSemanticProgressReviewer): void {
    this.semanticProgressReviewer = reviewer;
  }

  /**
   * Review-driven completion classifier. It judges the child's review message
   * semantically ("no actionable issues remain") instead of requiring one
   * exact magic phrase.
   */
  private cleanReviewClassifier: LoopCleanReviewClassifier = defaultCleanReviewClassifier;

  /** Override the clean-review classifier (tests / DI). */
  setCleanReviewClassifier(classifier: LoopCleanReviewClassifier): void {
    this.cleanReviewClassifier = classifier;
  }

  /**
   * LF-5 — branch-and-select selector. Injectable like the reviewers; the
   * default degrades to a normal pause unless the host wires a runtime fan-out.
   * Only invoked when `LoopConfig.exploration.enabled` and a cost cap is set.
   */
  private branchSelector: LoopBranchSelector = defaultBranchSelector;

  /** Override the branch-and-select selector (tests / runtime wiring). */
  setBranchSelector(selector: LoopBranchSelector): void {
    this.branchSelector = selector;
  }

  /**
   * LF-6 — cross-loop memory store. Distilled learnings are written on
   * terminal/CRITICAL and surfaced into the next run's prompt. Injectable so
   * tests use a stub and the host can wire durable persistence.
   */
  private loopMemoryStore: LoopMemoryStore = defaultLoopMemoryStore;

  /** Override the cross-loop memory store (tests / durable persistence). */
  setLoopMemoryStore(store: LoopMemoryStore): void {
    this.loopMemoryStore = store;
  }

  private contextSurvivalManager: LoopContextSurvivalManager | null = defaultLoopContextSurvivalManager;
  setContextSurvivalManager(manager: LoopContextSurvivalManager | null): void { this.contextSurvivalManager = manager; }
  setResourceGovernor(governor: LoopResourceGovernor | null): void { this.resourceGovernor = governor; }

  /**
   * Usage-aware throttling: supplies the latest quota snapshot for a provider
   * so the pre-iteration pre-flight can park the loop *before* it spills into
   * paid overage. Defaults to "no data" (always returns null ⇒ no throttling),
   * so the behaviour is a clean no-op unless the host wires the real
   * `ProviderQuotaService`. Injectable for tests.
   */
  private providerLimitHandler = new LoopProviderLimitHandler({
    emit: (eventName, payload) => this.emit(eventName, payload),
    cloneStateForBroadcast: (state) => this.cloneStateForBroadcast(state),
    setConvergenceNote: (loopRunId, reason) => this.convergenceNotes.set(loopRunId, reason),
    terminate: (state, status, reason) => this.terminate(state, status, reason),
    resumeLoop: (loopRunId) => this.resumeLoop(loopRunId),
  });

  /** Current model downshift override, keyed by loopRunId. */
  private downshiftModelByLoop = new Map<string, string>();
  /** D2 (#6 interim): loops that already ran their single cap wrap-up iteration. */
  private capWrapUpRuns = new Map<string, 'iterations' | 'wall-time' | 'tokens' | 'cost'>();
  /** D4 (#28): per-run count of malformed-envelope corrections issued. */
  private envelopeRewraps = new Map<string, number>();
  private scheduledWakeups = new Map<string, ScheduledWakeup>();

  /** Override the quota snapshot source (production wiring / tests). */
  setQuotaSnapshotProvider(fn: (provider: ProviderId) => ProviderQuotaSnapshot | null): void {
    this.providerLimitHandler.setQuotaSnapshotProvider(fn);
  }

  /** Override active quota refresh used after provider-limit notices. */
  setQuotaSnapshotRefresher(fn: ((provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>) | null): void {
    this.providerLimitHandler.setQuotaSnapshotRefresher(fn);
  }

  /** Opt into riding paid overage credits (decision #3 alternative). */
  setAllowOverage(allow: boolean): void {
    this.providerLimitHandler.setAllowOverage(allow);
  }

  /** Override provider-limit resume scheduling (production automation wiring / tests). */
  setProviderLimitResumeScheduler(scheduler: ProviderLimitResumeScheduler | null): void {
    this.providerLimitHandler.setProviderLimitResumeScheduler(scheduler);
  }

  /**
   * A4 — durable evidence journal. Records the distinct authority states
   * (`verified` / `reviewed` / `fixed`) gathered at the completion-decision
   * seam so completion evidence survives a restart and so a later attempt can
   * detect a contradiction (e.g. verify regressing after a previous pass).
   *
   * Injectable for tests; lazily bound to the RLM database on first use in
   * production. `null` (the unbound default) means "evidence journalling is a
   * no-op" — the loop must never break because the journal is unavailable.
   */
  private evidenceStore: EvidenceStore | null = null;
  /** True once we've attempted the lazy production bind (so we only try once). */
  private evidenceStoreResolved = false;

  /** Override the evidence store (tests / durable persistence). */
  setEvidenceStore(store: EvidenceStore | null): void {
    this.evidenceStore = store;
    this.evidenceStoreResolved = true;
  }

  /**
   * Resolve the evidence store fail-soft. Returns the injected store if set;
   * otherwise lazily binds to the RLM database, but only once it is
   * initialised. If the database isn't ready (e.g. a unit test that never
   * stood up RLM), returns `null` and journalling is skipped silently.
   */
  private resolveEvidenceStore(): EvidenceStore | null {
    if (this.evidenceStore) return this.evidenceStore;
    if (this.evidenceStoreResolved) return null;
    this.evidenceStoreResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) return null;
      this.evidenceStore = EvidenceStore.getInstance(rlm.getDb());
      return this.evidenceStore;
    } catch (err) {
      logger.warn('LoopCoordinator: evidence store unavailable (journalling disabled)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * A4 — persist the authority evidence gathered at a completion attempt and
   * detect contradictions against previously-persisted evidence.
   *
   * Records the three resolver authority states distinctly:
   *   - `verified` when the verify command passed this attempt.
   *   - `reviewed` when the fresh-eyes cross-model review ran clean.
   * (`fixed` is written separately by the operator-acceptance flow.)
   *
   * Contradiction: if verify FAILS this attempt but a `verified` record
   * already exists for the same target, the work regressed something it had
   * passing — surface a convergence note so the operator/agent sees it.
   *
   * Fail-soft throughout: a journal failure must never break the loop.
   */
  private recordCompletionEvidence(
    state: LoopState,
    candidate: CompletionSignalEvidence,
    ev: {
      verifyPassed: boolean;
      freshEyesRan: boolean;
      freshEyesBlockingCount: number;
      freshEyesErrored: boolean;
      resolution: EvidenceResolution;
    },
  ): void {
    const store = this.resolveEvidenceStore();
    if (!store) return;
    const loopId = state.id;
    const target = candidate.id;

    // Contradiction: verify regressed after a prior pass for this target.
    if (ev.resolution.outcome === 'verify-failed') {
      const priorVerified = store.getForTarget(loopId, target, 'verified');
      if (priorVerified.length > 0) {
        const note =
          `verify regressed after ${priorVerified.length} previous pass(es) — ` +
          'the work broke something that was passing before';
        const existing = this.convergenceNotes.get(loopId);
        this.convergenceNotes.set(loopId, existing ? `${existing}; ${note}` : note);
        // A4: schedule a forced fresh-eyes pass on the next completion attempt
        // so a second opinion evaluates the workspace before accepting again.
        state.freshEyesForcedByContradiction = true;
        logger.info('Loop verify regressed after a prior pass — forcing fresh-eyes on next attempt', {
          loopRunId: loopId,
          target,
          priorPasses: priorVerified.length,
        });
      }
      return; // nothing positive to persist on a failed verify
    }

    if (ev.verifyPassed) {
      store.record({
        loopId,
        target,
        kind: 'verify-passed',
        state: 'verified',
        sourceMetadata: { signalId: candidate.id, attempt: state.completionAttempts },
      });
    }
    if (ev.freshEyesRan && ev.freshEyesBlockingCount === 0 && !ev.freshEyesErrored) {
      store.record({
        loopId,
        target,
        kind: 'fresh-eyes-clean',
        state: 'reviewed',
        sourceMetadata: { signalId: candidate.id, verifyPassed: ev.verifyPassed },
      });
    }
  }

  static getInstance(): LoopCoordinator {
    if (!this.instance) this.instance = new LoopCoordinator();
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      // best-effort cleanup of any active watchers — tests should already have
      // stopped loops, but guard against leaks.
      for (const w of this.instance.watchers.values()) {
        void w.stop();
      }
      this.instance.active.clear();
      this.instance.pauseGates.clear();
      this.instance.cancelFlags.clear();
      this.instance.histories.clear();
      this.instance.convergenceNotes.clear();
      this.instance.planRegenerations.clear();
      this.instance.pendingContextReset.clear();
      this.instance.watchers.clear();
      this.instance.restoredLoops.clear();
      this.instance.runtimeContexts.clear();
      this.instance.loopControls.clear();
      this.instance.nextObjectivePlanners.clear();
      this.instance.preIterationHooks = [];
      this.instance.iterationHooks = [];
      this.instance.intentPersistHook = null;
      this.instance.adapterCleanupHook = null;
      this.instance.terminalCleanupPromises.clear();
      this.instance.pingPongReviewAborts.abortAll('test reset');
      this.instance.pingPongReviewAborts.clear();
      this.instance.contextSurvivalManager = defaultLoopContextSurvivalManager;
      this.instance.scheduledWakeups.clear();
      this.instance.evidenceStore = null;
      this.instance.evidenceStoreResolved = false;
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  /**
   * Register a pre-iteration hook. Hooks run after the next iteration's
   * idempotency marker is installed on state and before the child provider is
   * invoked. Unlike post-iteration hooks, failures are load-bearing: throwing
   * aborts the spawn so a loop does not begin paid work without a durable
   * pre-iteration checkpoint.
   */
  registerPreIterationHook(hook: LoopPreIterationHook): () => void {
    this.preIterationHooks.push(hook);
    return () => {
      const i = this.preIterationHooks.indexOf(hook);
      if (i >= 0) this.preIterationHooks.splice(i, 1);
    };
  }

  /**
   * Register a post-iteration hook. Hooks run after the iteration is sealed
   * but before the iteration-complete event fires. Errors are logged but do
   * not abort the loop.
   */
  registerIterationHook(hook: LoopIterationHook): () => void {
    this.iterationHooks.push(hook);
    return () => {
      const i = this.iterationHooks.indexOf(hook);
      if (i >= 0) this.iterationHooks.splice(i, 1);
    };
  }

  /**
   * Install a hook the coordinator awaits before archiving an imported
   * intent file. Called once for each intent the coordinator adds to
   * `state.terminalIntentHistory` during a boundary import (winner +
   * any superseded peers). Returning normally indicates durable
   * persistence; throwing leaves the source file in `intents/` so the
   * next boundary will re-import. There is one hook per coordinator;
   * the most recent registration wins.
   */
  setIntentPersistHook(hook: LoopIntentPersistHook | null): void {
    this.intentPersistHook = hook;
  }

  /**
   * Register the per-loop adapter teardown hook (FU-8). The default
   * invoker installs this so the coordinator can await CLI child
   * termination before reporting a cancellation/completion as fully
   * done, avoiding orphaned children.
   */
  setAdapterCleanupHook(hook: LoopAdapterCleanupHook | null): void {
    this.adapterCleanupHook = hook;
  }

  /**
   * Return the in-flight adapter-cleanup promise for a loop, or a
   * resolved promise if there's nothing to wait for. Used by
   * `cancelLoop` and external callers (graceful app shutdown) that
   * need to wait until child processes are torn down.
   */
  awaitTerminalCleanup(loopRunId: string): Promise<void> {
    return this.terminalCleanupPromises.get(loopRunId) ?? Promise.resolve();
  }

  /**
   * Reconcile any intent files left in `<controlDir>/imported/` that
   * are not already persisted in the caller's durable store. The caller
   * passes the set of intent ids it already knows about (typically the
   * result of `LoopStore.listTerminalIntents(loopRunId)`); the
   * coordinator returns the orphan intents, runs the configured
   * `intentPersistHook` on each, and leaves the file in `imported/`.
   *
   * Designed to be called at boot — once `prepareLoopControl` has
   * recreated the loop runtime — to close the residual crash window
   * where the DB transaction committed but the source-file rename had
   * not yet completed. Safe to call multiple times (no-op when no
   * orphans exist).
   */
  async reconcileImportedOrphans(
    loopRunId: string,
    persistedIntentIds: ReadonlySet<string>,
  ): Promise<LoopTerminalIntent[]> {
    const loopControl = this.loopControls.get(loopRunId);
    if (!loopControl) return [];
    const onDisk = await listArchivedImportedIntents(loopControl);
    const orphans = onDisk.filter((intent) => !persistedIntentIds.has(intent.id));
    if (orphans.length === 0) return [];
    const persistHook = this.intentPersistHook;
    if (!persistHook) {
      logger.warn('reconcileImportedOrphans: no persist hook registered; orphans cannot be recovered', {
        loopRunId,
        orphanCount: orphans.length,
      });
      return orphans;
    }
    const persisted: LoopTerminalIntent[] = [];
    for (const intent of orphans) {
      try {
        await persistHook(intent);
        persisted.push(intent);
      } catch (err) {
        logger.warn('reconcileImportedOrphans: persist hook failed for orphan', {
          loopRunId,
          intentId: intent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (persisted.length > 0) {
      logger.info('Reconciled imported intent orphans on boot', {
        loopRunId,
        recovered: persisted.length,
        totalOnDisk: onDisk.length,
      });
    }
    return persisted;
  }

  // ============ Public API ============

  /**
   * Start a loop for the given chat. Caller is responsible for persisting
   * the returned `LoopState` (e.g. via LoopStore) — the coordinator only
   * holds it in memory.
   */
  async startLoop(
    chatId: string,
    partialConfig: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
    attachments?: LoopAttachment[],
    runtimeContext?: LoopRuntimeContext,
  ): Promise<LoopState> {
    // Remember whether the caller explicitly configured belt-and-braces.
    // `materializeConfig` collapses `undefined` into a concrete boolean so
    // this is our only chance to distinguish "default off" from
    // "user said off".  Used after the startup snapshot to auto-enable the
    // rename gate when uncompleted plan files are found in the workspace.
    const userExplicitlySetCompletedRename =
      partialConfig.completion?.requireCompletedFileRename !== undefined;
    // Likewise for the fresh-eyes cross-model review gate: distinguish
    // "caller said nothing" (eligible for intent-based auto-enable) from
    // "caller explicitly chose on/off" (their choice always wins).
    const userExplicitlySetCrossModelReview =
      partialConfig.completion?.crossModelReview !== undefined;
    const { nextObjectivePlanner, ...serializablePartialConfig } = partialConfig;
    const config = materializeLoopConfig(serializablePartialConfig);
    if (!config.initialPrompt.trim()) throw new Error('initialPrompt is required');
    if (!config.workspaceCwd.trim()) throw new Error('workspaceCwd is required');

    // Derive the goal intent (implementation vs investigation/audit) when the
    // caller didn't set it explicitly. An investigation loop ANSWERS the goal
    // and writes a REPORT.md instead of editing production code — so this gates
    // the per-iteration prompt (answer/report, not implement), suppresses the
    // plan-file rename gate (we're auditing those files, not finishing them),
    // and adds a report-required completion check. An explicit caller value
    // always wins. Conservative: implementation is the safe default and wins on
    // ambiguity, so a real implement goal is never mistaken for a question.
    // Classify the GOAL only (config.initialPrompt) — never the iteration
    // directive, which defaults to a generic "continue… update… rename"
    // boilerplate that would mask an audit goal as implementation.
    if (partialConfig.goalIntent === undefined) {
      const goalIntent = detectLoopGoalIntent(config.initialPrompt);
      config.goalIntent = goalIntent.intent;
      if (goalIntent.intent === 'investigation') {
        logger.info(
          'Loop start: detected investigation goal — answer/report mode (no production edits)',
          { workspaceCwd: config.workspaceCwd, reason: goalIntent.reason },
        );
      }
    }
    const isInvestigation = config.goalIntent === 'investigation';
    // An investigation/audit must never be pushed to rename the very plan/
    // backlog files it is auditing. `materializeConfig` auto-enables the rename
    // gate whenever a `planFile` is set, so explicitly clear it here (unless the
    // caller pinned it) — the `uncompletedPlanFilesAtStart` auto-enable below is
    // separately guarded by `!isInvestigation`.
    if (isInvestigation && !userExplicitlySetCompletedRename) {
      config.completion.requireCompletedFileRename = false;
    }

    // FU-2: a loop with no `verifyCommand` cannot auto-complete — every
    // completion attempt is "skipped" by verify and the coordinator pauses
    // the loop for operator review. The runtime behaviour already handles
    // this gracefully, but the agent doesn't learn about it until the
    // first completion attempt is rejected, which wastes an iteration.
    // We mark this state up front (`manualReviewOnly`) so the prompt
    // builder can tell the agent upfront and the UI can label the run.
    const manualReviewOnly = !config.completion.verifyCommand.trim();
    if (manualReviewOnly) {
      logger.info('Loop start: no verifyCommand — loop is manual-review-only', { workspaceCwd: config.workspaceCwd });
    }

    // Enforce one-active-loop-per-chat. Without this, double-start races
    // (Send + Enter, Enter + Enter) can spawn duplicate runs in the same
    // workspace — they'd fight over STAGE.md, NOTES.md, and the plan file.
    for (const existing of this.active.values()) {
      if (existing.chatId !== chatId) continue;
      if (isActiveLoopRuntimeState(existing)) {
        throw new Error(
          `A loop is already ${existing.status} for this chat (id ${existing.id}). ` +
          'Cancel it before starting a new one.',
        );
      }
    }

    // Refuse a second concurrent loop driving the SAME plan file in the same
    // workspace (even from a different chat). The loop-owned state files are now
    // per-run isolated and the completed-rename signal is matched to each loop's
    // OWN plan, so loops on DISTINCT plans (or no-plan loops) coexist safely —
    // but two loops sharing one plan file would both watch it and both complete
    // on its single `_completed` rename, which is inherently ambiguous.
    if (config.planFile) {
      const thisPlan = path.resolve(config.workspaceCwd, config.planFile);
      for (const existing of this.active.values()) {
        if (!isActiveLoopRuntimeState(existing)) continue;
        if (!existing.config.planFile) continue;
        const otherPlan = path.resolve(existing.config.workspaceCwd, existing.config.planFile);
        if (otherPlan === thisPlan) {
          throw new Error(
            `Another loop (id ${existing.id}) is already ${existing.status} on the same plan file ` +
            `(${config.planFile}) in this workspace. Concurrent loops on one plan file collide on its ` +
            'completion rename — cancel the other loop or point this one at a separate plan file.',
          );
        }
      }
    }

    const id = `loop-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const runtimeNextObjectivePlanner = nextObjectivePlanner
      ?? (config.nextObjectivePlanning?.enabled ? createAuxiliaryNextObjectivePlanner() : undefined);

    // P2: Acquire a per-session worktree when isolation is requested.
    // The worktree path becomes executionCwd (CLI spawn dir); workspaceCwd
    // stays the repo root so durable state is never reaped with the worktree.
    if (config.isolateLoopWorkspaces && !config.executionCwd) {
      try {
        const worktreeManager = getWorktreeManager();
        const worktreeSession = await worktreeManager.createWorktree(
          id,
          config.initialPrompt.slice(0, 60),
          { repoRoot: config.workspaceCwd, skipInstall: true, taskType: 'feature' },
        );
        config.executionCwd = worktreeSession.worktreePath;
        // P3: also store branch name so upsertRun can persist it to branch_name column.
        config.worktreeBranch = worktreeSession.branchName;
        this.worktreeSessionIds.set(id, worktreeSession.id);
        logger.info('Loop start: acquired worktree', {
          loopRunId: id,
          worktreePath: worktreeSession.worktreePath,
          branch: worktreeSession.branchName,
        });
      } catch (err) {
        // Decision D (fail-closed): isolation was requested — a silent fallback
        // to the shared root would recreate the exact collision/data-loss class
        // isolation is meant to prevent, but invisibly. Surface a block instead.
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Loop start: failed to acquire worktree — blocking loop (isolation required, fail-closed)', err instanceof Error ? err : new Error(errorMsg), { loopRunId: id });
        // Write a root BLOCKED.md so the operator can diagnose the failure.
        try {
          const { writeFile: wf } = await import('node:fs/promises');
          await wf(
            path.join(config.workspaceCwd, 'BLOCKED.md'),
            `# Worktree Acquisition Failed\n\nLoop start aborted: could not acquire an isolated worktree.\n\nError: ${errorMsg}\n\nResolve the issue (check \`.worktrees/\`, disk space, and git status) and restart the loop.\n`,
          );
        } catch {
          // best-effort — don't mask the original error
        }
        throw new Error(`isolateLoopWorkspaces: worktree acquisition failed — ${errorMsg}`);
      }
    }

    const loopControl = await prepareLoopControl(
      config.workspaceCwd,
      id,
      [...this.active.keys(), id],
    );

    // Persist attachments to the workspace and prepend their paths to BOTH
    // prompts so every iteration (not just iter 0) sees the file references.
    // Each iteration is a fresh CLI process — without this, iter 1+ has no
    // way to know the attachments exist.
    if (attachments && attachments.length > 0) {
      const saved = await saveLoopAttachments(config.workspaceCwd, id, attachments);
      const block = renderAttachmentBlock(saved);
      if (block) {
        config.initialPrompt = `${block}\n\n${config.initialPrompt}`;
        if (config.iterationPrompt) {
          config.iterationPrompt = `${block}\n\n${config.iterationPrompt}`;
        }
      }
      // Best-effort gitignore so attachments aren't accidentally committed.
      void ensureLoopAttachmentsIgnored(config.workspaceCwd);
    }
    const watcher = new CompletedFileWatcher(
      config.workspaceCwd,
      config.completion.completedFilenamePattern,
      completedPlanWatchDirs(config),
    );
    watcher.start();
    // Log pre-existing matches for observability, but do NOT treat them as
    // evidence of completion. The completion semantic we care about is "the
    // rename happened during *this* run" — anything that pre-existed is noise
    // (typical workspaces accumulate `*_completed.md` plan files over time
    // and would otherwise instantly false-positive iteration 0). The chokidar
    // watcher uses `ignoreInitial: true`, so genuine in-run renames will fire
    // an `add` event and flip state.completedFileRenameObserved correctly.
    const existing = watcher.scanOnce();
    if (existing) {
      logger.info(
        'Loop start: pre-existing *_Completed.md present in workspace — ignored (only in-run renames count)',
        { id, file: existing },
      );
    }

    const stageMachine = new LoopStageMachine(config.workspaceCwd, id);
    const initialStage = await stageMachine.bootstrap(config);
    const repoBaseline = await captureAndPersistLoopRepoBaseline(
      effectiveLoopRepoCwd(config),
      id,
      stageMachine.paths.repoBaseline,
    );

    // Snapshot the workspace's "starting state" so completion signals can
    // distinguish in-run progress from stale artefacts left over from prior
    // runs. Captured after bootstrap so it reflects post-cleanup state
    // (bootstrap unlinks any lingering `DONE.txt`). The snapshot lives on
    // `LoopState` and is the only baseline the detector consults — it never
    // re-measures.
    const snapshot = await stageMachine.captureStartupSnapshot(config);
    if (snapshot.doneSentinelPresent) {
      logger.warn(
        'Loop start: done-sentinel survived bootstrap unlink — ignored (only in-run creation counts)',
        { id, sentinel: config.completion.doneSentinelFile },
      );
    }
    if (snapshot.planChecklistFullyChecked) {
      logger.info(
        'Loop start: planFile already fully checked — ignored (only an in-run transition counts)',
        { id, planFile: config.planFile },
      );
    }
    // Auto-enable belt-and-braces when the workspace contains uncompleted
    // plan-like markdown files at start and the caller did not explicitly
    // pin `requireCompletedFileRename`. Without this, a DONE.txt sentinel
    // alone can terminate the loop even when the prompt asked the agent to
    // rename plan files with `_completed` — the default prompt promises
    // "rename it with _completed before stopping" and this gate enforces
    // that contract on the loop side.
    if (
      !isInvestigation &&
      !userExplicitlySetCompletedRename &&
      !config.completion.requireCompletedFileRename &&
      snapshot.uncompletedPlanFilesAtStart.length > 0
    ) {
      config.completion.requireCompletedFileRename = true;
      logger.info(
        'Loop start: auto-enabled requireCompletedFileRename — uncompleted plan files present',
        { id, count: snapshot.uncompletedPlanFilesAtStart.length, files: snapshot.uncompletedPlanFilesAtStart.slice(0, 8) },
      );
    }
    // Fresh-eyes cross-model review is normally opt-in (a reviewer that
    // disagrees about style shouldn't block valid completions for hours).
    // The exception is the "converge until clean" intent — e.g. "keep
    // reviewing with fresh eyes and fix any issues until there are no
    // issues." That intent's whole point is that completion must be
    // confirmed by an *independent* reviewer, not the agent's own say-so,
    // so we auto-enable the gate when the caller didn't configure it
    // explicitly. An explicit `{ enabled: false }` (or `true`) always wins.
    if (!userExplicitlySetCrossModelReview && !config.completion.crossModelReview) {
      const intent = detectConvergeUntilCleanIntent(config.initialPrompt, config.iterationPrompt);
      if (intent.matched) {
        config.completion.crossModelReview = defaultCrossModelReviewConfig();
        logger.info(
          'Loop start: auto-enabled fresh-eyes cross-model review — converge-until-clean intent detected',
          { id, reason: intent.reason },
        );
      }
    }

    const state: LoopState = {
      id,
      chatId,
      config,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      totalIterations: 0,
      totalTokens: 0,
      totalCostCents: 0,
      currentStage: initialStage,
      repoBaseline,
      pendingInterventions: [],
      loopControl: publicLoopControlMetadata(loopControl),
      terminalIntentHistory: [],
      // Always start false — see scan note above. Only in-run rename events
      // flip this to true (via watcher.onCompleted below).
      completedFileRenameObserved: false,
      doneSentinelPresentAtStart: snapshot.doneSentinelPresent,
      planChecklistFullyCheckedAtStart: snapshot.planChecklistFullyChecked,
      uncompletedPlanFilesAtStart: snapshot.uncompletedPlanFilesAtStart,
      loopTasksLedgerResolvedAtStart: snapshot.loopTasksLedgerResolvedAtStart,
      manualReviewOnly,
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
      completionAttempts: 0,
      announceThenHaltNudgeCount: 0,
      unresolvedReviewThreads: [],
      recentEvidenceHashes: [],
      repeatedEvidenceCount: 0,
      consecutiveCleanReviewPasses: 0,
    };
    if (runtimeNextObjectivePlanner) {
      this.nextObjectivePlanners.set(id, runtimeNextObjectivePlanner);
    }
    this.active.set(id, state);
    this.histories.set(id, []);
    this.watchers.set(id, watcher);
    this.loopControls.set(id, loopControl);
    this.cancelFlags.set(id, false);
    // LF-6: surface prior-run learnings for this workspace (best-effort,
    // token-bounded). Injected into each iteration prompt as non-binding
    // "prior observations".
    let priorObservations: string[] | undefined;
    try {
      const surfaced = await this.loopMemoryStore.surfaceLearnings(config.workspaceCwd, 3);
      if (surfaced.length > 0) {
        priorObservations = surfaced;
        logger.info('Loop start: surfaced prior-run observations', { id, count: surfaced.length });
      }
    } catch (err) {
      logger.warn('Loop start: surfacing prior observations failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const existingSessionContext = runtimeContext?.existingSessionContext?.trim() || undefined;
    if (existingSessionContext || priorObservations) {
      this.runtimeContexts.set(id, { existingSessionContext, priorObservations });
    }

    wireLoopCompletionWatcher(watcher, state, (eventName, payload) => this.emit(eventName, payload));

    this.emit('loop:started', { loopRunId: id, chatId });
    this.emit('loop:state-changed', { loopRunId: id, state: this.cloneStateForBroadcast(state) });

    // Start-time ledger lint: warn when LOOP_TASKS.md has structurally
    // unclosable OPEN items (open-ended "continue remaining…" buckets or
    // hardware/manual-gated items) that the completion gate can never clear.
    // Advisory only — surfaced to the operator and (via the event) the UI so the
    // ledger can be split into finite slices / deferred before it spins to a cap.
    try {
      const lintFindings = lintTaskLedger(await stageMachine.readTaskLedger());
      if (lintFindings.length > 0) {
        logger.warn('Loop start: ledger has structurally unclosable open items', {
          loopRunId: id,
          findings: lintFindings.map((f) => `[${f.category}] ${f.item}`),
        });
        this.emit('loop:ledger-lint', { loopRunId: id, findings: lintFindings });
      }
    } catch {
      // Ledger unreadable / absent — lint inactive, no effect.
    }

    // Run the loop in the background. Errors propagate via 'loop:error'.
    void this.runLoop(state, stageMachine).catch((err) => {
      logger.error('Loop runtime error', err instanceof Error ? err : new Error(String(err)), { loopRunId: id });
      this.terminate(state, 'error', err instanceof Error ? err.message : String(err));
    });

    return state;
  }

  async restoreLoopFromCheckpoint(checkpoint: LoopCheckpoint): Promise<LoopState> {
    const state = checkpoint.state;
    const existing = this.active.get(state.id);
    if (existing) {
      return existing;
    }
    state.config = materializeLoopConfig(state.config);
    // Crash-restore reconciliation (ping-pong in-flight drop, running→paused,
    // D6 fresh-eyes cache clear) — see reconcileRestoredLoopState for the rules.
    const reconciliationNotes = reconcileRestoredLoopState(state);
    for (const note of reconciliationNotes) {
      logger.info(`Loop restore: ${note}`, { id: state.id });
    }
    if (state.status === 'provider-limit' && state.endedAt != null) {
      throw new Error('Cannot restore terminal provider-limit loop checkpoint');
    }
    state.pendingInterventions = (state.pendingInterventions as (string | LoopPendingInput)[])
      .map((item) => coercePendingInput(item));
    state.repoBaseline = await ensureLoopRepoBaselineForRestore(state);
    if (state.status !== 'paused' && state.status !== 'provider-limit') {
      throw new Error(`Cannot restore non-paused loop checkpoint: ${state.status}`);
    }

    // Decision D (fail-closed): when isolation is required, a missing worktree
    // must surface a block — silently falling back to workspaceCwd recreates the
    // exact collision/data-loss class isolation is meant to prevent.
    if (state.config.isolateLoopWorkspaces) {
      const missingCwd = !state.config.executionCwd
        || state.config.executionCwd === state.config.workspaceCwd;
      let pathMissing = false;
      if (!missingCwd) {
        try {
          const { stat } = await import('fs/promises');
          await stat(state.config.executionCwd!);
        } catch {
          pathMissing = true;
        }
      }
      if (missingCwd || pathMissing) {
        const missingPath = state.config.executionCwd ?? '(not set)';
        logger.error('Loop restore: worktree missing/unset — blocking loop (isolation required, fail-closed)', undefined, { id: state.id, missingPath });
        const paths = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id);
        try {
          const { mkdir: mkd, writeFile: wf } = await import('node:fs/promises');
          await mkd(paths.dir, { recursive: true });
          await wf(
            paths.blocked,
            `# Worktree Missing on Restore\n\nLoop restore aborted: the isolated worktree no longer exists.\n\nMissing path: ${missingPath}\n\nResolve by cleaning up the loop or creating a replacement worktree, then restart.\n`,
          );
        } catch {
          // best-effort
        }
        throw new Error(`isolateLoopWorkspaces: worktree missing on restore (fail-closed) — ${missingPath}`);
      }
      // Worktree exists — re-register it with WorktreeManager so the normal
      // terminate path (harvestWorktree + cleanupWorktree) works correctly.
      // Without this the in-memory worktreeSessionIds map is empty for restored
      // loops and the terminate path silently skips cleanup.
      if (!this.worktreeSessionIds.has(state.id)) {
        try {
          const worktreeManager = getWorktreeManager();
          const adopted = await worktreeManager.adoptWorktree(
            state.id,
            state.config.executionCwd!,
            state.config.initialPrompt.slice(0, 60),
          );
          this.worktreeSessionIds.set(state.id, adopted.id);
          logger.info('Loop restore: re-registered existing worktree', {
            id: state.id,
            worktreePath: state.config.executionCwd,
            sessionId: adopted.id,
          });
        } catch (err) {
          logger.warn('Loop restore: failed to re-register worktree — cleanup deferred to next-boot reconcile', {
            id: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (state.config.executionCwd && state.config.executionCwd !== state.config.workspaceCwd) {
      // Non-isolated loop with executionCwd: if the path is gone, degrade
      // gracefully to workspaceCwd (no isolation contract to enforce).
      try {
        const { stat } = await import('fs/promises');
        await stat(state.config.executionCwd);
      } catch {
        logger.warn('Loop restore: executionCwd worktree missing — falling back to workspaceCwd', {
          id: state.id,
          missingPath: state.config.executionCwd,
        });
        state.config.executionCwd = undefined;
      }
    }

    const loopControl = await prepareLoopControl(
      state.config.workspaceCwd,
      state.id,
      [...this.active.keys(), state.id],
    );
    const watcher = new CompletedFileWatcher(
      state.config.workspaceCwd,
      state.config.completion.completedFilenamePattern,
      completedPlanWatchDirs(state.config),
    );
    watcher.start();
    const existingCompletedFile = watcher.scanOnce();
    if (existingCompletedFile) {
      logger.info('Loop restore: pre-existing *_Completed.md present — ignored (only post-resume renames count)', {
        id: state.id,
        file: existingCompletedFile,
      });
    }
    wireLoopCompletionWatcher(watcher, state, (eventName, payload) => this.emit(eventName, payload));
    state.loopControl = publicLoopControlMetadata(loopControl);
    this.loopControls.set(state.id, loopControl);
    if (state.config.nextObjectivePlanning?.enabled) {
      this.nextObjectivePlanners.set(state.id, createAuxiliaryNextObjectivePlanner());
    }
    this.watchers.set(state.id, watcher);
    this.active.set(state.id, state);
    this.histories.set(state.id, checkpoint.historyTail);
    this.cancelFlags.set(state.id, false);
    this.restoredLoops.add(state.id);
    if (checkpoint.convergenceNote) this.convergenceNotes.set(state.id, checkpoint.convergenceNote);
    if (checkpoint.planRegenerationCount > 0) this.planRegenerations.set(state.id, checkpoint.planRegenerationCount);
    if (checkpoint.pendingContextReset) this.pendingContextReset.add(state.id);
    this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
    return state;
  }

  /** Pause the loop. Iteration in-flight finishes; next pre-flight blocks. */
  pauseLoop(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'running') return false;
    state.status = 'paused';
    this.pingPongReviewAborts.abortPause(loopRunId, 'loop paused');
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop paused (manual)', { loopRunId });
    return true;
  }

  /** Fail the loop immediately through the normal terminal cleanup path. */
  failLoop(loopRunId: string, reason = 'failed'): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (isTerminalLoopRuntimeState(state)) return false;
    this.cancelFlags.set(loopRunId, true);
    const gate = this.pauseGates.get(loopRunId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(loopRunId);
    }
    this.terminate(state, 'failed', reason);
    return true;
  }

  /**
   * Operator control (bigchange_pingpong_review §4.12): skip the NEXT ping-pong
   * reviewer round. The next builder done-declaration won't spawn a reviewer —
   * useful when the operator already trusts the latest change. Returns false if
   * the loop isn't in ping-pong mode.
   */
  requestPingPongSkipRound(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state?.pingPong) return false;
    state.pingPong.skipNextRound = true;
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Ping-pong: operator requested skip of next reviewer round', { loopRunId });
    return true;
  }

  /**
   * Operator control (bigchange_pingpong_review §4.12): force the ping-pong
   * loop straight to `needs-human-arbitration` at the next completion check,
   * surfacing the open issue ledger. Returns false if not in ping-pong mode.
   */
  requestPingPongArbitration(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state?.pingPong) return false;
    state.pingPong.forceArbitration = true;
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Ping-pong: operator forced human arbitration', { loopRunId });
    return true;
  }

  /** Resume a paused or provider-limited loop. */
  resumeLoop(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'paused' && state.status !== 'provider-limit') return false;
    if (state.status === 'provider-limit' && state.endedAt != null) return false;
    const wakeup = this.scheduledWakeups.get(loopRunId);
    if (wakeup) {
      state.pendingInterventions.push(
        createLoopPendingInput(
          `Wakeup resumed: ${wakeup.summary}`,
          { source: 'wakeup' },
        ),
      );
      this.scheduledWakeups.delete(loopRunId);
    }
    // A manual resume supersedes any pending provider-limit auto-resume timer.
    this.providerLimitHandler.clearResumeTimer(loopRunId);
    state.status = 'running';
    // A3 (#29): no longer waiting on input once the operator resumes.
    state.pausedForInput = false;
    const gate = this.pauseGates.get(loopRunId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(loopRunId);
    } else if (this.restoredLoops.delete(loopRunId)) {
      this.startRestoredLoopRunner(state);
    }
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop resumed', { loopRunId });
    return true;
  }

  private startRestoredLoopRunner(state: LoopState): void {
    const stageMachine = new LoopStageMachine(state.config.workspaceCwd, state.id);
    void this.runLoop(state, stageMachine).catch((err) => {
      logger.error('Restored loop runtime error', err instanceof Error ? err : new Error(String(err)), { loopRunId: state.id });
      this.terminate(state, 'error', err instanceof Error ? err.message : String(err));
    });
  }

  /** Queue a user-supplied hint. See `LoopPendingInputKind` for drain timing. */
  intervene(
    loopRunId: string,
    message: string,
    kind: LoopPendingInputKind = 'queue',
    drainMode?: LoopQueueDrainMode,
  ): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (!isActiveLoopRuntimeState(state)) return false;
    // Pi Task 18: live mid-iteration steering requires a provider adapter that
    // accepts input while a turn is in flight. The loop invokes discrete turns
    // (no live-input channel today), so a `steer` request is downgraded to a
    // next-iteration hint and the downgrade is surfaced so the UI never pretends
    // the message was delivered live.
    let effectiveKind = kind;
    if (kind === 'steer' && !this.supportsLiveSteering()) {
      effectiveKind = 'queue';
      this.emit('loop:steering-downgraded', {
        loopRunId,
        requestedKind: 'steer',
        effectiveKind: 'queue',
        reason: 'active loop provider does not accept mid-iteration input; queued for the next iteration',
      });
      logger.info('Loop steering downgraded to next-iteration', { loopRunId });
    }
    // Task 18: drainMode only affects follow-up drain cadence; it is harmless on
    // other kinds but only meaningful for `follow-up`.
    const intervention = createLoopPendingInput(message, {
      kind: effectiveKind,
      source: 'human',
      ...(drainMode ? { drainMode } : {}),
    });
    state.pendingInterventions.push(intervention);
    this.emit('loop:intervention-applied', { loopRunId, message, kind: effectiveKind });
    // Task 18: make the queued message DURABLE immediately. The loop:state-changed
    // handler persists a checkpoint (state_json carries pendingInterventions), so
    // a queued/follow-up message survives an app restart even while the loop sits
    // idle/paused between iterations — not only after the next iteration's own
    // checkpoint write.
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop intervention queued', { loopRunId, kind: effectiveKind, length: state.pendingInterventions.length });
    return true;
  }

  /**
   * Pi Task 18: whether the active loop can deliver a "steering" message live to
   * an in-flight turn. No current loop provider adapter exposes a mid-iteration
   * input channel in the loop path (turns are discrete), so this is false and
   * `intervene('steer')` downgrades to next-iteration. A future adapter that
   * genuinely supports live input registers via `setLiveSteeringSupported(true)`;
   * kept as real state (not a call-site literal) so the non-downgrade path stays
   * reachable and testable.
   */
  private liveSteeringSupported = false;
  setLiveSteeringSupported(supported: boolean): void {
    this.liveSteeringSupported = supported;
  }
  private supportsLiveSteering(): boolean {
    return this.liveSteeringSupported;
  }

  /**
   * Cancel a running or paused loop. Idempotent.
   *
   * Critically: this terminates state IMMEDIATELY rather than just setting
   * a flag for `runLoop` to read at the next checkpoint. If the loop is
   * mid-iteration (`await invokeChild(...)`) on a hung CLI process, the
   * flag-only path leaves the UI stuck for up to the iteration timeout
   * (5 minutes). With immediate termination, the renderer sees the loop
   * cancelled and disappears from the active-loops list right away. The
   * orphaned in-flight Promise resolves later into a now-idempotent
   * `terminate()` call that no-ops because the state is already terminal.
   */
  async cancelLoop(loopRunId: string): Promise<boolean> {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (isTerminalLoopRuntimeState(state)) return false;
    this.cancelFlags.set(loopRunId, true);
    this.pingPongReviewAborts.abortTerminal(loopRunId, 'loop cancelled');
    // unblock pause if any
    const gate = this.pauseGates.get(loopRunId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(loopRunId);
    }
    // Force-terminate now so the UI escapes a hung in-flight iteration.
    this.terminate(state, 'cancelled', 'user cancelled');
    // FU-8: wait for the adapter-cleanup hook (if registered) to actually
    // tear down any CLI children before returning. Callers — IPC handlers,
    // graceful-shutdown logic, tests — get a real "fully shut down" signal,
    // not just "state is terminal but the CLI child may still be running".
    try {
      await this.awaitTerminalCleanup(loopRunId);
    } catch (err) {
      logger.warn('cancelLoop: adapter cleanup hook rejected', {
        loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // A2 (#18): verify-the-abort. Cleanup resolving is a claim, not proof —
    // confirm the child actually went quiet, and escalate a zombie turn
    // (activity arriving after terminate) to a hard adapter cleanup.
    await this.confirmStablyStopped(loopRunId);
    this.emit('loop:cancel-confirmed', { loopRunId });
    return true;
  }

  /** A2 (#18): see `confirmLoopStablyStopped` in loop-coordinator-utils.ts. */
  private async confirmStablyStopped(loopRunId: string): Promise<void> {
    await confirmLoopStablyStopped({
      loopRunId,
      hasAdapterCleanupHook: this.adapterCleanupHook !== null,
      inFlight: this.active.get(loopRunId)?.inFlightIteration !== undefined,
      subscribeActivity: (listener) => {
        this.on('loop:activity', listener);
        return () => this.off('loop:activity', listener);
      },
      escalate: async () => {
        await this.adapterCleanupHook?.(loopRunId);
      },
      warn: (message, meta) => logger.warn(message, meta),
    });
  }

  /**
   * LF-7 — operator accepts a paused, done-but-ungated run. This is the missing
   * "accept completion" action that previously left manual-review loops stuck
   * paused forever (loopfixex §12.2 #1): the renderer only exposed
   * start/pause/resume/intervene/cancel, so a loop with no verify command could
   * never reach a clean terminal state from the UI.
   *
   * Valid only when the loop is `paused` AND it is awaiting review from an
   * actual completion attempt (`lastCompletionOutcome === 'unverifiable'`) or
   * has a pending `complete` terminal intent. `manualReviewOnly` is startup
   * config, not completion evidence. When a verify command exists, it is run
   * once: pass → terminate `completed`, fail → reject (stay paused, surface
   * the failure). With no verify command, terminate `completed-needs-review`.
   * Returns true iff the loop terminated.
   */
  async acceptCompletion(loopRunId: string): Promise<boolean> {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'paused') {
      logger.info('acceptCompletion ignored — loop is not paused', { loopRunId, status: state.status });
      return false;
    }
    const eligible = state.lastCompletionOutcome === 'unverifiable' || state.terminalIntentPending?.kind === 'complete';
    if (!eligible) {
      logger.info('acceptCompletion ignored — loop is not awaiting review', {
        loopRunId,
        manualReviewOnly: state.manualReviewOnly,
        lastCompletionOutcome: state.lastCompletionOutcome,
        pendingKind: state.terminalIntentPending?.kind,
      });
      return false;
    }

    const hasVerifyCommand = !!state.config.completion.verifyCommand.trim();
    if (hasVerifyCommand) {
      const verify = await this.completionDetector.runVerify(state.config);
      // A re-entrant terminate (e.g. operator hit Stop while verify ran) means
      // the loop is already gone — bail without overriding its terminal status.
      if (isTerminalLoopRuntimeState(state)) return false;
      if (verify.status === 'failed') {
        state.lastCompletionOutcome = 'verify-failed';
        this.convergenceNotes.set(state.id, 'operator-accept verify failed');
        if (state.lastIteration) {
          applyVerifyOutcomeToIteration(state.lastIteration, verify);
          void this.enrichVerifyFailureSummary(state, state.lastIteration, verify.output);
        }
        this.emit('loop:claimed-done-but-failed', {
          loopRunId: state.id,
          signal: 'declared-complete',
          failure: 'Operator accept was rejected. ' + verifyFailureIntervention('verify', verify.output, verify.failureKind),
        });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        return false;
      }
      const finalAudit = await runLoopFinalAudit(
        state,
        state.lastIteration,
        verify.status,
        new LoopStageMachine(state.config.workspaceCwd, state.id),
      );
      if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'failed') {
        const handled = await this.handleFinalAuditBlockedCompletion({
          state,
          iteration: state.lastIteration,
          finalAudit,
          stageMachine: new LoopStageMachine(state.config.workspaceCwd, state.id),
          signal: 'declared-complete',
        });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        return handled === 'terminal';
      }
      // verify passed → clean completion
      if (state.terminalIntentPending?.kind === 'complete') {
        this.transitionTerminalIntent(state, state.terminalIntentPending, 'accepted', 'operator accepted completion');
        state.terminalIntentPending = undefined;
      }
      state.lastCompletionOutcome = 'accepted';
      if (state.lastIteration) {
        applyVerifyOutcomeToIteration(state.lastIteration, verify);
      }
      if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'needs-review') {
        const reason = 'operator accepted completion; final audit requires review';
        this.emit('loop:completed-needs-review', {
          loopRunId: state.id,
          reason,
          acceptedByOperator: true,
        });
        this.terminate(state, 'completed-needs-review', reason);
      } else {
        this.emit('loop:completed', {
          loopRunId: state.id,
          signal: 'declared-complete',
          verifyOutput: excerpt(verify.output, 4096),
          acceptedByOperator: true,
        });
        this.terminate(state, 'completed', 'operator accepted completion (verify passed)');
      }
    } else {
      // No verify command — the operator vouches for the work; flag for review.
      if (state.terminalIntentPending?.kind === 'complete') {
        this.transitionTerminalIntent(state, state.terminalIntentPending, 'accepted', 'operator accepted completion (needs review)');
        state.terminalIntentPending = undefined;
      }
      state.lastCompletionOutcome = 'accepted';
      const reason = 'operator accepted completion; no verify command — needs review';
      this.emit('loop:completed-needs-review', {
        loopRunId: state.id,
        reason,
        acceptedByOperator: true,
      });
      this.terminate(state, 'completed-needs-review', reason);
    }

    // Wake the parked runLoop so it observes the now-terminal state and exits
    // cleanly. terminate() already flipped the status; the cancel flag makes
    // the post-pause check return, and its terminate('cancelled') no-ops
    // because we are already terminal (idempotent guard).
    this.cancelFlags.set(loopRunId, true);
    const gate = this.pauseGates.get(loopRunId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(loopRunId);
    }
    try {
      await this.awaitTerminalCleanup(loopRunId);
    } catch (err) {
      logger.warn('acceptCompletion: adapter cleanup hook rejected', {
        loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  /**
   * Best-effort, fire-and-forget local-model TL;DR of a FAILED verify command,
   * attached to the iteration for operator display. Off the decision path (zero
   * completion latency), never influences completion (resolver reads only
   * verifyStatus), never throws. Guarded: only mutates/broadcasts when the
   * iteration is still current and the loop still live.
   */
  private async enrichVerifyFailureSummary(
    state: LoopState,
    iteration: LoopIteration | undefined,
    rawOutput: string,
  ): Promise<void> {
    if (!iteration || !rawOutput) return;
    try {
      const summary = await summarizeVerifyOutput(rawOutput);
      if (!summary || state.lastIteration !== iteration) return;
      iteration.verifySummary = summary.text;
      if (!isTerminalLoopRuntimeState(state)) {
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
      }
    } catch {
      /* operator-UX enrichment must never disturb the loop */
    }
  }

  /** Snapshot of the live loop state. */
  getLoop(loopRunId: string): LoopState | undefined {
    const s = this.active.get(loopRunId);
    return s ? this.cloneStateForBroadcast(s) : undefined;
  }

  getActiveLoops(): LoopState[] {
    return Array.from(this.active.values()).map((s) => this.cloneStateForBroadcast(s));
  }

  /** Snapshot of the recent iteration history (oldest → newest). */
  getIterations(loopRunId: string): LoopIteration[] {
    const h = this.histories.get(loopRunId);
    return h ? [...h] : [];
  }

  // ============ Stream API ============

  async *streamLoop(loopRunId: string): AsyncGenerator<LoopStreamEvent> {
    const active = this.active.get(loopRunId);
    if (!active) {
      yield { type: 'error', loopRunId, error: `Loop ${loopRunId} not found` };
      return;
    }
    yield* streamLoopEvents({ emitter: this, loopRunId, chatId: active.chatId });
  }

  // ============ Internal — main loop ============

  private async runLoop(state: LoopState, stageMachine: LoopStageMachine): Promise<void> {
    // review-driven mode (the default for user-started loops) replaces the
    // evidence-ladder completion machinery with a relentless fresh-eyes
    // self-review: keep iterating until the model emits the no-outstanding
    // phrase with no production-code changes for N consecutive rounds. The
    // stage machinery, verify/rename gates, and no-progress pause are bypassed
    // because "no changes" is the SUCCESS condition here, not a stall.
    const reviewDriven = state.config.completion.mode === 'review-driven';
    // Ping-pong mode rides on top of review-driven: a dedicated completion
    // branch runs a full agentic reviewer on every builder done-declaration.
    const pingPongEnabled =
      reviewDriven && state.config.completion.crossModelReview?.pingPong?.enabled === true;
    while (true) {
      // -- pause / cancel / cap pre-flight --
      // If the state was already terminated externally (e.g. cancelLoop
      // force-terminating because the in-flight iteration was hung), exit
      // immediately. terminate() is idempotent so the no-op is safe even
      // if we still call it.
      if (isTerminalLoopRuntimeState(state) || this.cancelFlags.get(state.id)) {
        this.terminate(state, 'cancelled');
        return;
      }
      if (isParkedLoopRuntimeState(state)) {
        await this.waitWhilePaused(state.id);
        if (this.cancelFlags.get(state.id)) {
          this.terminate(state, 'cancelled');
          return;
        }
      }
      const capHit = checkLoopHardCaps(state);
      if (capHit) {
        const reason = describeLoopCapReason(state, capHit, this.convergenceNotes.get(state.id));
        // D2 (#6, prompt-only interim): before terminating on a cap, run ONE
        // final wrap-up iteration with a strong "summarize, do not start new
        // work" directive so the run ends with a structured hand-off instead
        // of an abrupt mid-action cut. Guarded to exactly one wrap-up per run.
        const wrapUpEnabled = state.config.caps.capWrapUpIteration ?? true;
        if (wrapUpEnabled && !this.capWrapUpRuns.has(state.id) && state.status === 'running') {
          this.capWrapUpRuns.set(state.id, capHit);
          state.pendingInterventions.push(
            createLoopPendingInput(buildCapWrapUpDirective(capHit, reason), { source: 'cap-wrap-up' }),
          );
          this.emit('loop:cap-wrap-up', { loopRunId: state.id, cap: capHit, reason });
          logger.info('Loop cap reached — running one final wrap-up iteration', {
            loopRunId: state.id,
            cap: capHit,
          });
          // fall through: spawn the single wrap-up iteration; the next pass
          // re-detects the cap and terminates.
        } else {
          this.emit('loop:cap-reached', { loopRunId: state.id, cap: capHit, reason });
          this.terminate(state, 'cap-reached', reason);
          return;
        }
      }

      // -- usage-aware throttle (preventive) --
      // Before spawning another paid iteration, consult the active provider's
      // quota window. At ≥90% (or exhausted, or already on paid overage) we
      // park instead of starting a turn that would spill into real money.
      if (state.status === 'running') {
        const throttle = this.providerLimitHandler.evaluateLoopQuotaThrottle(state);
        if (throttle.action === 'downshift' && throttle.downshift) {
          this.downshiftModelByLoop.set(state.id, throttle.downshift.model);
          this.emit('loop:activity', {
            loopRunId: state.id,
            seq: state.totalIterations,
            stage: state.currentStage,
            timestamp: Date.now(),
            kind: 'status',
            message: `Provider quota high — downshifting to ${throttle.downshift.model}`,
            detail: {
              reason: throttle.reason,
              bindingWindowId: throttle.window?.id,
              targetWindowId: throttle.downshift.windowId,
            },
          });
        } else if (isParkingDecision(throttle)) {
          const outcome = this.providerLimitHandler.handleProviderLimit(state, {
            reason: throttle.reason ?? 'provider usage limit reached',
            resumeAt: throttle.resumeAt ?? null,
            source: 'quota',
            action: throttle.action,
            windowId: throttle.window?.id,
          });
          if (outcome === 'terminated') return;
          if (outcome === 'parked') continue; // next pass blocks in waitWhilePaused
          // 'skipped' (stale/soft) → fall through and spawn this iteration.
        } else {
          this.downshiftModelByLoop.delete(state.id);
        }
      }
      const resourceDecision = this.resourceGovernor?.(state);
      if (resourceDecision?.actions.includes('pause-loop')) {
        state.status = 'paused';
        const reason = `Paused by resource governor: ${resourceDecision.reasons.join(', ')}`;
        const signal = resourceGovernorPauseSignal(reason, resourceDecision);
        this.convergenceNotes.set(state.id, reason);
        this.emit('loop:paused-no-progress', {
          loopRunId: state.id,
          reason: 'resource-governor',
          decision: resourceDecision,
          signal,
        });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        continue;
      }
      await this.importTerminalIntentsForBoundary(state, {
        maxIterationSeq: state.totalIterations,
        terminalEligible: state.status === 'running',
      });
      if (isParkedLoopRuntimeState(state)) continue;
      if (state.terminalIntentPending?.kind === 'fail') {
        const intent = state.terminalIntentPending;
        this.transitionTerminalIntent(state, intent, 'accepted', 'fail intent imported before next iteration');
        state.terminalIntentPending = undefined;
        this.terminate(state, 'failed', intent.summary);
        return;
      }
      if (state.terminalIntentPending?.kind === 'block' && state.status === 'running') {
        await this.pauseForBlockIntent(state, state.terminalIntentPending);
        continue;
      }

      // -- BLOCKED.md handshake --
      // The autonomous-mode rules tell the AI to write BLOCKED.md and exit
      // when it genuinely cannot proceed. Honor that contract: if we find
      // one in the workspace, pause the loop and surface it as a no-progress
      // banner so the operator can intervene with a hint.
      const blockedFile = await readBlockedFileIfPresentHelper(state);
      if (blockedFile && state.status === 'running') {
        const probeCfg = state.config.blockSanityProbe;
        const probeEnabled = probeCfg?.enabled !== false; // default-on when undefined
        let failedProbeDetail: string | undefined;
        if (probeEnabled && isToolchainClassBlockHelper(blockedFile.message, [])) {
          const probe = await runWorkspaceLivenessProbeHelper(
            state.config.workspaceCwd,
            probeCfg?.timeoutMs ?? 5000,
          );
          if (probe.alive) {
            state.pendingInterventions.push(
              createLoopPendingInput(getBlockOverrideInterventionTextHelper(), { source: 'block-override' }),
            );
            this.convergenceNotes.set(state.id, 'BLOCKED.md overridden by liveness probe');
            await this.moveBlockedFileAside(state);
            this.emit('loop:activity', {
              loopRunId: state.id,
              seq: state.totalIterations,
              stage: state.currentStage,
              timestamp: Date.now(),
              kind: 'status',
              message: 'BLOCKED.md overridden: liveness probe confirmed toolchain responsive',
              detail: { probe: probe.detail },
            });
            logger.info('BLOCKED.md override by liveness probe', {
              loopRunId: state.id,
              probe: probe.detail,
            });
            continue;
          }
          failedProbeDetail = probe.detail;
        }
        state.status = 'paused';
        // A3 (#29): this pause is *waiting for operator input*, not a stall —
        // sticky state exempt from idle/stall kills until resumed.
        state.pausedForInput = true;
        const signal: ProgressSignalEvidence = {
          id: 'BLOCKED',
          verdict: 'CRITICAL',
          message: failedProbeDetail
            ? `BLOCKED.md present: ${blockedFile.message} (liveness probe failed: ${failedProbeDetail})`
            : `BLOCKED.md present: ${blockedFile.message}`,
          detail: {
            file: 'BLOCKED.md',
            excerpt: blockedFile.message,
            ...(failedProbeDetail ? { probeDetail: failedProbeDetail } : {}),
          },
        };
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused because the iteration wrote BLOCKED.md', {
          loopRunId: state.id,
          probeDetail: failedProbeDetail,
        });
        continue;
      }

      if (
        state.totalIterations === 0
        && !state.preflight
        && state.config.audit.preflightMode !== 'off'
        && state.status === 'running'
      ) {
        const preflight = await runLoopPreflight(state, this.completionDetector);
        state.preflight = preflight;
        await writeLoopPreflightArtifact(state, preflight);
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        if (state.config.audit.preflightMode === 'block' && preflight.status === 'failed') {
          state.status = 'paused';
          state.lastCompletionOutcome = 'unverifiable';
          const reason = 'preflight verification failed before implementation';
          const signal = preflightBlockedSignal(reason, preflight);
          state.endReason = reason;
          this.convergenceNotes.set(state.id, reason);
          this.emit('loop:paused-no-progress', {
            loopRunId: state.id,
            reason,
            signal,
          });
          this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
          continue;
        }
      }

      // -- pre-iteration kill switch --
      const history = this.histories.get(state.id) ?? [];
      // review-driven loops converge by going quiet (no changes + clean review),
      // which the structural no-progress detector would mistake for a stall. The
      // clean-pass counter + hard caps bound these runs instead.
      // A3 (#29): a loop waiting on (or just handed) operator input is a
      // sticky state — the stall kill switch must not fire before the loop
      // gets an iteration to act on that input.
      const block = reviewDriven || isStickyWaitingForInput(state)
        ? null
        : this.progressDetector.shouldRefuseToSpawnNext(state, history);
      if (block) {
        // LF-4: when disposable-plan regeneration is enabled and budget remains,
        // bypass the kill switch (spawn an iteration so the post-iteration
        // CRITICAL path can inject ONE regenerate directive) rather than pause.
        // This is a READ-ONLY check — the single increment + directive happens
        // in `maybeRegeneratePlanOnStall` at the post-iteration site, so a stall
        // never burns two of the cap budget in one pass.
        if (canRegenerateLoopPlanOnStall(state, this.planRegenerations.get(state.id) ?? 0)) {
          logger.info('Loop kill switch bypassed for disposable-plan regeneration', {
            loopRunId: state.id,
            signal: block.id,
          });
          // fall through to spawn (do NOT pause/continue)
        } else {
          // Pause and wait for user.
          state.status = 'paused';
          this.emit('loop:paused-no-progress', { loopRunId: state.id, signal: block });
          this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
          logger.info('Loop pre-iteration kill switch fired', { loopRunId: state.id, signal: block });
          continue; // re-enter pause loop on next iteration
        }
      }

      // -- read current stage --
      const stage = await stageMachine.readStage(state.config);
      if (stage !== state.currentStage) {
        // LF-4 RPI: on a PLAN→IMPLEMENT transition, reset context before the
        // first IMPLEMENT iteration so it starts from a clean session anchored
        // on the (now finalized) plan, not the planning transcript. Gated on
        // context discipline being enabled (it reuses the LF-1 recycle path).
        const contextEnabled = (state.config.context?.compaction.enabled) ?? true;
        if (state.currentStage === 'PLAN' && stage === 'IMPLEMENT' && contextEnabled) {
          this.pendingContextReset.add(state.id);
          logger.info('Loop PLAN→IMPLEMENT: scheduling context reset for the first IMPLEMENT iteration', {
            loopRunId: state.id,
          });
        }
        state.currentStage = stage;
        state.iterationsOnCurrentStage = 0;
      }

      // -- spawn iteration --
      const seq = state.totalIterations;
      const iterStart = Date.now();
      const loopControl = this.loopControls.get(state.id);
      if (loopControl) {
        await writeLoopControlFile(loopControl, seq);
        state.loopControl = publicLoopControlMetadata(loopControl);
      }
      // The "manual-review-only → completion will pause for the operator"
      // prompt block only applies when there is NO independent completion
      // authority. When fresh-eyes cross-model review is enabled it IS the
      // authority for a no-verify loop (the loop auto-completes on a clean
      // review), so showing the pause warning would be misleading — the
      // separate fresh-eyes review block already explains that path.
      const crossModelReviewEnabled = !!state.config.completion.crossModelReview?.enabled;
      // review-driven mode uses its own simpler prompt and does NOT append the
      // loop-control CLI hints (completion there is the no-outstanding phrase,
      // not an explicit `complete` intent — surfacing the CLI would just invite
      // a self-declared completion the review-driven path ignores).
      // Pi Task 18: partition the queue by drain timing. `next-iteration`
      // (kind `queue`) and `steering` (kind `steer`) hints are embedded into
      // THIS prompt and drained now; `follow-up` hints are held back — they only
      // activate at the completion seam, "before you finish" (drained there).
      const { drainNow: drainNowInterventions, deferredFollowUps } =
        partitionPendingByDrainTiming(state.pendingInterventions);
      const prompt = reviewDriven
        ? stageMachine.buildReviewDrivenPrompt({
            config: state.config,
            iterationSeq: seq,
            pendingInterventions: drainNowInterventions,
            existingSessionContext: this.runtimeContexts.get(state.id)?.existingSessionContext,
            priorObservations: this.runtimeContexts.get(state.id)?.priorObservations,
          })
        : this.appendLoopControlPrompt(state, stageMachine.buildPrompt({
            config: state.config,
            iterationSeq: seq,
            pendingInterventions: drainNowInterventions,
            capUsage: { totalTokens: state.totalTokens, totalCostCents: state.totalCostCents },
            existingSessionContext: this.runtimeContexts.get(state.id)?.existingSessionContext,
            priorObservations: this.runtimeContexts.get(state.id)?.priorObservations,
            uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
            manualReviewOnly: state.manualReviewOnly && !crossModelReviewEnabled,
          }));
      // The buildPrompt() call above embedded the drain-now interventions into
      // the iteration prompt, so we clear them — but RETAIN any `follow-up`
      // hints so they survive to the completion seam. (Previous revisions
      // captured the consumed list for a lockout decision that no longer
      // exists — Task 2 in the 2026-05-26 loop-mode-reliability plan removed it.)
      state.pendingInterventions = deferredFollowUps;

      const inFlightIteration = {
        seq,
        stage,
        startedAt: iterStart,
        idempotencyKey: this.iterationIdempotencyKey(state.id, seq),
      };
      state.inFlightIteration = inFlightIteration;
      await this.runPreIterationHooks(state, inFlightIteration);

      this.emit('loop:iteration-started', { loopRunId: state.id, seq, stage });

      let childResult: LoopChildResult | null = null;
      let invocationError: string | null = null;
      let invocationFailure: unknown = null;
      // LF-4 RPI: consume a one-shot PLAN→IMPLEMENT context reset request.
      let forceContextReset = this.pendingContextReset.delete(state.id);
      let contextOverflowRecoveryAttempted = false;

      // Degraded-iteration resilience: a single transient invocation failure or a
      // "void" iteration (no output, no files, no tool calls) should not kill a
      // long loop or be miscounted as no-progress. Retry the SAME seq a bounded
      // number of times with a fresh session before falling through to the
      // existing error / normal-processing path. Disabled → exactly one attempt.
      const retryCfg = state.config.degradedIterationRetry;
      const maxRetries = retryCfg?.enabled === false ? 0 : Math.max(0, retryCfg?.maxRetries ?? 2);
      let degradedAttempts = 0;
      let breakerOpenWaits = 0;
      let invocationAttempts = 0;
      for (;;) {
        childResult = null;
        invocationError = null;
        invocationFailure = null;
        try {
          childResult = await this.invokeChild(state, prompt, stage, forceContextReset);
        } catch (err) {
          invocationFailure = err;
          invocationError = err instanceof Error ? err.message : String(err);
          logger.error('Iteration invocation failed', err instanceof Error ? err : new Error(invocationError), { loopRunId: state.id, seq, attempt: invocationAttempts });
        } finally {
          await this.importTerminalIntentsForBoundary(state, {
            maxIterationSeq: seq,
            exactIterationSeq: seq,
            terminalEligible: state.status === 'running',
          });
        }
        invocationAttempts++;

        // Never retry over a filed terminal intent (block/complete/fail) — hand
        // off to the normal terminal-intent flow. Also stop if the loop was
        // cancelled/terminated/parked mid-attempt.
        if (state.terminalIntentPending) break;
        if (isTerminalLoopRuntimeState(state) || this.cancelFlags.get(state.id)) break;
        // D6: if the parent instance was interrupted (pauseLoop() was called inside
        // the invoker), or the loop parks on a provider limit, exit the retry
        // inner loop so runLoop's top-of-iteration pause check can wait for
        // a resume signal.
        if (isParkedLoopRuntimeState(state)) break;

        if (!childResult && invocationFailure) {
          const route = routeClassifiedLoopInvocationFailure({
            state, error: invocationFailure, seq, stage,
            model: this.downshiftModelByLoop.get(state.id),
            contextOverflowRecoveryAttempted,
            providerLimitHandler: this.providerLimitHandler,
            emit: (eventName, payload) => this.emit(eventName, payload),
          });
          if (route === 'retry-fresh') { contextOverflowRecoveryAttempted = true; forceContextReset = true; continue; }
          if (route === 'terminated') return;
          if (route !== 'none') break;
        }

        // Circuit-breaker-OPEN is a transient, self-healing rejection — NOT a
        // degraded iteration and NOT a fatal error. The breaker reopens to
        // HALF_OPEN after its reset window, so retrying immediately (the old
        // behaviour) just gets every attempt re-rejected inside the same OPEN
        // window and kills an otherwise-progressing loop. Back off past the
        // reset window and retry on a fresh session, bounded and independent of
        // the degraded-iteration retry budget.
        if (!childResult && isCircuitBreakerOpenError(invocationError)) {
          if (breakerOpenWaits >= LOOP_MAX_BREAKER_OPEN_WAITS) break;
          breakerOpenWaits++;
          this.emit('loop:activity', {
            loopRunId: state.id,
            seq,
            stage,
            timestamp: Date.now(),
            kind: 'status',
            message: `Circuit breaker open — backing off ${Math.round(LOOP_BREAKER_OPEN_BACKOFF_MS / 1000)}s before retry (${breakerOpenWaits}/${LOOP_MAX_BREAKER_OPEN_WAITS})`,
            detail: { reason: 'circuit-breaker-open', invocationError: invocationError ?? undefined },
          });
          logger.warn('Loop iteration rejected by open circuit breaker; backing off before retry', {
            loopRunId: state.id,
            seq,
            attempt: breakerOpenWaits,
            invocationError,
          });
          await sleep(LOOP_BREAKER_OPEN_BACKOFF_MS);
          // The loop may have been cancelled/terminated while we waited.
          if (isTerminalLoopRuntimeState(state) || this.cancelFlags.get(state.id)) break;
          // Force a fresh session so a wedged same-session adapter recycles.
          forceContextReset = true;
          continue;
        }

        // Degraded-iteration resilience (transient invocation error / void
        // iteration): retry the SAME seq a bounded number of times.
        if (degradedAttempts >= maxRetries) break;
        const degraded = classifyDegradedIterationHelper(childResult, invocationError);
        if (!degraded) break;
        degradedAttempts++;

        this.emit('loop:activity', {
          loopRunId: state.id,
          seq,
          stage,
          timestamp: Date.now(),
          kind: 'status',
          message: `Degraded iteration (${degraded}) — retrying with a fresh session (attempt ${degradedAttempts + 1}/${maxRetries + 1})`,
          detail: { reason: degraded, invocationError: invocationError ?? undefined },
        });
        logger.warn('Retrying degraded loop iteration', { loopRunId: state.id, seq, attempt: degradedAttempts, reason: degraded });
        // Force a fresh session on retry so a wedged same-session adapter recycles.
        forceContextReset = true;
      }
      if (!childResult) {
        if (state.terminalIntentPending) {
          childResult = syntheticChildResultFromTerminalIntentHelper(state.terminalIntentPending, invocationError);
        } else if (isParkedLoopRuntimeState(state)) {
          // D6: inner retry loop exited because the parent instance was interrupted
          // or the loop parked. Propagate to runLoop's top-of-iteration pause check.
          this.clearInFlightIteration(state, seq);
          this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
          continue;
        } else {
          this.terminate(state, 'error', invocationError ?? 'iteration invocation failed');
          return;
        }
      }
      this.clearInFlightIteration(state, seq);

      // If the loop was cancelled (or terminated otherwise) while the
      // iteration was in flight, drop the result silently. Don't accumulate
      // stats, don't emit iteration-complete, don't run progress detection
      // — the loop is over from the user's perspective.
      if (isTerminalLoopRuntimeState(state) || this.cancelFlags.get(state.id)) {
        logger.info('Iteration completed after loop was cancelled — dropping result', {
          loopRunId: state.id,
          seq,
        });
        return;
      }

      // -- usage-aware reactive backstop --
      // Independent of polling: a throttled/over-limit provider does NOT throw
      // — it prints a human-readable notice ("You've hit your session limit ·
      // resets 6:30pm") as the assistant message and exits 0. Without this
      // guard the loop would record that notice as a normal iteration and grind
      // to `cap-reached`, spending real money the whole way. Detect it BEFORE
      // counting the turn: don't accumulate stats, don't run progress/completion
      // detection — park (auto-resume when we know the reset) or terminate with
      // a distinct `provider-limit` reason.
      if (isProviderNotice(childResult.output)) {
        const derived = await this.providerLimitHandler.deriveProviderLimitResumeAfterRefresh(state);
        const outcome = this.providerLimitHandler.handleProviderLimit(state, {
          reason: `provider usage/limit notice in iteration output: "${excerpt(childResult.output).slice(0, 160)}"`,
          resumeAt: derived.resumeAt,
          source: 'notice',
          action: 'notice',
          windowId: derived.windowId,
          mustStop: true,
        });
        logger.warn('Loop hit a provider usage/limit notice', {
          loopRunId: state.id,
          seq,
          outcome,
          resumeAt: derived.resumeAt,
        });
        if (outcome === 'parked') continue;
        return;
      }

      // -- B5: post-compaction health canary --
      // The prior iteration reset/compacted the context, so this turn started
      // from a fresh session. If it came back "void" (no output, no tool calls,
      // no file changes) the executor may not have survived the reset. Run one
      // cheap workspace liveness probe (exec + fs); if the workspace/executor is
      // genuinely unresponsive, pause with a loud BLOCKED rather than grinding
      // out more corrupt turns. A responsive workspace defers to normal
      // no-progress handling (see evaluatePostCompactionCanary).
      const postCompaction = state.justCompacted;
      state.justCompacted = undefined;
      const canaryPause = await evaluatePostCompactionCanaryPause({
        postCompaction,
        childResultVoid: classifyDegradedIterationHelper(childResult, null) === 'void-iteration',
        workspaceCwd: state.config.workspaceCwd,
        probeTimeoutMs: 5000,
      });
      if (canaryPause) {
        state.status = 'paused';
        state.endReason = canaryPause.reason;
        if (!this.convergenceNotes.has(state.id)) this.convergenceNotes.set(state.id, canaryPause.reason);
        const signal: ProgressSignalEvidence = {
          id: 'BLOCKED',
          verdict: 'CRITICAL',
          message: canaryPause.reason,
          detail: { canary: 'post-compaction', compactedAtSeq: canaryPause.compactedAtSeq, probeDetail: canaryPause.probeDetail },
        };
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.warn('Loop paused — post-compaction health canary failed', {
          loopRunId: state.id,
          seq,
          compactedAtSeq: canaryPause.compactedAtSeq,
          probeDetail: canaryPause.probeDetail,
        });
        continue;
      }

      // -- assemble iteration record --
      const iterEnd = Date.now();
      const tokens = childResult.tokens;
      const costCents = typeof childResult.costUsd === 'number' && Number.isFinite(childResult.costUsd)
        ? Math.max(0, Math.ceil(childResult.costUsd * 100))
        : Math.ceil((tokens / 1_000_000) * COST_PER_M_TOKENS_CENTS);

      const prevIter = history[history.length - 1];
      const outputExcerpt = excerpt(childResult.output);
      const outputFull = boundFullOutput(childResult.output);
      const outputSimToPrev = prevIter
        ? jaccard(outputExcerpt, prevIter.outputExcerpt)
        : null;

      const workHash = computeWorkHash({
        stage,
        filesChanged: childResult.filesChanged,
        toolCalls: childResult.toolCalls,
      });

      const iteration: LoopIteration = {
        id: `iter-${state.id}-${seq}-${randomUUID().slice(0, 6)}`,
        loopRunId: state.id,
        seq,
        stage,
        startedAt: iterStart,
        endedAt: iterEnd,
        childInstanceId: childResult.childInstanceId,
        tokens,
        costCents,
        filesChanged: childResult.filesChanged,
        filesRead: childResult.filesRead ?? [],
        toolCalls: childResult.toolCalls,
        errors: childResult.errors,
        testPassCount: childResult.testPassCount,
        testFailCount: childResult.testFailCount,
        ...(childResult.finishReason ? { finishReason: childResult.finishReason } : {}),
        unresolvedToolCalls: childResult.unresolvedToolCalls ?? false,
        workHash,
        outputSimilarityToPrev: outputSimToPrev,
        outputExcerpt,
        outputFull,
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
        transcriptBound: childResult.transcriptBound ?? false,
      };

      // D6 (#7) part 3: any production-file change invalidates the cached
      // clean fresh-eyes verdict (edit-invalidates-proof for reviews).
      if (
        state.freshEyesCleanForWorkState
        && iteration.filesChanged.some((f) => isReviewDrivenProductionChange(f.path))
      ) {
        state.freshEyesCleanForWorkState = false;
      }

      // -- update state aggregates pre-detection --
      state.totalIterations = seq + 1;
      state.totalTokens += tokens;
      state.totalCostCents += costCents;
      state.iterationsOnCurrentStage += 1;
      // Token-burn-without-progress accounting:
      const newPasses = childResult.testPassCount ?? 0;
      if (newPasses > state.highestTestPassCount) {
        state.highestTestPassCount = newPasses;
        state.tokensSinceLastTestImprovement = 0;
      } else {
        state.tokensSinceLastTestImprovement += tokens;
      }

      // -- progress detection --
      const evaluation = this.progressDetector.evaluate(state, history, iteration);
      iteration.progressVerdict = evaluation.verdict;
      iteration.progressSignals = evaluation.signals;

      // -- LF-2: semantic progress signal (escalation modifier; default OFF) --
      // Cadence-gated model check that confirms/softens the structural verdict
      // (mutates evaluation.verdict/iteration.progressVerdict on a confirmed
      // flip). Runs BEFORE the WARN-tracking and CRITICAL-pause below so any
      // flip propagates downstream. See loop-semantic-progress.ts.
      await applySemanticProgressModifier({
        state,
        iteration,
        evaluation,
        seq,
        history,
        reviewer: this.semanticProgressReviewer,
        readNotes: () => stageMachine.readNotes(),
        emit: (eventName, payload) => this.emit(eventName, payload),
        log: logger,
      });

      if (evaluation.verdict === 'WARN') {
        state.recentWarnIterationSeqs.push(seq);
        // keep last warnEscalationWindow + a few
        const keep = state.config.progressThresholds.warnEscalationWindow + 5;
        if (state.recentWarnIterationSeqs.length > keep) {
          state.recentWarnIterationSeqs.splice(0, state.recentWarnIterationSeqs.length - keep);
        }
      }

      const terminalIntentForIteration = state.terminalIntentPending;

      // -- completion detection --
      const completionSignals = await this.completionDetector.observe({
        iteration,
        config: state.config,
        state,
      });
      iteration.completionSignalsFired = completionSignals;

      // -- ledger-progress stall tracking (non-convergence backstop) --
      // Keys off the ledger open-count reaching a new low, NOT file churn, so it
      // catches a loop that edits files every round but never closes an item.
      // Only meaningful when a ledger is active (openCount !== null).
      let ledgerStalled = false;
      const ledgerOpenCount = extractLedgerOpenCount(completionSignals);
      if (ledgerOpenCount !== null) {
        const progress = updateLedgerProgress(state, ledgerOpenCount);
        state.ledgerOpenCountBest = progress.ledgerOpenCountBest;
        state.ledgerNoImprovementIterations = progress.ledgerNoImprovementIterations;
        ledgerStalled = reviewDriven
          && isLedgerStalled(state, ledgerOpenCount, state.config.completion.maxLedgerStallIterations);
      } else {
        // Ledger inactive this iteration — reset the counter so a ledger that
        // appears later isn't pre-stalled by stale accounting.
        state.ledgerNoImprovementIterations = 0;
      }

      // -- verify-before-stop --
      // I/O (verify runs, fresh-eyes gate) is performed here as before;
      // the pure resolveCompletion() function consumes those results and
      // returns the decision, which we map onto the existing coordinator actions.
      let stopWithSignal: CompletionSignalEvidence | null = null;
      let verifyOutputForEmit = '';
      let pauseBecauseCompletionCannotBeVerified = false;
      // LF-7: set when the completion-attempt budget is exhausted (verify keeps
      // passing but the rename gate never does). Acted on after the iteration
      // is logged so the terminal iteration still appears in history/log, and
      // resolves to a SUCCESSFUL `completed-needs-review` terminal (verify is
      // green) rather than a misleading `cap-reached`.
      let completionNeedsReviewReason: string | null = null;
      // review-driven terminal decision (computed below, acted on after the
      // iteration is logged so the converging iteration still lands in history).
      let reviewDrivenTerminal: { status: 'completed' | 'completed-needs-review'; reason: string } | null = null;
      // F2 (#22): the fresh-eyes gate outcome for THIS iteration, when a
      // completion attempt ran it. Feeds the REVIEW→PLAN back-edge veto below.
      let freshEyesGateForBackEdge: FreshEyesGateResult | null = null;
      // Ping-pong terminal decision (broad LoopStatus — can carry the new
      // arbitration / unreliable / cost-exceeded terminals).
      let pingPongTerminal: PingPongTerminal | null = null;
      if (pingPongEnabled) {
        pingPongTerminal = await this.evaluatePingPongCompletion(
          state,
          iteration,
          childResult.output,
          seq,
          stage,
        );
      } else if (reviewDriven) {
        reviewDrivenTerminal = await this.evaluateReviewDrivenCompletion(
          state,
          iteration,
          childResult.output,
          stageMachine,
          seq,
          stage,
        );
      } else if (this.completionDetector.hasSufficientSignal(completionSignals)) {
        // Pick the highest-priority sufficient signal for the stop attempt.
        // LF-7: prefer the structured `declared-complete` terminal intent over
        // the forensic signals (rename / sentinel / checklist) when present —
        // it is the in-band "done tool" equivalent (loopfixex §16) and the
        // authoritative completion signal. Forensic signals stay as fallbacks
        // and corroboration.
        const sufficientList = completionSignals.filter((c) => c.sufficient);
        const candidate =
          sufficientList.find((c) => c.id === 'declared-complete') ?? sufficientList[0]!;

        // FU-6: optional quick-verify pre-flight. When configured, the
        // cheap check (typecheck, lint) runs FIRST so the loop can reject
        // an obviously-broken completion without spending minutes on the
        // full verify. When `quickVerifyCommand` is undefined, the call
        // returns 'skipped' and the full verify runs as before.
        const quick = await this.completionDetector.runQuickVerify(state.config);
        // If the quick check actively failed, treat it as the verify
        // outcome and skip the full verify — saves time and surfaces a
        // focused error message to the agent.
        const v1 = quick.status === 'failed'
          ? quick
          : await this.completionDetector.runVerify(state.config);
        const verifyLabel = quick.status === 'failed' ? 'quick verify' : 'verify';
        applyVerifyOutcomeToIteration(iteration, v1);
        verifyOutputForEmit = v1.output;

        // Confirm failures as well as passes: red→green is treated as a
        // transient verifier flake, while pass→fail stays rejected.
        let v2: VerifyOutcomeLike = v1;
        if (quick.status !== 'failed' && v1.status !== 'skipped' && state.config.completion.runVerifyTwice) {
          v2 = await this.completionDetector.runVerify(state.config);
          applyVerifyOutcomeToIteration(iteration, v2);
          verifyOutputForEmit = v2.output;
        }

        // Run the fresh-eyes gate and check belt-and-braces BEFORE calling the
        // resolver, so the resolver only consumes results. We run the gate when
        // verify PASSED *or* was SKIPPED: for a no-verify loop the fresh-eyes
        // review is the completion authority (Option B default), so it must run
        // for the loop to be able to converge at all.
        const beltAndBracesPassed = this.completionDetector.passesBeltAndBraces(state, state.config);
        const verifyOkOrSkipped = v2.status === 'passed' || v2.status === 'skipped';
        let freshEyesRan = false;
        let freshEyesBlockingCount = 0;
        let freshEyesErrored = false;

        // LF-7: increment the rename-gate attempt counter here so the resolver
        // sees the updated count (it decides continue vs stop-needs-review based
        // on completionAttempts >= maxCompletionAttempts). Only increment when we
        // actually hit the rename gate (verify passed/skipped but belt-and-braces failed).
        if (verifyOkOrSkipped && !beltAndBracesPassed) {
          state.completionAttempts += 1;
        }

        if (verifyOkOrSkipped && beltAndBracesPassed) {
          // Fresh-eyes cross-model review gate. The previous loop bug was
          // that DONE.txt + passing verify was enough to stop, even when
          // the actual goal hadn't been substantively addressed (orphan
          // code, missed renames, half-done specs). This hook calls a
          // different CLI provider with the iteration output + workspace
          // context and asks "is this really done?". Any blocking finding
          // becomes a user intervention and the loop continues.
          const review = await this.runFreshEyesReviewGate(state, candidate.id, iteration, verifyOutputForEmit);
          freshEyesRan = review.ran;
          freshEyesBlockingCount = review.blocked ? 1 : 0;
          freshEyesErrored = review.errored;
          freshEyesGateForBackEdge = review;
        }

        const finalAudit = await runLoopFinalAudit(state, iteration, v2.status, stageMachine);

        // D6 (#7) edit-invalidates-proof: a fresh passing verify (re)anchors
        // the staleness fingerprint. The resolver rejects any 'passed' status
        // whose recorded anchor no longer matches the current work-hash — a
        // carried-over pass (restored run / future re-verify skip) can't
        // satisfy the gate after the workspace changed.
        if (v2.status === 'passed') {
          state.lastVerifiedWorkHash = iteration.workHash;
        }

        // --- evidence-precedence resolution ---
        const resolution = resolveCompletion({
          signals: completionSignals,
          candidate,
          quickVerifyStatus: quick.status,
          verifyStatus: v2.status,
          verifyLabel: quick.status === 'failed' ? 'quick-verify' : v2 !== v1 && v2.status === 'failed' ? 'second-verify' : 'verify',
          beltAndBracesPassed,
          freshEyesRan,
          freshEyesBlockingCount,
          freshEyesErrored,
          manualReviewOnly: state.manualReviewOnly,
          allowOperatorReviewedCompletion: state.config.completion.allowOperatorReviewedCompletion,
          completionAttempts: state.completionAttempts,
          maxCompletionAttempts: state.config.caps.maxCompletionAttempts ?? 3,
          finalAuditMode: state.config.audit.finalAuditMode,
          finalAuditStatus: finalAudit.status,
          finalAuditFindings: finalAudit.findings,
          antiSelfGrading: state.config.completion.antiSelfGrading === true,
          currentWorkHash: iteration.workHash,
          lastVerifiedWorkHash: state.lastVerifiedWorkHash ?? null,
        });

        // --- map resolution to coordinator actions ---
        state.lastCompletionOutcome = resolution.outcome ?? state.lastCompletionOutcome;

        // A4: durably journal the authority evidence gathered this attempt
        // (verify-passed → 'verified', clean fresh-eyes → 'reviewed') and
        // detect contradictions (verify regressing after a prior pass).
        this.recordCompletionEvidence(state, candidate, {
          verifyPassed: v2.status === 'passed',
          freshEyesRan,
          freshEyesBlockingCount,
          freshEyesErrored,
          resolution,
        });

        // claude2_todo #1c: bounded evidence-hash ring buffer — identical weak
        // evidence re-presented across attempts surfaces a stuck-evidence note
        // (see trackRepeatedCompletionEvidence in loop-coordinator-completion-gates).
        trackRepeatedCompletionEvidence({
          state,
          candidate,
          verifyStatus: v2.status,
          beltAndBracesPassed,
          resolution,
          convergenceNotes: this.convergenceNotes,
        });

        if (resolution.decision === 'stop') {
          stopWithSignal = candidate;
        } else if (resolution.decision === 'stop-needs-review') {
          // rename-gate budget exhausted; fall through to post-log terminal handling
          completionNeedsReviewReason = resolution.needsReviewReason!;
        } else if (resolution.decision === 'pause-operator-review') {
          // Completion reached a state that needs operator judgment. Two
          // distinct situations land here, and they MUST read differently to
          // the operator:
          //   (a) freshEyesErrored — the review ran but produced no verdict (the
          //       reviewer threw, returned unparseable output, or no reviewer CLI
          //       was available). If verify passed, that evidence is preserved,
          //       but the explicitly enabled review gate still did not pass.
          //   (b) otherwise — fresh-eyes review was never enabled (or did not run)
          //       and there is no verify command, so there is no authority at all.
          // The resolver already distinguishes the two in `resolution.reason`;
          // surface it verbatim instead of the old one-size "no verify command
          // configured" string, which hid a crashed reviewer behind a config nag.
          this.rejectPendingCompleteIntent(state, resolution.reason);
          const pauseMessages = buildOperatorReviewPauseMessages({
            freshEyesErrored,
            verifyStatus: v2.status,
          });
          this.emit('loop:claimed-done-but-failed', {
            loopRunId: state.id,
            signal: candidate.id,
            failure: pauseMessages.failure,
          });
          state.pendingInterventions.push(createLoopPendingInput(pauseMessages.intervention));
          this.convergenceNotes.set(state.id, resolution.convergenceNote ?? 'completion was unverifiable (no verify command configured)');
          state.endReason = resolution.reason;
          pauseBecauseCompletionCannotBeVerified = true;
        } else {
          // decision === 'continue' — map the specific outcome to the right rejection action
          if (resolution.outcome === 'verify-failed') {
            // Figure out which verify run produced the output for the intervention text
            const failedVerifyOutput = (v2 !== v1 && v2.status === 'failed') ? v2.output : v1.output;
            const friendlyLabel = quick.status === 'failed' ? 'quick verify'
              : (v2 !== v1 && v2.status === 'failed') ? 'anti-flake second verify'
              : verifyLabel;
            if (v2 !== v1 && v2.status === 'failed') {
              // Second verify failed
              this.rejectCompletionAttempt(
                state,
                'second verify failed',
                verifyFailureIntervention(
                  'anti-flake second verify',
                  v2.output,
                  v2.failureKind,
                ),
              );
              this.emit('loop:claimed-done-but-failed', {
                loopRunId: state.id,
                signal: candidate.id,
                failure: 'verify flake suspected: ' + excerpt(v2.output, 4096),
              });
            } else {
              this.rejectCompletionAttempt(
                state,
                `${friendlyLabel} failed`,
                verifyFailureIntervention(
                  friendlyLabel,
                  failedVerifyOutput,
                  selectedVerifyFailureKind(v1, v2),
                ),
              );
              this.emit('loop:claimed-done-but-failed', {
                loopRunId: state.id,
                signal: candidate.id,
                failure: excerpt(failedVerifyOutput, 4096),
              });
            }
          } else if (resolution.outcome === 'review-blocked') {
            if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'failed') {
              const handled = await this.handleFinalAuditBlockedCompletion({
                state,
                iteration,
                finalAudit,
                stageMachine,
                signal: candidate.id,
              });
              if (handled === 'terminal') return;
            } else {
              // Fresh-eyes review blocked — convergenceNote set by runFreshEyesReviewGate
              this.rejectPendingCompleteIntent(state, 'fresh-eyes review blocked completion');
            }
          } else if (resolution.outcome === 'rename-gate') {
            // Rename gate blocked, budget not exhausted
            const maxCompletionAttempts = state.config.caps.maxCompletionAttempts ?? 3;
            this.rejectCompletionAttempt(
              state,
              'completed-file rename gate did not pass',
              'Your completion was rejected because the completed-file rename gate did not pass ' +
                `(attempt ${state.completionAttempts}/${maxCompletionAttempts}). ` +
                'A *_Completed.md rename is required before this loop can stop. ' +
                'Rename the relevant plan file to *_Completed.md, then re-declare completion.',
            );
            this.emit('loop:claimed-done-but-failed', {
              loopRunId: state.id,
              signal: candidate.id,
              failure: 'Verify passed but no *_Completed.md rename observed. Rename the plan file to confirm.',
            });
          }
        }
      }

      // -- LF-1: context-discipline observability --
      // The invoker recycles the loop's persistent same-session adapter when
      // context utilization crosses the threshold and reports it here. Surface
      // it as an event + an ITERATION_LOG note so long-run context management is
      // auditable (never silent — a loop strength).
      if (childResult.contextCompacted) {
        this.emit('loop:context-compacted', {
          loopRunId: state.id,
          seq,
          previousUtilization: childResult.contextCompacted.previousUtilization,
          newUtilization: childResult.contextCompacted.newUtilization,
          reason: childResult.contextCompacted.reason,
        });
        // B5: arm the post-compaction canary for the next iteration's fresh
        // session. Consumed at the top of the next iteration.
        state.justCompacted = { seq, reason: childResult.contextCompacted.reason };
        logger.info('Loop context recycled to fresh session', {
          loopRunId: state.id,
          seq,
          previousUtilization: childResult.contextCompacted.previousUtilization,
        });
      }

      // -- persist iteration in history (sliding window of last 50) --
      history.push(iteration);
      if (history.length > 50) history.splice(0, history.length - 50);
      state.lastIteration = iteration;

      // Operator-UX only: best-effort local-model TL;DR of failed verify output.
      if (iteration.verifyStatus === 'failed') {
        void this.enrichVerifyFailureSummary(state, iteration, verifyOutputForEmit);
      }

      // -- run iteration log + post-iteration hooks --
      try {
        await stageMachine.appendIterationLog({
          seq,
          stage,
          verdict: iteration.progressVerdict,
          tokens,
          durationMs: iterEnd - iterStart,
          filesChanged: iteration.filesChanged.length,
          progressNotes: [
            ...iteration.progressSignals.map((s) => `[${s.id}/${s.verdict}] ${s.message}`),
            // LF-2: record the semantic-progress verdict in the durable log when
            // the check ran this iteration, so done-vs-stuck decisions are auditable.
            ...(iteration.semanticProgress
              ? [
                  `[semantic] advanced=${iteration.semanticProgress.advanced} ` +
                    `conf=${iteration.semanticProgress.confidence.toFixed(2)} — ${iteration.semanticProgress.whatChanged}`,
                ]
              : []),
            // LF-1: durable record of a context recycle this iteration.
            ...(childResult.contextCompacted
              ? [`[context] recycled to fresh session — ${childResult.contextCompacted.reason}`]
              : []),
          ],
          completionNotes: iteration.completionSignalsFired.map((c) => `[${c.id}] ${c.detail}`),
        });
      } catch (err) {
        logger.warn('appendIterationLog failed', { error: String(err) });
      }

      // -- LF-3: bound NOTES.md growth --
      // NOTES.md is agent-maintained and re-read every iteration; left
      // unbounded it eats the context LF-1 conserves. Curate older entries
      // while preserving the completion inventory verbatim. Best-effort; never
      // blocks the loop.
      try {
        const curated = await stageMachine.curateNotesIfNeeded();
        if (curated.changed) {
          logger.info('Curated NOTES.md to bound context', {
            loopRunId: state.id,
            seq,
            elidedChars: curated.elidedChars,
          });
          this.emit('loop:notes-curated', {
            loopRunId: state.id,
            seq,
            elidedChars: curated.elidedChars,
          });
        }
      } catch (err) {
        logger.warn('NOTES.md curation failed', { loopRunId: state.id, error: String(err) });
      }

      if (hasToolRwLockConflict(iteration)) {
        const reason = 'phase4.toolRwLocks safety violation: overlapping write tool calls observed';
        logger.warn('Loop failed closed for tool rw-lock conflict', { loopRunId: state.id, seq });
        this.terminate(state, 'failed', reason);
        return;
      }

      // Pi Task 18: follow-up drain. A `follow-up` intervention is one the
      // operator queued to run "after an iteration would otherwise stop but
      // before terminal completion is accepted." When THIS iteration would
      // complete successfully (a sufficient completion signal, or a review-driven
      // convergence), convert any pending follow-ups into next-iteration hints
      // and keep going instead of stopping. Pauses / needs-review / deadlock
      // terminals are NOT a successful finish and do not consume follow-ups.
      // Ping-pong runs its own dedicated convergence branch and is left intact.
      if (state.status === 'running' && (stopWithSignal || reviewDrivenTerminal?.status === 'completed')) {
        const drained = drainFollowUpsForCompletion(state.pendingInterventions);
        if (drained) {
          state.pendingInterventions = drained.requeued;
          stopWithSignal = null;
          reviewDrivenTerminal = null;
          this.rejectPendingCompleteIntent(state, 'deferring completion to run queued follow-up messages');
          // `remaining` > 0 means a `one-at-a-time` follow-up deferred the rest to
          // the next completion seam — surfaced so the UI/log can show the queue is
          // draining sequentially rather than all at once.
          this.emit('loop:follow-up-drained', {
            loopRunId: state.id,
            seq,
            count: drained.followUpCount,
            remaining: drained.remainingFollowUps,
          });
          logger.info('Loop completion deferred to run queued follow-up messages', {
            loopRunId: state.id,
            seq,
            count: drained.followUpCount,
            remaining: drained.remainingFollowUps,
          });
        }
      }

      // D5: self-declared "more work remaining". The executor that just did the
      // work is the authority on whether it is finished, so an explicit sentinel
      // in its output vetoes a would-be completion (e.g. a sub-task
      // `*_Completed.md` rename or a stray DONE.txt fired a forensic signal).
      // Fail-safe: it ONLY suppresses a clean stop — it can never cause a false
      // stop, and the hard caps bound how long it can keep the loop running.
      if (state.status === 'running' && (stopWithSignal || reviewDrivenTerminal?.status === 'completed')
          && parseAgentMoreWorkRemaining(childResult.output)) {
        stopWithSignal = null;
        reviewDrivenTerminal = null;
        this.rejectPendingCompleteIntent(state, 'agent self-declared more work remaining');
        this.emit('loop:more-work-declared', { loopRunId: state.id, seq });
        logger.info('Loop completion vetoed by self-declared more-work-remaining', { loopRunId: state.id, seq });
      }

      const completionWillStopOrPause = Boolean(
        pingPongTerminal || reviewDrivenTerminal || stopWithSignal || completionNeedsReviewReason
        || pauseBecauseCompletionCannotBeVerified,
      );
      if (!completionWillStopOrPause && state.status === 'running') maybeQueueAnnounceThenHaltContinuation(state, iteration);
      // D4 (#28): self-correcting output-envelope re-wrap. A near-miss
      // completion marker (unclosed/misspelled/paraphrased promise) means the
      // agent believes it declared done but no parser saw it — queue a
      // one-shot correction so the next iteration can stop cleanly. Bounded
      // by maxCompletionAttempts per run; gated mode only (review-driven and
      // ping-pong converge on their own phrases, not the promise envelope).
      if (
        !completionWillStopOrPause &&
        state.status === 'running' &&
        !reviewDriven &&
        !pingPongEnabled &&
        !this.completionDetector.hasSufficientSignal(completionSignals)
      ) {
        const rewraps = this.envelopeRewraps.get(state.id) ?? 0;
        if (rewraps < (state.config.caps.maxCompletionAttempts ?? 3)) {
          const detection = detectMalformedCompletionEnvelope(
            childResult.output,
            state.config.completion.donePromiseRegex,
          );
          if (detection.malformed) {
            this.envelopeRewraps.set(state.id, rewraps + 1);
            state.pendingInterventions.push(
              createLoopPendingInput(buildEnvelopeRewrapCorrection(detection.excerpt ?? '')),
            );
            this.emit('loop:envelope-rewrap', {
              loopRunId: state.id,
              seq,
              excerpt: detection.excerpt,
              attempt: rewraps + 1,
            });
            logger.info('Loop malformed completion envelope — one-shot correction queued', {
              loopRunId: state.id,
              seq,
              excerpt: detection.excerpt,
            });
          }
        }
      }
      if (!completionWillStopOrPause && state.status === 'running') {
        // B5a rehydration must fire whenever a context reset happened, even if
        // the operator/reviewer already queued interventions — surviving the
        // reset is orthogonal to steering. Only the budget nudge yields to a
        // non-empty queue (suppressNudge), preserving the old "don't pile
        // automated nudges on active steering" behaviour.
        await applyLoopContextSurvivalDecision({ manager: this.contextSurvivalManager, state, iteration, childResult, pendingContextReset: this.pendingContextReset, emit: (eventName, payload) => this.emit(eventName, payload), suppressNudge: state.pendingInterventions.length > 0 });
      }

      // F2 (#22): coordinator-enforced REVIEW→PLAN back-edge. Only for
      // gated-mode loops (review-driven and ping-pong have their own
      // convergence machinery) that just ran a REVIEW iteration and are
      // continuing. Agent proposes stage transitions; coordinator disposes.
      if (
        !completionWillStopOrPause &&
        state.status === 'running' &&
        !reviewDriven &&
        !pingPongEnabled &&
        stage === 'REVIEW'
      ) {
        await this.enforceReviewBackEdge(state, iteration, stageMachine, freshEyesGateForBackEdge, seq);
      }
      for (const hook of this.iterationHooks) {
        try { await hook({ state, iteration }); } catch (err) {
          logger.warn('Iteration hook threw', { error: String(err) });
        }
      }
      if (isTerminalLoopRuntimeState(state) || this.cancelFlags.get(state.id)) {
        logger.info('Loop terminated by iteration hook; stopping post-iteration flow', {
          loopRunId: state.id,
          seq,
          status: state.status,
        });
        return;
      }

      this.emit('loop:iteration-complete', { loopRunId: state.id, seq, verdict: iteration.progressVerdict });
      this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });

      if (terminalIntentForIteration?.kind === 'block' && state.terminalIntentPending?.id === terminalIntentForIteration.id) {
        await this.pauseForBlockIntent(state, terminalIntentForIteration);
        continue;
      }
      if (terminalIntentForIteration?.kind === 'fail' && state.terminalIntentPending?.id === terminalIntentForIteration.id) {
        this.transitionTerminalIntent(state, terminalIntentForIteration, 'accepted', 'fail intent accepted');
        state.terminalIntentPending = undefined;
        this.terminate(state, 'failed', terminalIntentForIteration.summary);
        return;
      }

      // -- terminal: ping-pong convergence / deadlock / unreliability --
      // The dedicated ping-pong branch resolves mutual convergence (completed),
      // human-glance (completed-needs-review), or one of the surfaced deadlock /
      // unreliable / cost terminals.
      if (pingPongTerminal) {
        if (
          pingPongTerminal.status === 'completed'
          || pingPongTerminal.status === 'completed-needs-review'
        ) {
          const finalAudit = await runLoopFinalAudit(
            state,
            iteration,
            iteration.verifyStatus === 'passed'
              ? 'passed'
              : iteration.verifyStatus === 'failed'
                ? 'failed'
                : 'skipped',
            stageMachine,
          );
          if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'failed') {
            const handled = await this.handleFinalAuditBlockedCompletion({
              state,
              iteration,
              finalAudit,
              stageMachine,
              signal: 'ping-pong',
            });
            if (handled === 'terminal') return;
            continue;
          }
          if (
            pingPongTerminal.status === 'completed'
            && state.config.audit.finalAuditMode === 'gate'
            && finalAudit.status === 'needs-review'
          ) {
            pingPongTerminal = {
              status: 'completed-needs-review',
              reason: 'Final audit requires operator review before this loop can be considered cleanly complete.',
            };
          }
        }
        if (pingPongTerminal.status === 'completed') {
          this.emit('loop:completed', { loopRunId: state.id, signal: 'ping-pong', verifyOutput: '' });
        } else if (pingPongTerminal.status === 'completed-needs-review') {
          this.emit('loop:completed-needs-review', {
            loopRunId: state.id,
            reason: pingPongTerminal.reason,
            acceptedByOperator: false,
          });
        }
        // Other ping-pong terminals (needs-human-arbitration, reviewer-unreliable,
        // builder-unreliable, cost-exceeded, cap-reached) surface via terminate()'s
        // state-changed broadcast with their distinct status + reason.
        this.terminate(state, pingPongTerminal.status, pingPongTerminal.reason);
        return;
      }

      // -- terminal: review-driven convergence --
      // N consecutive clean fresh-eyes passes. `completed` when nothing was
      // flagged for a human; `completed-needs-review` (a SUCCESS state) when the
      // agent left items in OUTSTANDING.md's "Needs human" section.
      if (reviewDrivenTerminal) {
        const finalAudit = await runLoopFinalAudit(
          state,
          iteration,
          iteration.verifyStatus === 'passed'
            ? 'passed'
            : iteration.verifyStatus === 'failed'
              ? 'failed'
              : 'skipped',
          stageMachine,
        );
        if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'failed') {
          const handled = await this.handleFinalAuditBlockedCompletion({
            state,
            iteration,
            finalAudit,
            stageMachine,
            signal: 'self-declared',
          });
          if (handled === 'terminal') return;
          continue;
        }
        if (
          reviewDrivenTerminal.status === 'completed'
          && state.config.audit.finalAuditMode === 'gate'
          && finalAudit.status === 'needs-review'
        ) {
          reviewDrivenTerminal = {
            status: 'completed-needs-review',
            reason: 'Final audit requires operator review before this loop can be considered cleanly complete.',
          };
        }
        if (reviewDrivenTerminal.status === 'completed') {
          this.emit('loop:completed', {
            loopRunId: state.id,
            signal: 'self-declared',
            verifyOutput: '',
          });
          this.terminate(state, 'completed', reviewDrivenTerminal.reason);
        } else {
          this.emit('loop:completed-needs-review', {
            loopRunId: state.id,
            reason: reviewDrivenTerminal.reason,
            acceptedByOperator: false,
          });
          this.terminate(state, 'completed-needs-review', reviewDrivenTerminal.reason);
        }
        return;
      }

      // -- terminal: review-driven stall → clean stop --
      // review-driven loops are exempt from the structural no-progress *pause*
      // (their convergence looks like a stall to the detector). But a loop that
      // is NEITHER converging (no clean-review streak) NOR making production
      // changes, while the detector reports CRITICAL, is genuinely stuck
      // re-reviewing settled work. Without this guard it burns tokens until a
      // hard cap or the circuit breaker trips — surfacing as a misleading
      // `error` (see the one-more-floor 3h/$8 spin). Stop as a SUCCESSFUL
      // `completed-needs-review` so a human can glance, with a convergence note.
      // -- terminal: ledger-progress stall (non-convergence backstop) --
      // The file-churn stall guard below resets whenever ANY production file
      // changes, so a loop that edits files every round but never CLOSES a
      // ledger item (an open-ended "continue remaining slices" bucket that
      // re-expands as fast as it drains, or a hardware/manual-gated item that
      // can never reach [x]) never trips it and spins to the iteration cap.
      // This check keys off the ledger open-count failing to reach a new low for
      // N iterations — the true convergence signal in ledger mode, independent
      // of file churn. Terminal is a SUCCESSFUL completed-needs-review so a human
      // can glance and either finish the bookkeeping or defer the open items.
      if (ledgerStalled) {
        const openBest = state.ledgerOpenCountBest ?? 0;
        const stalledFor = state.ledgerNoImprovementIterations ?? 0;
        const reason =
          `Review-driven loop stalled: LOOP_TASKS.md open-count has not reached a new low ` +
          `for ${stalledFor} iteration(s) (best ${openBest} item(s) still open). The loop is ` +
          `changing files each round but not closing ledger items — likely an open-ended or ` +
          `externally-gated item that can never reach [x]. Stopped for human review instead of ` +
          `spinning to a hard cap.`;
        if (!this.convergenceNotes.has(state.id)) {
          this.convergenceNotes.set(
            state.id,
            `ledger stall: ${openBest} open, no new low for ${stalledFor} iters`,
          );
        }
        recordLoopLearningForState({
          state,
          status: 'no-progress',
          note: this.convergenceNotes.get(state.id),
          store: this.loopMemoryStore,
        });
        this.emit('loop:completed-needs-review', {
          loopRunId: state.id,
          reason,
          acceptedByOperator: false,
        });
        this.terminate(state, 'completed-needs-review', reason);
        return;
      }

      if (reviewDriven && evaluation.verdict === 'CRITICAL') {
        const madeProductionChange = iteration.filesChanged.some(
          (f) => isReviewDrivenProductionChange(f.path),
        );
        const advancingConvergence = (state.consecutiveCleanReviewPasses ?? 0) > 0;
        if (!madeProductionChange && !advancingConvergence) {
          if (isVerifiedNoChangeCompletionClaim(iteration)) {
            const handled = await handleVerifiedNoChangeReviewDrivenCompletion({
              state,
              iteration,
              stageMachine,
              primary: evaluation.primary ?? evaluation.signals[0],
              handleBlockedCompletion: (args) => this.handleFinalAuditBlockedCompletion(args),
              emitCompletedNeedsReview: (payload) => this.emit('loop:completed-needs-review', payload),
              terminate: (target, status, reason) => this.terminate(target, status, reason),
            });
            if (handled === 'terminal') return;
            continue;
          }
          state.reviewDrivenStallIterations = (state.reviewDrivenStallIterations ?? 0) + 1;
          const limit = Math.max(1, state.config.completion.maxStalledReviewIterations ?? 3);
          if (state.reviewDrivenStallIterations >= limit) {
            const primary = evaluation.primary ?? evaluation.signals[0];
            const reason =
              `Review-driven loop stalled: ${state.reviewDrivenStallIterations} consecutive ` +
              `CRITICAL no-progress iterations with no production changes and no clean-review ` +
              `convergence` +
              (primary ? ` (${primary.message})` : '') +
              `. Stopped for human review instead of spinning to a cap / circuit breaker.`;
            if (!this.convergenceNotes.has(state.id)) {
              this.convergenceNotes.set(
                state.id,
                `review-driven stall: ${primary?.message ?? 'no progress, no convergence'}`,
              );
            }
            recordLoopLearningForState({
              state,
              status: 'no-progress',
              note: this.convergenceNotes.get(state.id),
              store: this.loopMemoryStore,
            });
            this.emit('loop:completed-needs-review', {
              loopRunId: state.id,
              reason,
              acceptedByOperator: false,
            });
            this.terminate(state, 'completed-needs-review', reason);
            return;
          }
          logger.info('Review-driven stall accumulating', {
            loopRunId: state.id,
            seq,
            stall: state.reviewDrivenStallIterations,
            limit,
            signal: evaluation.primary?.message ?? evaluation.signals[0]?.message,
          });
        } else {
          state.reviewDrivenStallIterations = 0;
        }
      } else if (reviewDriven) {
        state.reviewDrivenStallIterations = 0;
      }

      // -- terminal: completion --
      if (stopWithSignal) {
        if (state.terminalIntentPending?.kind === 'complete') {
          this.transitionTerminalIntent(state, state.terminalIntentPending, 'accepted', `completion accepted via ${stopWithSignal.id}`);
          state.terminalIntentPending = undefined;
        }
        this.emit('loop:completed', {
          loopRunId: state.id,
          signal: stopWithSignal.id,
          verifyOutput: excerpt(verifyOutputForEmit, 4096),
        });
        this.terminate(state, 'completed', `signal=${stopWithSignal.id}`);
        return;
      }

      // -- LF-7: completion-attempt budget exhausted → accept as needs-review --
      // Verify is passing every attempt; only the *_Completed.md rename gate is
      // unmet. Rather than oscillate to maxIterations or report a misleading
      // `cap-reached`, accept the work as a SUCCESSFUL `completed-needs-review`
      // terminal so a human can do the bookkeeping rename / glance.
      if (completionNeedsReviewReason) {
        if (state.terminalIntentPending?.kind === 'complete') {
          this.transitionTerminalIntent(state, state.terminalIntentPending, 'accepted', completionNeedsReviewReason);
          state.terminalIntentPending = undefined;
        }
        this.emit('loop:completed-needs-review', {
          loopRunId: state.id,
          reason: completionNeedsReviewReason,
          acceptedByOperator: false,
        });
        this.terminate(state, 'completed-needs-review', completionNeedsReviewReason);
        return;
      }

      if (pauseBecauseCompletionCannotBeVerified) {
        state.status = 'paused';
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused — completion requires operator review', { loopRunId: state.id });
        continue;
      }

      // -- post-iteration: critical no-progress → pause --
      // LF-7: a verified-done iteration (verify PASSED this iteration) must
      // never fall through to a no-progress pause. The loopfixex §12.1 failure
      // was "declare done + CRITICAL same iteration → pause forever". When
      // verify passes the loop is converging, not stuck; the rename-gate budget
      // above bounds any genuine oscillation. So only pause for no-progress
      // when this iteration did NOT pass verify.
      // Review-driven loops and cap wrap-up turns are exempt: both must be
      // allowed to reach their own terminal decision path instead of pausing.
      const suppressNoProgressForCapWrapUp = this.capWrapUpRuns.has(state.id) && checkLoopHardCaps(state) !== null;
      if (!reviewDriven && !suppressNoProgressForCapWrapUp && evaluation.verdict === 'CRITICAL' && iteration.verifyStatus !== 'passed') {
        // -- LF-5: branch-and-select before pausing (opt-in, default off) --
        // When exploration is enabled and a cost cap is set, fan out candidate
        // iterations, verify + select the best, and adopt the winner instead of
        // pausing. Any failure / no-winner / disabled path returns adopted:false
        // and we fall through to the normal pause.
        const explorationCfg = state.config.exploration ?? defaultLoopExplorationConfig();
        if (explorationCfg.enabled) {
          const branchResult = await this.branchSelector({
            loopRunId: state.id,
            workspaceCwd: state.config.workspaceCwd,
            goal: state.config.initialPrompt,
            exploration: explorationCfg,
            caps: state.config.caps,
            spentTokens: state.totalTokens,
            spentCents: state.totalCostCents,
            prompt,
            provider: state.config.provider,
            verifyCommand: state.config.completion.verifyCommand,
            verifyTimeoutMs: state.config.completion.verifyTimeoutMs,
            iterationTimeoutMs: state.config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS,
            phase4: state.config.phase4,
          }).catch((err) => {
            logger.warn('Branch-select threw; falling back to pause', {
              loopRunId: state.id,
              error: err instanceof Error ? err.message : String(err),
            });
            return { adopted: false, reason: 'branch-select threw', candidateCount: 0 } as Awaited<ReturnType<LoopBranchSelector>>;
          });
          this.emit('loop:branch-select', { loopRunId: state.id, seq, ...branchResult });
          logger.info('Loop branch-select outcome', {
            loopRunId: state.id,
            seq,
            adopted: branchResult.adopted,
            reason: branchResult.reason,
            candidates: branchResult.candidateCount,
          });
          if (branchResult.adopted) {
            // Winner adopted into the workspace — continue serially from it
            // instead of pausing for a human.
            await sleep(1500);
            continue;
          }
        }

        // -- LF-4: disposable plan — regenerate on stall before pausing --
        // RPI: "if the plan is wrong, throw it out; regeneration is one planning
        // loop, cheap vs. going in circles." Bounded so it can't loop forever.
        if (this.maybeRegeneratePlanOnStall(state, seq)) {
          await sleep(1500);
          continue;
        }

        const primary = evaluation.primary ?? evaluation.signals[0];
        state.status = 'paused';
        // LF-6: capture the dead-end signal as a learning before pausing.
        if (primary && !this.convergenceNotes.has(state.id)) {
          this.convergenceNotes.set(state.id, `no-progress: ${primary.message}`);
        }
        recordLoopLearningForState({
          state,
          status: 'no-progress',
          note: this.convergenceNotes.get(state.id),
          store: this.loopMemoryStore,
        });
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal: primary });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused — no-progress CRITICAL', { loopRunId: state.id, signal: primary });
        // loop continues after user resumes/cancels
      } else if (!reviewDriven && evaluation.verdict === 'CRITICAL') {
        logger.info('Suppressed no-progress pause', {
          loopRunId: state.id,
          seq,
          reason: suppressNoProgressForCapWrapUp ? 'cap-wrap-up' : 'verify-passed',
        });
      }

      // -- G3: next-objective planner (flag-gated, off by default) --
      // Only runs when the loop is still `running` (not paused/terminal) and
      // a planner is configured. The planner's output is injected as an
      // intervention for the next iteration. It can never produce a stop —
      // stop authority remains exclusively with evidence-resolver.
      const nextObjectivePlanner = this.nextObjectivePlanners.get(state.id);
      const planningCadence = state.config.nextObjectivePlanning?.enabled
        ? Math.max(1, state.config.nextObjectivePlanning.cadence)
        : 1;
      const shouldRunPlanner = nextObjectivePlanner
        && (state.config.nextObjectivePlanning?.enabled ? (seq + 1) % planningCadence === 0 : true);
      if (state.status === 'running' && !checkLoopHardCaps(state) && shouldRunPlanner) {
        try {
          const nextObj = await nextObjectivePlanner({
            lastOutput: childResult.output,
            originalGoal: state.config.initialPrompt,
            seq,
          });
          if (nextObj && typeof nextObj === 'string' && nextObj.trim()) {
            state.pendingInterventions.push(
              createLoopPendingInput(nextObj.trim(), { source: 'plan-regen' }),
            );
            logger.info('Next-objective planner injected focus', {
              loopRunId: state.id,
              seq,
              objectivePreview: nextObj.slice(0, 120),
            });
          }
        } catch (err) {
          logger.warn('Next-objective planner threw; skipping injection', {
            loopRunId: state.id,
            seq,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // -- minimum sleep guard so the fs watcher can settle --
      await sleep(1500);
    }
  }

  private async evaluateReviewDrivenCompletion(
    state: LoopState,
    iteration: LoopIteration,
    fullOutput: string,
    stageMachine: LoopStageMachine,
    seq: number,
    stage: LoopStage,
  ): Promise<{ status: 'completed' | 'completed-needs-review'; reason: string } | null> {
    return evaluateReviewDrivenCompletionGate({
      state,
      iteration,
      fullOutput,
      stageMachine,
      seq,
      stage,
      completionDetector: this.completionDetector,
      runFreshEyesReviewGate: (signalId, reviewIteration, verifyOutput) => this.runFreshEyesReviewGate(state, signalId, reviewIteration, verifyOutput),
      classifyCleanReview: this.cleanReviewClassifier,
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
  }
  private async evaluatePingPongCompletion(
    state: LoopState,
    iteration: LoopIteration,
    fullOutput: string,
    seq: number,
    stage: LoopStage,
  ): Promise<PingPongTerminal | null> {
    const reviewAbort = this.pingPongReviewAborts.create(state.id);
    try {
      return await evaluatePingPongCompletionGate({
        state,
        iteration,
        fullOutput,
        seq,
        stage,
        classifyCleanReview: this.cleanReviewClassifier,
        emit: (eventName, payload) => this.emit(eventName, payload),
        isCancelled: () => this.cancelFlags.get(state.id) === true || isParkedLoopRuntimeState(state),
        signal: reviewAbort.signal,
        foldReviewerSpend: (tokens, costCents) => {
          state.totalTokens += tokens; state.totalCostCents += costCents;
        },
        reviewer: this.pingPongReviewer,
        resolveSubject: this.pingPongSubjectResolver,
        runVerify: async () => {
          const v = await this.completionDetector.runVerify(state.config);
          applyVerifyOutcomeToIteration(iteration, v);
          return { ok: v.status !== 'failed', output: v.output };
        },
      });
    } finally {
      reviewAbort.cleanup();
    }
  }

  private async runFreshEyesReviewGate(
    state: LoopState,
    signalId: string,
    iteration: LoopIteration,
    verifyOutput: string,
  ): Promise<FreshEyesGateResult> {
    return runFreshEyesReviewGateHelper({
      state,
      signalId,
      iteration,
      verifyOutput,
      reviewer: this.freshEyesReviewer,
      emit: (eventName, payload) => this.emit(eventName, payload),
      setConvergenceNote: (note) => this.convergenceNotes.set(state.id, note),
    });
  }

  /**
   * F2 (#22): coordinator-enforced REVIEW→PLAN back-edge. See
   * `loop-review-backedge.ts` for the veto derivation and application.
   */
  private async enforceReviewBackEdge(
    state: LoopState,
    iteration: LoopIteration,
    stageMachine: LoopStageMachine,
    freshEyesGate: FreshEyesGateResult | null,
    seq: number,
  ): Promise<void> {
    await enforceReviewBackEdgeAction({
      state,
      iteration,
      stageMachine,
      freshEyesGate,
      seq,
      classifyCleanReview: this.cleanReviewClassifier,
      emit: (eventName, payload) => this.emit(eventName, payload),
      setConvergenceNote: (note) => this.convergenceNotes.set(state.id, note),
    });
  }

  // ============ Internal — child invocation (extensibility) ============

  private invokeChild(state: LoopState, prompt: string, stage: LoopStage, forceContextReset = false): Promise<LoopChildResult> {
    const control = this.loopControls.get(state.id);
    return invokeLoopChildIteration({
      emitter: this,
      state,
      prompt,
      stage,
      forceContextReset,
      downshiftModel: this.downshiftModelByLoop.get(state.id),
      loopControlEnv: control ? buildLoopControlEnv(control) : undefined,
      idempotencyKey: state.inFlightIteration?.idempotencyKey
        ?? this.iterationIdempotencyKey(state.id, state.totalIterations),
      // D2 (#6): the cap wrap-up turn runs with new-work tools disabled where
      // the provider supports enforcement (bookkeeping tools stay available —
      // the directive requires LOOP_TASKS.md/NOTES.md updates).
      disableTools: this.capWrapUpRuns.has(state.id),
    });
  }

  // ============ Internal — helpers ============

  private iterationIdempotencyKey(loopRunId: string, seq: number): string {
    return `${loopRunId}:iteration:${seq}`;
  }

  private async runPreIterationHooks(
    state: LoopState,
    inFlightIteration: NonNullable<LoopState['inFlightIteration']>,
  ): Promise<void> {
    for (const hook of this.preIterationHooks) {
      try {
        await hook({ state, inFlightIteration });
      } catch (err) {
        logger.warn('Pre-iteration hook threw; aborting child invocation', {
          loopRunId: state.id,
          seq: inFlightIteration.seq,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  private clearInFlightIteration(state: LoopState, seq: number): void {
    if (state.inFlightIteration?.seq === seq) {
      state.inFlightIteration = undefined;
    }
  }

  private appendLoopControlPrompt(state: LoopState, prompt: string): string {
    const loopControl = this.loopControls.get(state.id);
    if (!loopControl) return prompt;
    return `${prompt}\n${summarizeLoopControlPrompt(loopControl)}`;
  }

  private async importTerminalIntentsForBoundary(
    state: LoopState,
    options: { maxIterationSeq: number; exactIterationSeq?: number; terminalEligible: boolean },
  ): Promise<void> {
    await importTerminalIntentsForBoundaryHelper({
      state,
      loopControl: this.loopControls.get(state.id),
      options,
      isTerminalStatus: (status) => isTerminalLoopRuntimeStatus(status),
      isCancelled: (loopRunId) => this.cancelFlags.get(loopRunId) === true,
      emit: (eventName, payload) => this.emit(eventName, payload),
      transitionTerminalIntent: (targetState, intent, status, reason) =>
        this.transitionTerminalIntent(targetState, intent, status, reason),
      rememberTerminalIntent: (targetState, intent) => this.rememberTerminalIntent(targetState, intent),
      handleWakeupIntent: (targetState, intent) => this.handleWakeupIntent(targetState, intent),
      persistHook: this.intentPersistHook,
    });
  }

  private rememberTerminalIntent(state: LoopState, intent: LoopTerminalIntent): void {
    rememberLoopTerminalIntent(state, intent);
  }

  private transitionTerminalIntent(
    state: LoopState,
    intent: LoopTerminalIntent,
    status: LoopTerminalIntent['status'],
    reason: string,
  ): LoopTerminalIntent {
    const updated = cloneIntentWithStatus(intent, status, reason);
    this.rememberTerminalIntent(state, updated);
    if (state.terminalIntentPending?.id === intent.id) {
      state.terminalIntentPending = updated;
    }
    if (status === 'rejected') {
      this.emit('loop:terminal-intent-rejected', { loopRunId: state.id, intent: updated, reason });
    }
    return updated;
  }

  private rejectPendingCompleteIntent(state: LoopState, reason: string): void {
    if (state.terminalIntentPending?.kind !== 'complete') return;
    this.transitionTerminalIntent(state, state.terminalIntentPending, 'rejected', reason);
    state.terminalIntentPending = undefined;
  }

  private rejectCompletionAttempt(state: LoopState, reason: string, intervention: string): void {
    this.rejectPendingCompleteIntent(state, reason);
    state.pendingInterventions.push(createLoopPendingInput(intervention));
    // Record the obstacle so a later hard-cap stop can explain why the loop
    // never converged (see describeCapReason).
    this.convergenceNotes.set(state.id, reason);
  }

  private handleWakeupIntent(state: LoopState, intent: LoopTerminalIntent): LoopTerminalIntent | undefined {
    return scheduleWakeupIntent({
      state,
      intent,
      scheduledWakeups: this.scheduledWakeups,
      transitionTerminalIntent: (targetState, targetIntent, status, reason) =>
        this.transitionTerminalIntent(targetState, targetIntent, status, reason),
      scheduleWakeupResume: (targetState, opts) =>
        this.providerLimitHandler.scheduleWakeupResume(targetState, opts),
      setConvergenceNote: (loopRunId, note) => this.convergenceNotes.set(loopRunId, note),
      cloneStateForBroadcast: (targetState) => this.cloneStateForBroadcast(targetState),
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
  }

  private async handleFinalAuditBlockedCompletion(params: {
    state: LoopState;
    iteration: LoopIteration | undefined;
    finalAudit: LoopFinalAuditResult;
    stageMachine: LoopStageMachine;
    signal: string;
  }): Promise<'continue' | 'terminal'> {
    const result = await handleLoopFinalAuditBlockedCompletion({
      ...params,
      rejectPendingCompleteIntent: (state, reason) => this.rejectPendingCompleteIntent(state, reason),
      rejectCompletionAttempt: (state, reason, intervention) =>
        this.rejectCompletionAttempt(state, reason, intervention),
      setConvergenceNote: (loopRunId, note) => this.convergenceNotes.set(loopRunId, note),
      emitClaimedDoneButFailed: (payload) => this.emit('loop:claimed-done-but-failed', payload),
      emitCompletedNeedsReview: (payload) => this.emit('loop:completed-needs-review', payload),
      terminate: (state, status, reason) => this.terminate(state, status, reason),
    });
    if (result === 'continue') {
      this.emit('loop:state-changed', {
        loopRunId: params.state.id,
        state: this.cloneStateForBroadcast(params.state),
      });
    }
    return result;
  }

  private async pauseForBlockIntent(state: LoopState, intent: LoopTerminalIntent): Promise<void> {
    const loopControl = this.loopControls.get(state.id);
    // A3 (#29): a block-intent pause is waiting for operator input — sticky
    // state exempt from idle/stall kills until resumed.
    state.pausedForInput = true;
    await pauseForBlockIntentAction({
      state,
      intent,
      loopControlDir: loopControl?.controlDir,
      transitionTerminalIntent: (targetState, targetIntent, status, reason) =>
        this.transitionTerminalIntent(targetState, targetIntent, status, reason),
      setConvergenceNote: (loopRunId, note) => this.convergenceNotes.set(loopRunId, note),
      cloneStateForBroadcast: (targetState) => this.cloneStateForBroadcast(targetState),
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
  }

  private async moveBlockedFileAside(state: LoopState): Promise<void> {
    const loopControl = this.loopControls.get(state.id);
    await moveBlockedFileAsideHelper({
      state,
      loopControlDir: loopControl?.controlDir,
      warn: ({ errorCode, error }) => {
        logger.warn('Failed to move BLOCKED.md aside after override', {
          loopRunId: state.id,
          errorCode,
          error,
        });
      },
    });
  }

  private async waitWhilePaused(loopRunId: string): Promise<void> {
    // already pause-emitted by the caller; just wait until resumed.
    await new Promise<void>((resolve) => {
      this.pauseGates.set(loopRunId, { resolve });
    });
  }

  private terminate(state: LoopState, status: LoopState['status'], reason?: string): void {
    // Idempotent: if we're already in a terminal state we must not emit
    // duplicate cancelled/error events. Without this, a force-terminate from
    // `cancelLoop` followed by runLoop's own next-iter cancel check would
    // emit `loop:cancelled` twice and double-clean attachments.
    if (isTerminalLoopRuntimeState(state)) return;
    // Cancel any pending provider-limit auto-resume; this run is over.
    this.providerLimitHandler.clearResumeTimer(state.id);
    this.pingPongReviewAborts.abortTerminal(state.id, reason ?? status);
    this.downshiftModelByLoop.delete(state.id);
    this.capWrapUpRuns.delete(state.id);
    this.envelopeRewraps.delete(state.id);
    this.scheduledWakeups.delete(state.id);
    state.status = status;
    state.inFlightIteration = undefined;
    state.endedAt = Date.now();
    state.endReason = reason ?? status;
    state.endEvidence = {
      lastIterationSeq: state.totalIterations - 1,
      terminalIntent: state.terminalIntentHistory?.at(-1),
    };
    // Capture the agent's OUTSTANDING.md (Needs human / Open questions) so the
    // human-gated work is persisted + surfaced instead of being lost in the
    // hidden per-run state dir. Best-effort; failures never block termination.
    captureLoopOutstanding(state);
    // LF-6: distill a terminal learning BEFORE the convergence note is cleared.
    recordLoopLearningForState({
      state,
      status,
      note: this.convergenceNotes.get(state.id),
      store: this.loopMemoryStore,
    });
    const watcher = this.watchers.get(state.id);
    if (watcher) {
      void watcher.stop();
      this.watchers.delete(state.id);
    }
    this.runtimeContexts.delete(state.id);
    this.nextObjectivePlanners.delete(state.id);
    this.convergenceNotes.delete(state.id);
    this.planRegenerations.delete(state.id);
    this.pendingContextReset.delete(state.id);
    const loopControl = this.loopControls.get(state.id);
    this.loopControls.delete(state.id);
    if (status === 'cancelled') this.emit('loop:cancelled', { loopRunId: state.id });
    if (status === 'failed') this.emit('loop:failed', { loopRunId: state.id, reason: reason ?? 'failed' });
    if (status === 'error') this.emit('loop:error', { loopRunId: state.id, error: reason ?? 'unknown error' });
    this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop terminated', { loopRunId: state.id, status, reason });
    // Best-effort cleanup of any attachment files we wrote into the workspace.
    void cleanupLoopAttachments(state.config.workspaceCwd, state.id);
    void cleanupLoopControl(loopControl);
    // P2/P3: harvest uncommitted session output then reap the worktree.
    // Fire-and-forget (best-effort): worktree cleanup never blocks termination.
    const worktreeSessionId = this.worktreeSessionIds.get(state.id);
    this.worktreeSessionIds.delete(state.id);
    cleanupLoopWorktreeAfterTerminate({
      state,
      status,
      worktreeSessionId,
      terminalCleanupPromises: this.terminalCleanupPromises,
    });
    // A4: drop this run's evidence journal so the table stays compact. Evidence
    // is per-loop-run and only consumed within the run (contradiction
    // detection); a terminated run never resumes under the same id. Fail-soft.
    this.evidenceStore?.deleteForLoop(state.id);
    // FU-8: kick off the adapter-cleanup hook (CLI child teardown) and
    // remember the promise so `awaitTerminalCleanup` / `cancelLoop`
    // callers can wait on real shutdown. Hook errors are swallowed —
    // they're logged here so we don't propagate cleanup failures into
    // already-terminal loop control flow.
    const adapterCleanupHook = this.adapterCleanupHook;
    if (adapterCleanupHook) {
      const loopRunId = state.id;
      const cleanupPromise = Promise.resolve()
        .then(() => adapterCleanupHook(loopRunId))
        .catch((err) => {
          logger.warn('Loop adapter cleanup hook threw', {
            loopRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (this.terminalCleanupPromises.get(loopRunId) === cleanupPromise) {
            this.terminalCleanupPromises.delete(loopRunId);
          }
        });
      this.terminalCleanupPromises.set(loopRunId, cleanupPromise);
    }
  }

  private maybeRegeneratePlanOnStall(state: LoopState, seq: number): boolean {
    const done = this.planRegenerations.get(state.id) ?? 0;
    const regenerated = applyLoopPlanRegenerationOnStall({
      state,
      seq,
      done,
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
    if (!regenerated) {
      if (state.config.plan?.regenerateOnStall) {
        logger.info('Loop disposable-plan regeneration cap reached — pausing', {
          loopRunId: state.id,
          attempts: done,
        });
      }
      return false;
    }
    this.planRegenerations.set(state.id, done + 1);
    logger.info('Loop disposable-plan regeneration injected on stall', {
      loopRunId: state.id,
      seq,
      attempt: done + 1,
    });
    return true;
  }

  /** Deep-ish clone for safe broadcast — strips cycles and large arrays. */
  private cloneStateForBroadcast(s: LoopState): LoopState {
    return cloneLoopStateForBroadcast(s);
  }
}

function hasToolRwLockConflict(iteration: LoopIteration): boolean {
  return iteration.errors.some((error) => error.bucket === 'tool-rw-lock-conflict');
}

export function getLoopCoordinator(): LoopCoordinator {
  return LoopCoordinator.getInstance();
}
