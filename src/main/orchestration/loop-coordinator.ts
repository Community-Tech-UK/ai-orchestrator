/**
 * Loop Coordinator
 *
 * Per-chat-session "Ralph loop" with aggressive no-progress detection and
 * verify-before-stop completion. The default `contextStrategy` is
 * `same-session` (one persistent child CLI reused across iterations); LF-1
 * makes context discipline mandatory for it — the loop recycles its own
 * persistent adapter to a fresh session once context utilization crosses
 * `context.compaction.resetAtUtilization`, re-anchoring from durable disk
 * state. `fresh-child` remains a supported, lowest-context-rot option.
 * See docs/plans/loopfixex.md (LF-1). The coordinator itself never invokes
 * LLMs — it emits an extensibility event
 * `loop:invoke-iteration` with a callback, and a handler registered in
 * `src/main/index.ts` performs the actual provider invocation. This mirrors
 * `DebateCoordinator`'s pattern.
 *
 * Layered defenses (matches plan_loop_mode.md):
 *
 *   L1 hard caps          — iterations / wall-time / tokens / cost / per-iter tools
 *   L2 smart caps         — LoopProgressDetector signals A–H + escalation
 *   L3 completion         — LoopCompletionDetector signals 1–6 + verify-before-stop
 *   L4 safety             — destructive-op gate (declarative; enforced by caller)
 *   L5 observability      — events + iteration log
 *   L6 recovery           — caller persists state via LoopStore (Phase 3)
 *
 * The mantra holds: every loop-detection decision is made structurally
 * (hashes, frequencies, thresholds), never by asking the agent if it's stuck.
 */

import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'node:child_process';
import * as path from 'path';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';
import {
  defaultCrossModelReviewConfig,
  defaultLoopConfig,
  defaultSemanticProgressConfig,
  type LoopConfig,
  type LoopErrorRecord,
  type LoopFileChange,
  type LoopIteration,
  type LoopStage,
  type LoopState,
  type LoopStreamEvent,
  type LoopToolCallRecord,
  type CompletionSignalEvidence,
  type ProgressSignalEvidence,
  type LoopTerminalIntent,
  type LoopTerminalIntentEvidence,
} from '../../shared/types/loop.types';
import {
  LoopCompletionDetector,
  CompletedFileWatcher,
} from './loop-completion-detector';
import { LoopProgressDetector } from './loop-progress-detector';
import { LoopStageMachine } from './loop-stage-machine';
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
  commitImportedIntent,
  importLoopTerminalIntents,
  latestIntentByReceivedAt,
  listArchivedImportedIntents,
  prepareLoopControl,
  publicLoopControlMetadata,
  summarizeLoopControlPrompt,
  writeLoopControlFile,
  type LoopControlRuntime,
} from './loop-control';
import { computeWorkHash } from './loop-work-hash';
import { detectConvergeUntilCleanIntent } from './loop-intent';
import { collectWorkspaceDiff } from './loop-diff';
import {
  completedPlanWatchDirs,
  excerpt,
  jaccard,
  sleep,
  type VerifyOutcomeLike,
} from './loop-coordinator-utils';
import { resolveCompletion } from './evidence-resolver';
import {
  computeReviewThreadSet,
  diffReviewThreads,
  computeCompletionEvidenceHash,
  pushBoundedEvidence,
} from './review-thread-fingerprint';
import {
  defaultFreshEyesReviewer,
  type FreshEyesReviewer,
  type FreshEyesReviewerResult,
} from './loop-fresh-eyes-reviewer';
import {
  defaultSemanticProgressReviewer,
  findPreviousSemanticResult,
  reconcileSemanticVerdict,
  shouldRunSemanticCheck,
  type LoopSemanticProgressReviewer,
} from './loop-semantic-progress';
import {
  defaultBranchSelector,
  type LoopBranchSelector,
} from './loop-branch-select';
import {
  defaultLoopMemoryStore,
  distillLearning,
  type LoopMemoryStore,
} from './loop-memory';
import { defaultLoopExplorationConfig, LOOP_MAX_PLAN_REGENERATIONS } from '../../shared/types/loop.types';
import { streamLoopEvents } from './loop-stream';

export { computeWorkHash } from './loop-work-hash';
export type {
  FreshEyesFinding,
  FreshEyesReviewer,
  FreshEyesReviewerInput,
  FreshEyesReviewerResult,
  FreshEyesSeverity,
} from './loop-fresh-eyes-reviewer';

const logger = getLogger('LoopCoordinator');
const execFileAsync = promisify(execFile);

/** Approximate Claude Sonnet cost in cents per 1M tokens, rounded up. */
const COST_PER_M_TOKENS_CENTS = 1500;
const DEFAULT_ITERATION_TIMEOUT_MS = 30 * 60 * 1000;

/** Result the LLM-invocation handler must return to the coordinator. */
export interface LoopChildResult {
  /** Unique id of the child instance (for observability / linking). */
  childInstanceId: string | null;
  /** Full text the agent emitted during the iteration. */
  output: string;
  /** Token usage. */
  tokens: number;
  /** Files changed during the iteration (already diffed by the caller). */
  filesChanged: LoopFileChange[];
  /** Tool calls observed during the iteration. */
  toolCalls: LoopToolCallRecord[];
  /** Errors classified during the iteration. */
  errors: LoopErrorRecord[];
  /** Test pass count after the iteration (or null if no tests run). */
  testPassCount: number | null;
  /** Test fail count after the iteration (or null if no tests run). */
  testFailCount: number | null;
  /** Did the child exit cleanly? */
  exitedCleanly: boolean;
  /**
   * LF-1: set by the invoker when it recycled the loop's persistent
   * same-session adapter to a fresh session after this iteration (context
   * utilization crossed the configured threshold). The coordinator emits
   * `loop:context-compacted` and records an ITERATION_LOG note.
   */
  contextCompacted?: { previousUtilization: number; newUtilization: number; reason: string };
}

interface PauseGate { resolve: () => void }

/**
 * Result of the fresh-eyes cross-model review gate. `ran`/`errored` let the
 * evidence resolver tell a clean review verdict apart from a reviewer that was
 * never run (disabled) or whose infrastructure failed — the distinction is
 * load-bearing for no-verify loops, where the review IS the completion
 * authority and an infra failure must not be mistaken for a clean pass.
 */
interface FreshEyesGateResult {
  /** A blocking finding was raised — the loop must continue. */
  blocked: boolean;
  /** The reviewer was invoked (review enabled and attempted). */
  ran: boolean;
  /** The reviewer threw / infrastructure was unavailable. */
  errored: boolean;
}

/**
 * Listener-of-listeners for completed loops. Allows callers (e.g. the
 * persistence layer) to react after an iteration is fully recorded but
 * before the loop emits its public events.
 */
interface IterationHookContext {
  state: LoopState;
  iteration: LoopIteration;
}

export type LoopIterationHook = (ctx: IterationHookContext) => Promise<void> | void;

/**
 * Hook for durable persistence of terminal intents. Called by the
 * coordinator *before* the source intent file is archived from
 * `<controlDir>/intents/` to `<controlDir>/imported/`. The hook must
 * throw on failure so the coordinator can leave the source file in
 * place for the next boundary to retry. See NB2 in the spec at
 * `docs/plans/2026-05-12-loop-terminal-control-spec.md`.
 */
export type LoopIntentPersistHook = (intent: LoopTerminalIntent) => Promise<void> | void;

/**
 * Hook for tearing down per-loop CLI adapters when a loop reaches a
 * terminal state. The coordinator awaits this hook (via
 * `awaitTerminalCleanup`) before reporting the loop as fully shut
 * down. Registered once per coordinator by the default invoker so
 * that long-running CLI children aren't orphaned when the loop
 * cancels mid-iteration. See FU-8 in
 * `docs/plans/2026-05-26-loop-mode-reliability.md`.
 */
export type LoopAdapterCleanupHook = (loopRunId: string) => Promise<void>;

export interface LoopRuntimeContext {
  /**
   * Prior visible-session transcript used as read-only background for loop
   * children. Kept outside LoopState/config so it is not shown as the user's
   * goal or persisted as loop configuration.
   */
  existingSessionContext?: string;
  /**
   * LF-6: prior-run observations surfaced from cross-loop memory at startLoop,
   * injected into each iteration prompt (token-bounded, "not binding").
   */
  priorObservations?: string[];
}

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
  private runtimeContexts = new Map<string, LoopRuntimeContext>();
  private loopControls = new Map<string, LoopControlRuntime>();
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
      this.instance.runtimeContexts.clear();
      this.instance.loopControls.clear();
      this.instance.iterationHooks = [];
      this.instance.intentPersistHook = null;
      this.instance.adapterCleanupHook = null;
      this.instance.terminalCleanupPromises.clear();
      this.instance.removeAllListeners();
      this.instance = null;
    }
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
    const config = this.materializeConfig(partialConfig);
    if (!config.initialPrompt.trim()) throw new Error('initialPrompt is required');
    if (!config.workspaceCwd.trim()) throw new Error('workspaceCwd is required');

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
      if (existing.status === 'running' || existing.status === 'paused') {
        throw new Error(
          `A loop is already ${existing.status} for this chat (id ${existing.id}). ` +
          'Cancel it before starting a new one.',
        );
      }
    }

    const id = `loop-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

    const stageMachine = new LoopStageMachine(config.workspaceCwd);
    const initialStage = await stageMachine.bootstrap(config);

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
      unresolvedReviewThreads: [],
      recentEvidenceHashes: [],
      repeatedEvidenceCount: 0,
    };
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

    // Wire watcher to mutate state.
    watcher.onCompleted((filePath) => {
      state.completedFileRenameObserved = true;
      logger.info('CompletedFileWatcher fired', { id, filePath });
      this.emit('loop:completed-file-observed', { loopRunId: id, filePath });
    });
    // FU-9: if the operator reverts the rename (or deletes the completed
    // file), clear the observation so the rename gate re-evaluates on the
    // next completion attempt. Without this, a premature rename followed
    // by an undo leaves the loop convinced completion already happened.
    watcher.onUndone((filePath) => {
      if (!state.completedFileRenameObserved) return;
      state.completedFileRenameObserved = false;
      logger.info('CompletedFileWatcher undone', { id, filePath });
      this.emit('loop:completed-file-undone', { loopRunId: id, filePath });
    });

    this.emit('loop:started', { loopRunId: id, chatId });
    this.emit('loop:state-changed', { loopRunId: id, state: this.cloneStateForBroadcast(state) });

    // Run the loop in the background. Errors propagate via 'loop:error'.
    void this.runLoop(state, stageMachine).catch((err) => {
      logger.error('Loop runtime error', err instanceof Error ? err : new Error(String(err)), { loopRunId: id });
      this.terminate(state, 'error', err instanceof Error ? err.message : String(err));
    });

    return state;
  }

  /** Pause the loop. Iteration in-flight finishes; next pre-flight blocks. */
  pauseLoop(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'running') return false;
    state.status = 'paused';
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop paused (manual)', { loopRunId });
    return true;
  }

  /** Resume a paused loop. */
  resumeLoop(loopRunId: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'paused') return false;
    state.status = 'running';
    const gate = this.pauseGates.get(loopRunId);
    if (gate) {
      gate.resolve();
      this.pauseGates.delete(loopRunId);
    }
    this.emit('loop:state-changed', { loopRunId, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop resumed', { loopRunId });
    return true;
  }

  /** Queue a user-supplied hint for the next iteration. */
  intervene(loopRunId: string, message: string): boolean {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'running' && state.status !== 'paused') return false;
    state.pendingInterventions.push(message);
    this.emit('loop:intervention-applied', { loopRunId, message });
    logger.info('Loop intervention queued', { loopRunId, length: state.pendingInterventions.length });
    return true;
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
    if (this.isTerminalStatus(state.status)) return false;
    this.cancelFlags.set(loopRunId, true);
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
    return true;
  }

  /**
   * LF-7 — operator accepts a paused, done-but-ungated run. This is the missing
   * "accept completion" action that previously left manual-review loops stuck
   * paused forever (loopfixex §12.2 #1): the renderer only exposed
   * start/pause/resume/intervene/cancel, so a loop with no verify command could
   * never reach a clean terminal state from the UI.
   *
   * Valid only when the loop is `paused` AND it is awaiting review
   * (`manualReviewOnly`) or has a pending `complete` terminal intent. When a
   * verify command exists, it is run once: pass → terminate `completed`,
   * fail → reject (stay paused, surface the failure). With no verify command,
   * terminate `completed-needs-review`. Returns true iff the loop terminated.
   */
  async acceptCompletion(loopRunId: string): Promise<boolean> {
    const state = this.active.get(loopRunId);
    if (!state) return false;
    if (state.status !== 'paused') {
      logger.info('acceptCompletion ignored — loop is not paused', { loopRunId, status: state.status });
      return false;
    }
    const eligible =
      state.manualReviewOnly || state.terminalIntentPending?.kind === 'complete';
    if (!eligible) {
      logger.info('acceptCompletion ignored — loop is not awaiting review', {
        loopRunId,
        manualReviewOnly: state.manualReviewOnly,
        pendingKind: state.terminalIntentPending?.kind,
      });
      return false;
    }

    const hasVerifyCommand = !!state.config.completion.verifyCommand.trim();
    if (hasVerifyCommand) {
      const verify = await this.completionDetector.runVerify(state.config);
      // A re-entrant terminate (e.g. operator hit Stop while verify ran) means
      // the loop is already gone — bail without overriding its terminal status.
      if (this.isTerminalStatus(state.status)) return false;
      if (verify.status === 'failed') {
        state.lastCompletionOutcome = 'verify-failed';
        this.convergenceNotes.set(state.id, 'operator-accept verify failed');
        if (state.lastIteration) {
          state.lastIteration.verifyStatus = 'failed';
          state.lastIteration.verifyOutputExcerpt = excerpt(verify.output);
        }
        this.emit('loop:claimed-done-but-failed', {
          loopRunId: state.id,
          signal: 'declared-complete',
          failure:
            'Operator accept was rejected because the verify command failed:\n\n' +
            (excerpt(verify.output, 8192) || '(verify produced no output)'),
        });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        return false;
      }
      // verify passed → clean completion
      if (state.terminalIntentPending?.kind === 'complete') {
        this.transitionTerminalIntent(state, state.terminalIntentPending, 'accepted', 'operator accepted completion');
        state.terminalIntentPending = undefined;
      }
      state.lastCompletionOutcome = 'accepted';
      if (state.lastIteration) {
        state.lastIteration.verifyStatus = 'passed';
        state.lastIteration.verifyOutputExcerpt = excerpt(verify.output);
      }
      this.emit('loop:completed', {
        loopRunId: state.id,
        signal: 'declared-complete',
        verifyOutput: excerpt(verify.output, 4096),
        acceptedByOperator: true,
      });
      this.terminate(state, 'completed', 'operator accepted completion (verify passed)');
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

  private isTerminalStatus(status: LoopState['status']): boolean {
    return (
      status === 'completed' ||
      status === 'completed-needs-review' ||
      status === 'cancelled' ||
      status === 'failed' ||
      status === 'cap-reached' ||
      status === 'error' ||
      status === 'no-progress'
    );
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
    while (true) {
      // -- pause / cancel / cap pre-flight --
      // If the state was already terminated externally (e.g. cancelLoop
      // force-terminating because the in-flight iteration was hung), exit
      // immediately. terminate() is idempotent so the no-op is safe even
      // if we still call it.
      if (this.isTerminalStatus(state.status) || this.cancelFlags.get(state.id)) {
        this.terminate(state, 'cancelled');
        return;
      }
      if (state.status === 'paused') {
        await this.waitWhilePaused(state.id);
        if (this.cancelFlags.get(state.id)) {
          this.terminate(state, 'cancelled');
          return;
        }
      }
      const capHit = this.checkHardCaps(state);
      if (capHit) {
        const reason = this.describeCapReason(state, capHit);
        this.emit('loop:cap-reached', { loopRunId: state.id, cap: capHit, reason });
        this.terminate(state, 'cap-reached', reason);
        return;
      }
      await this.importTerminalIntentsForBoundary(state, {
        maxIterationSeq: state.totalIterations,
        terminalEligible: state.status === 'running',
      });
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
      const blockedFile = await this.readBlockedFileIfPresent(state.config.workspaceCwd);
      if (blockedFile && state.status === 'running') {
        const probeCfg = state.config.blockSanityProbe;
        const probeEnabled = probeCfg?.enabled !== false; // default-on when undefined
        let failedProbeDetail: string | undefined;
        if (probeEnabled && this.isToolchainClassBlock(blockedFile.message, [])) {
          const probe = await this.runWorkspaceLivenessProbe(
            state.config.workspaceCwd,
            probeCfg?.timeoutMs ?? 5000,
          );
          if (probe.alive) {
            state.pendingInterventions.push(this.blockOverrideInterventionText());
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

      // -- pre-iteration kill switch --
      const history = this.histories.get(state.id) ?? [];
      const block = this.progressDetector.shouldRefuseToSpawnNext(state, history);
      if (block) {
        // LF-4: when disposable-plan regeneration is enabled and budget remains,
        // bypass the kill switch (spawn an iteration so the post-iteration
        // CRITICAL path can inject ONE regenerate directive) rather than pause.
        // This is a READ-ONLY check — the single increment + directive happens
        // in `maybeRegeneratePlanOnStall` at the post-iteration site, so a stall
        // never burns two of the cap budget in one pass.
        if (this.canRegeneratePlanOnStall(state)) {
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
      const prompt = this.appendLoopControlPrompt(state, stageMachine.buildPrompt({
        config: state.config,
        iterationSeq: seq,
        pendingInterventions: state.pendingInterventions,
        existingSessionContext: this.runtimeContexts.get(state.id)?.existingSessionContext,
        priorObservations: this.runtimeContexts.get(state.id)?.priorObservations,
        uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
        manualReviewOnly: state.manualReviewOnly && !crossModelReviewEnabled,
      }));
      // The buildPrompt() call above embedded the pending interventions into
      // the iteration prompt, so we can clear the queue. (Previous revisions
      // captured the consumed list for a lockout decision that no longer
      // exists — Task 2 in the 2026-05-26 loop-mode-reliability plan
      // removed it.)
      state.pendingInterventions.length = 0;

      this.emit('loop:iteration-started', { loopRunId: state.id, seq, stage });

      let childResult: LoopChildResult | null = null;
      let invocationError: string | null = null;
      // LF-4 RPI: consume a one-shot PLAN→IMPLEMENT context reset request.
      let forceContextReset = this.pendingContextReset.delete(state.id);

      // Degraded-iteration resilience: a single transient invocation failure or a
      // "void" iteration (no output, no files, no tool calls) should not kill a
      // long loop or be miscounted as no-progress. Retry the SAME seq a bounded
      // number of times with a fresh session before falling through to the
      // existing error / normal-processing path. Disabled → exactly one attempt.
      const retryCfg = state.config.degradedIterationRetry;
      const maxRetries = retryCfg?.enabled === false ? 0 : Math.max(0, retryCfg?.maxRetries ?? 2);
      for (let attempt = 0; ; attempt++) {
        childResult = null;
        invocationError = null;
        try {
          childResult = await this.invokeChild(state, prompt, stage, forceContextReset);
        } catch (err) {
          invocationError = err instanceof Error ? err.message : String(err);
          logger.error('Iteration invocation failed', err instanceof Error ? err : new Error(invocationError), { loopRunId: state.id, seq, attempt });
        } finally {
          await this.importTerminalIntentsForBoundary(state, {
            maxIterationSeq: seq,
            exactIterationSeq: seq,
            terminalEligible: state.status === 'running',
          });
        }

        // Never retry over a filed terminal intent (block/complete/fail) — hand
        // off to the normal terminal-intent flow. Also stop if the loop was
        // cancelled/terminated mid-attempt, or the retry budget is spent.
        if (state.terminalIntentPending) break;
        if (this.isTerminalStatus(state.status) || this.cancelFlags.get(state.id)) break;
        if (attempt >= maxRetries) break;

        const degraded = this.classifyDegradedIteration(childResult, invocationError);
        if (!degraded) break;

        this.emit('loop:activity', {
          loopRunId: state.id,
          seq,
          stage,
          timestamp: Date.now(),
          kind: 'status',
          message: `Degraded iteration (${degraded}) — retrying with a fresh session (attempt ${attempt + 2}/${maxRetries + 1})`,
          detail: { reason: degraded, invocationError: invocationError ?? undefined },
        });
        logger.warn('Retrying degraded loop iteration', { loopRunId: state.id, seq, attempt, reason: degraded });
        // Force a fresh session on retry so a wedged same-session adapter recycles.
        forceContextReset = true;
      }
      if (!childResult) {
        if (state.terminalIntentPending) {
          childResult = this.syntheticChildResultFromTerminalIntent(state.terminalIntentPending, invocationError);
        } else {
          this.terminate(state, 'error', invocationError ?? 'iteration invocation failed');
          return;
        }
      }

      // If the loop was cancelled (or terminated otherwise) while the
      // iteration was in flight, drop the result silently. Don't accumulate
      // stats, don't emit iteration-complete, don't run progress detection
      // — the loop is over from the user's perspective.
      if (this.isTerminalStatus(state.status) || this.cancelFlags.get(state.id)) {
        logger.info('Iteration completed after loop was cancelled — dropping result', {
          loopRunId: state.id,
          seq,
        });
        return;
      }

      // -- assemble iteration record --
      const iterEnd = Date.now();
      const tokens = childResult.tokens;
      const costCents = Math.ceil((tokens / 1_000_000) * COST_PER_M_TOKENS_CENTS);

      const prevIter = history[history.length - 1];
      const outputExcerpt = excerpt(childResult.output);
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
        toolCalls: childResult.toolCalls,
        errors: childResult.errors,
        testPassCount: childResult.testPassCount,
        testFailCount: childResult.testFailCount,
        workHash,
        outputSimilarityToPrev: outputSimToPrev,
        outputExcerpt,
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      };

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
      // A cheap model check that confirms/softens the structural verdict. It is
      // cadence-gated, requires two consecutive confident checks to flip a
      // verdict, and is NEVER a sole stop/continue authority. Runs BEFORE the
      // WARN-tracking and CRITICAL-pause below so any flip propagates downstream.
      const semCfg = state.config.semanticProgress ?? defaultSemanticProgressConfig();
      if (
        shouldRunSemanticCheck({
          enabled: semCfg.enabled,
          structuralVerdict: evaluation.verdict,
          seq,
          cadence: semCfg.cadence,
        })
      ) {
        try {
          // LF-2: ground the reviewer in the loop's declared remaining work
          // (NOTES.md tail — the completion inventory + recent summaries) so it
          // compares against intent, not just the raw diff. Best-effort.
          let progressContext: string | undefined;
          try {
            const notes = await stageMachine.readNotes();
            if (notes.trim()) progressContext = notes.slice(-2000);
          } catch { /* notes unreadable — reviewer still runs without grounding */ }
          const semantic = await this.semanticProgressReviewer({
            goal: state.config.initialPrompt,
            workspaceCwd: state.config.workspaceCwd,
            filesChangedThisIteration: iteration.filesChanged.map((f) => f.path),
            iterationOutput: iteration.outputExcerpt,
            progressContext,
            config: semCfg,
          });
          iteration.semanticProgress = semantic;
          const reconciled = reconcileSemanticVerdict({
            structuralVerdict: evaluation.verdict,
            structuralSignals: evaluation.signals,
            current: semantic,
            previous: findPreviousSemanticResult(history),
            confidenceFloor: semCfg.confidenceFloor,
          });
          if (reconciled.changed) {
            logger.info('Loop semantic-progress modifier applied', {
              loopRunId: state.id,
              seq,
              from: evaluation.verdict,
              to: reconciled.verdict,
              advanced: semantic.advanced,
              confidence: semantic.confidence,
              reason: reconciled.reason,
            });
            this.emit('loop:semantic-progress', {
              loopRunId: state.id,
              seq,
              advanced: semantic.advanced,
              confidence: semantic.confidence,
              from: evaluation.verdict,
              to: reconciled.verdict,
              reason: reconciled.reason,
            });
            evaluation.verdict = reconciled.verdict;
            iteration.progressVerdict = reconciled.verdict;
          }
        } catch (err) {
          logger.warn('Semantic progress check failed; leaving structural verdict unchanged', {
            loopRunId: state.id,
            seq,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
      if (this.completionDetector.hasSufficientSignal(completionSignals)) {
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
        iteration.verifyStatus = v1.status === 'skipped' ? 'not-run' : v1.status;
        iteration.verifyOutputExcerpt = excerpt(v1.output);
        verifyOutputForEmit = v1.output;

        // anti-flake: optionally run verify a second time before checking secondary gates
        let v2: VerifyOutcomeLike = v1;
        if (v1.status === 'passed' && state.config.completion.runVerifyTwice) {
          v2 = await this.completionDetector.runVerify(state.config);
          if (v2.status === 'failed') {
            iteration.verifyStatus = 'failed';
            iteration.verifyOutputExcerpt = excerpt(v2.output);
            verifyOutputForEmit = v2.output;
          }
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
        });

        // --- map resolution to coordinator actions ---
        state.lastCompletionOutcome = resolution.outcome ?? state.lastCompletionOutcome;

        // claude2_todo #1c: record this attempt's *evidence hash* into a bounded
        // ring buffer. Identical evidence (same trigger signal, same verify
        // outcome, same belt-and-braces state, same unresolved review threads)
        // re-presented across attempts climbs `repeatedEvidenceCount`; the count
        // only resets when the evidence actually changes — so unchanged weak
        // evidence can't masquerade as progress. We surface a stuck-evidence
        // note (it feeds describeCapReason) when the same evidence repeats.
        const evidenceHash = computeCompletionEvidenceHash({
          candidateId: candidate.id,
          verifyStatus: v2.status,
          beltAndBracesPassed,
          unresolvedReviewThreads: state.unresolvedReviewThreads ?? [],
        });
        const evidence = pushBoundedEvidence(state.recentEvidenceHashes, evidenceHash);
        state.recentEvidenceHashes = evidence.buffer;
        state.repeatedEvidenceCount = evidence.repeatCount;
        if (resolution.decision === 'continue' && evidence.repeatCount >= 2) {
          const stuck =
            `the same completion evidence has now been presented ${evidence.repeatCount} times without change`;
          const existingNote = this.convergenceNotes.get(state.id);
          this.convergenceNotes.set(state.id, existingNote ? `${existingNote}; ${stuck}` : stuck);
          logger.info('Loop completion attempt re-presented identical evidence', {
            loopRunId: state.id,
            signal: candidate.id,
            repeatCount: evidence.repeatCount,
            outcome: resolution.outcome,
          });
        }

        if (resolution.decision === 'stop') {
          stopWithSignal = candidate;
        } else if (resolution.decision === 'stop-needs-review') {
          // rename-gate budget exhausted; fall through to post-log terminal handling
          completionNeedsReviewReason = resolution.needsReviewReason!;
        } else if (resolution.decision === 'pause-operator-review') {
          // verify was skipped — no verify command configured
          this.rejectPendingCompleteIntent(
            state,
            'completion not verified — no verify command configured',
          );
          this.emit('loop:claimed-done-but-failed', {
            loopRunId: state.id,
            signal: candidate.id,
            failure:
              'Completion cannot be confirmed: no verify command is configured, so the loop ' +
              'has no independent way to check the work is actually done. Configure a verify ' +
              'command (your test / lint / build command) before starting a loop that should ' +
              'auto-complete, or inspect the reported evidence and stop the loop manually.',
          });
          state.pendingInterventions.push(
            'Your completion was NOT accepted. This loop has no verify command configured, ' +
              'so it cannot independently confirm the work is finished. Do not simply ' +
              're-declare completion — it will be rejected again. The loop is pausing for ' +
              'operator review because only the operator can decide whether your reported ' +
              'verification evidence is sufficient without an independent verify command.',
          );
          this.convergenceNotes.set(state.id, resolution.convergenceNote ?? 'completion was unverifiable (no verify command configured)');
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
                'Your completion was rejected because the anti-flake second verify run failed. ' +
                  'Fix these errors before re-declaring completion:\n\n' +
                  (excerpt(v2.output, 8192) || '(second verify produced no output)'),
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
                `Your completion was rejected because the ${friendlyLabel} command failed. ` +
                  'Fix these errors before re-declaring completion:\n\n' +
                  (excerpt(failedVerifyOutput, 8192) || `(${friendlyLabel} produced no output)`),
              );
              this.emit('loop:claimed-done-but-failed', {
                loopRunId: state.id,
                signal: candidate.id,
                failure: excerpt(failedVerifyOutput, 4096),
              });
            }
          } else if (resolution.outcome === 'review-blocked') {
            // Fresh-eyes review blocked — convergenceNote set by runFreshEyesReviewGate
            this.rejectPendingCompleteIntent(state, 'fresh-eyes review blocked completion');
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

      for (const hook of this.iterationHooks) {
        try { await hook({ state, iteration }); } catch (err) {
          logger.warn('Iteration hook threw', { error: String(err) });
        }
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
        logger.info('Loop paused — completion cannot be verified without a verify command', { loopRunId: state.id });
        continue;
      }

      // -- post-iteration: critical no-progress → pause --
      // LF-7: a verified-done iteration (verify PASSED this iteration) must
      // never fall through to a no-progress pause. The loopfixex §12.1 failure
      // was "declare done + CRITICAL same iteration → pause forever". When
      // verify passes the loop is converging, not stuck; the rename-gate budget
      // above bounds any genuine oscillation. So only pause for no-progress
      // when this iteration did NOT pass verify.
      if (evaluation.verdict === 'CRITICAL' && iteration.verifyStatus !== 'passed') {
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
        this.recordLoopLearning(state, 'no-progress');
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal: primary });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused — no-progress CRITICAL', { loopRunId: state.id, signal: primary });
        // loop continues after user resumes/cancels
      } else if (evaluation.verdict === 'CRITICAL') {
        logger.info('Suppressed no-progress pause — iteration verify passed (converging, not stuck)', {
          loopRunId: state.id,
          seq,
        });
      }

      // -- minimum sleep guard so the fs watcher can settle --
      await sleep(1500);
    }
  }

  /**
   * Run the cross-model fresh-eyes review gate. Returns `true` if any
   * blocking finding was raised — meaning the loop must continue instead
   * of stopping. Returns `false` if the review either:
   *   - is disabled in config
   *   - returned no blocking findings
   *   - failed to find any reviewers (infrastructure unavailable)
   *
   * When blocking findings are raised, they are injected verbatim into
   * `state.pendingInterventions` so the next iteration treats them as
   * binding direction.
   */
  private async runFreshEyesReviewGate(
    state: LoopState,
    signalId: string,
    iteration: LoopIteration,
    verifyOutput: string,
  ): Promise<FreshEyesGateResult> {
    const reviewCfg = state.config.completion.crossModelReview;
    if (!reviewCfg || !reviewCfg.enabled) {
      return { blocked: false, ran: false, errored: false };
    }

    this.emit('loop:fresh-eyes-review-started', { loopRunId: state.id, signal: signalId });

    // Scope the review to the actual change (git diff vs HEAD + untracked
    // files), not the agent's transcript. This is the reviewer's ground
    // truth and is far smaller than a full conversation, so it avoids the
    // review-payload truncation that previously starved reviewers of context.
    const workspaceDiff = collectWorkspaceDiff(state.config.workspaceCwd);
    const iterationFiles = iteration.filesChanged.map((f) => f.path);
    const filesChangedThisIteration = iterationFiles.length > 0
      ? iterationFiles
      : workspaceDiff.changedFiles;

    let reviewResult: FreshEyesReviewerResult;
    try {
      reviewResult = await this.freshEyesReviewer({
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
      // Reviewer threw — don't pretend the gate held; log and let the loop
      // stop. We deliberately do NOT block on reviewer failures because
      // that would let a misconfigured reviewer pin the loop open forever.
      logger.warn('Fresh-eyes reviewer threw — letting completion proceed', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit('loop:fresh-eyes-review-failed', {
        loopRunId: state.id,
        signal: signalId,
        error: err instanceof Error ? err.message : String(err),
      });
      // ran=true but errored=true: a verify-gated loop treats this as
      // non-blocking (verify carries completion), but a no-verify loop has no
      // independent authority, so the resolver pauses for an operator instead
      // of stopping on self-declared evidence.
      return { blocked: false, ran: true, errored: true };
    }

    const blocking = reviewResult.findings.filter((f) =>
      (reviewCfg.blockingSeverities as readonly string[]).includes(f.severity),
    );

    if (blocking.length === 0) {
      // The unresolved-review-thread set has emptied — the ONLY condition under
      // which the loop may converge on the review axis (claude2_todo #1b).
      state.unresolvedReviewThreads = [];
      this.emit('loop:fresh-eyes-review-passed', {
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

    // claude2_todo #1b: fingerprint the blocking review threads so we can tell a
    // PERSISTING issue (the agent failed to fix it across rounds) from a newly
    // raised one, and so the unresolved set survives a re-run that surfaces the
    // same findings. Persisted across attempts; only emptied on a clean review.
    const prevThreads = state.unresolvedReviewThreads ?? [];
    const currThreads = computeReviewThreadSet(blocking);
    const threadDiff = diffReviewThreads(prevThreads, currThreads);
    state.unresolvedReviewThreads = currThreads;

    const persistenceNote =
      threadDiff.persisted.length > 0
        ? `\n\n⚠ ${threadDiff.persisted.length} of these ` +
          `${threadDiff.persisted.length === 1 ? 'finding has' : 'findings have'} persisted UNRESOLVED ` +
          'across review rounds. Re-running the same change will be rejected again — actually fix ' +
          'them (or change approach) before re-declaring completion.'
        : '';

    // Blocking findings — inject as interventions and continue the loop.
    const interventionMessage =
      `Fresh-eyes cross-model review (${reviewResult.reviewersUsed.join(', ') || 'reviewers'}) ` +
      `blocked completion with ${blocking.length} ${blocking.length === 1 ? 'issue' : 'issues'} ` +
      `(severities: ${[...new Set(blocking.map((f) => f.severity))].join(', ')}):\n\n` +
      blocking
        .map(
          (f, i) =>
            `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file})` : ''}\n   ${f.body}`,
        )
        .join('\n\n') +
      persistenceNote +
      `\n\nAddress each item, then re-attempt completion.`;

    state.pendingInterventions.push(interventionMessage);
    this.convergenceNotes.set(
      state.id,
      `${blocking.length} blocking review finding(s) remained` +
        (threadDiff.persisted.length > 0
          ? `, ${threadDiff.persisted.length} unresolved across multiple rounds`
          : '') +
        (reviewResult.reviewersUsed.length > 0 ? ` (reviewers: ${reviewResult.reviewersUsed.join(', ')})` : ''),
    );
    this.emit('loop:fresh-eyes-review-blocked', {
      loopRunId: state.id,
      signal: signalId,
      reviewersUsed: reviewResult.reviewersUsed,
      blockingFindings: blocking,
      summary: reviewResult.summary,
    });
    logger.info('Fresh-eyes review blocked completion — injected interventions', {
      loopRunId: state.id,
      signal: signalId,
      blocking: blocking.length,
      severities: [...new Set(blocking.map((f) => f.severity))],
    });
    return { blocked: true, ran: true, errored: false };
  }

  // ============ Internal — child invocation (extensibility) ============

  private invokeChild(state: LoopState, prompt: string, stage: LoopStage, forceContextReset = false): Promise<LoopChildResult> {
    if (this.listenerCount('loop:invoke-iteration') === 0) {
      throw new Error(
        'No handler registered for loop:invoke-iteration. ' +
        'Register one in src/main/index.ts to wire LLM invocation.'
      );
    }
    return new Promise<LoopChildResult>((resolve, reject) => {
      let settled = false;
      const correlationId = `${state.id}::${state.totalIterations}`;
      const iterationTimeoutMs = Math.max(
        1,
        state.config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS,
      );
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Loop iteration timed out after ${iterationTimeoutMs}ms`));
      }, iterationTimeoutMs);

      this.emit('loop:invoke-iteration', {
        correlationId,
        loopRunId: state.id,
        chatId: state.chatId,
        provider: state.config.provider,
        workspaceCwd: state.config.workspaceCwd,
        stage,
        seq: state.totalIterations,
        config: state.config,
        prompt,
        loopControlEnv: this.loopControls.has(state.id)
          ? buildLoopControlEnv(this.loopControls.get(state.id)!)
          : undefined,
        iterationTimeoutMs: state.config.iterationTimeoutMs,
        streamIdleTimeoutMs: state.config.streamIdleTimeoutMs,
        // LF-4 RPI: recycle the same-session context before this iteration runs.
        forceContextReset,
        callback: (result: LoopChildResult | { error: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if ('error' in result) reject(new Error(result.error));
          else resolve(result);
        },
      });
    });
  }

  // ============ Internal — helpers ============

  private materializeConfig(p: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }): LoopConfig {
    const base = defaultLoopConfig(p.workspaceCwd, p.initialPrompt);
    // Belt-and-braces default: when a plan file is configured, require its
    // *_Completed.md rename to actually happen during the run before we accept
    // any completion signal. The renderer always sends an explicit value via
    // `p.completion.requireCompletedFileRename`, so user choice still wins;
    // this only auto-enables for programmatic callers (tests, future MCP entry
    // points) that omit the field. Without this gate, a stale Completed.md
    // from a prior run could be mistaken for in-run completion evidence.
    if (p.planFile && p.completion?.requireCompletedFileRename === undefined) {
      base.completion.requireCompletedFileRename = true;
    }
    return {
      ...base,
      ...p,
      caps: { ...base.caps, ...(p.caps ?? {}) },
      progressThresholds: {
        ...base.progressThresholds,
        ...(p.progressThresholds ?? {}),
        stageWarnIterations: { ...base.progressThresholds.stageWarnIterations, ...(p.progressThresholds?.stageWarnIterations ?? {}) },
        stageCriticalIterations: { ...base.progressThresholds.stageCriticalIterations, ...(p.progressThresholds?.stageCriticalIterations ?? {}) },
      },
      completion: { ...base.completion, ...(p.completion ?? {}) },
    };
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
    if (this.isTerminalStatus(state.status) || this.cancelFlags.get(state.id)) return;
    const loopControl = this.loopControls.get(state.id);
    if (!loopControl) return;
    let imported: Awaited<ReturnType<typeof importLoopTerminalIntents>>;
    try {
      imported = await importLoopTerminalIntents(loopControl, options);
    } catch (err) {
      if (!this.isTerminalStatus(state.status) && !this.cancelFlags.get(state.id)) {
        logger.warn('Failed to import loop-control intents', {
          loopRunId: state.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    for (const rejection of imported.rejected) {
      this.emit('loop:activity', {
        loopRunId: state.id,
        seq: options.exactIterationSeq ?? state.totalIterations,
        stage: state.currentStage,
        timestamp: Date.now(),
        kind: 'error',
        message: `Rejected loop-control intent: ${rejection.reason}`,
        detail: { filePath: rejection.filePath },
      });
    }
    if (imported.accepted.length === 0) return;

    const latest = latestIntentByReceivedAt(imported.accepted);
    if (!latest) return;

    // Build the in-memory transition set BEFORE persisting. We need
    // each intent's final status (`accepted`/`superseded`) to land in
    // the same DB row that the persist hook receives — otherwise the
    // store sees `status='pending'` and the partial unique index on
    // accepted rows is never exercised.
    if (state.terminalIntentPending && state.terminalIntentPending.id !== latest.id) {
      this.transitionTerminalIntent(state, state.terminalIntentPending, 'superseded', `superseded by ${latest.id}`);
    }
    const persistOrder: { intent: LoopTerminalIntent; filePath: string | undefined }[] = [];
    for (const intent of imported.accepted) {
      if (intent.id === latest.id) continue;
      const superseded = cloneIntentWithStatus(intent, 'superseded', `superseded by ${latest.id}`);
      this.rememberTerminalIntent(state, superseded);
      persistOrder.push({ intent: superseded, filePath: intent.filePath });
    }
    this.rememberTerminalIntent(state, latest);
    persistOrder.push({ intent: latest, filePath: latest.filePath });
    state.terminalIntentPending = latest;

    // NB2: persist every intent we just added to history BEFORE moving
    // any source file out of `intents/`. If the persist hook throws we
    // leave the source files where they are so the next boundary will
    // re-import — the importer is idempotent on intent id and the DB
    // upsert collapses retries into no-ops.
    const persistHook = this.intentPersistHook;
    if (persistHook) {
      for (const entry of persistOrder) {
        try {
          await persistHook(entry.intent);
        } catch (err) {
          logger.warn('Intent persist hook failed — leaving source file in intents/ for next boundary', {
            loopRunId: state.id,
            intentId: entry.intent.id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.emit('loop:terminal-intent-rejected', {
            loopRunId: state.id,
            intent: cloneIntentWithStatus(entry.intent, 'rejected', 'persist-hook-failed'),
            reason: err instanceof Error ? err.message : String(err),
          });
          // Drop the in-memory pending pointer so the next boundary
          // reconstructs from disk rather than acting on a half-persisted
          // intent. terminalIntentHistory keeps the attempt for debugging.
          if (state.terminalIntentPending?.id === entry.intent.id) {
            state.terminalIntentPending = undefined;
          }
          return;
        }
      }
    }

    // Persistence succeeded for every recorded intent — now it's safe
    // to archive their source files. Archive failures here are
    // observability noise, not data loss: the DB row is committed and
    // the next boundary's importer is idempotent if the file lingers
    // in `intents/`.
    for (const entry of persistOrder) {
      if (!entry.filePath) continue;
      await commitImportedIntent(loopControl, entry.filePath).catch((err: unknown) => {
        logger.warn('Failed to archive imported intent file after persistence; retry on next boundary', {
          loopRunId: state.id,
          intentId: entry.intent.id,
          filePath: entry.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.emit('loop:terminal-intent-recorded', { loopRunId: state.id, intent: latest });
    this.emit('loop:activity', {
      loopRunId: state.id,
      seq: latest.iterationSeq,
      stage: state.currentStage,
      timestamp: Date.now(),
      kind: 'status',
      message: `Loop-control ${latest.kind} intent recorded: ${latest.summary}`,
      detail: { intentId: latest.id, kind: latest.kind },
    });
  }

  private rememberTerminalIntent(state: LoopState, intent: LoopTerminalIntent): void {
    const history = state.terminalIntentHistory ?? [];
    const existingIndex = history.findIndex((item) => item.id === intent.id);
    if (existingIndex >= 0) {
      history[existingIndex] = intent;
    } else {
      history.push(intent);
    }
    state.terminalIntentHistory = history;
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
    state.pendingInterventions.push(intervention);
    // Record the obstacle so a later hard-cap stop can explain why the loop
    // never converged (see describeCapReason).
    this.convergenceNotes.set(state.id, reason);
  }

  private blockOverrideInterventionText(): string {
    // Follow-up (out of scope here): adapter-layer empty/batched tool-output
    // detection + retry belongs in the CLI adapter path, not coordinator logic.
    // Tracked: docs/plans/2026-05-30-loop-adapter-degraded-output-detection.md
    return (
      'Your block intent was NOT honored. A workspace liveness probe just confirmed the ' +
      'toolchain is responsive (shell + file reads work). Your earlier "tooling is dead / ' +
      'empty output" reading was almost certainly delayed/batched tool output or a stale/synthetic ' +
      'read — NOT a real outage. Re-establish ground truth with SINGLE, exit-0 commands (no chained ' +
      'commands, no parallel batches — one failed command can cancel a whole batch). Do not trust any ' +
      'earlier file read; re-read fresh before concluding anything is missing or broken. Then continue the task.'
    );
  }

  private isToolchainClassBlock(summary: string, evidence: LoopTerminalIntentEvidence[]): boolean {
    if (evidence.length === 0) return true;

    // Heuristics for "tooling/harness/environment looks broken" narratives.
    const patterns: readonly RegExp[] = [
      /\btoolchain\b/i,
      /\btool(?:s|ing)?\b.*\b(?:non-?responsive|unresponsive|dead|not\s+working|return(?:ing)?\s+empty|empty\s+output)\b/i,
      /\bcannot\s+(?:read|run|write|access)\b/i,
      /\bharness\b/i,
      /\bdegraded\b/i,
      /\bsynthetic\b/i,
      /\bhallucinat\w*\b/i,
      /\bbash\b.*\bempty\b/i,
      /\b(?:read|write|tool)\b.*\b(?:empty|returned\s+nothing|no\s+output)\b/i,
    ];
    return patterns.some((pattern) => pattern.test(summary));
  }

  private async runWorkspaceLivenessProbe(
    workspaceCwd: string,
    timeoutMs: number,
  ): Promise<{ alive: boolean; detail: string }> {
    const details: string[] = [];
    let execOk = false;
    let fsOk = false;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['-e', "process.stdout.write('AIO_PROBE_OK')"],
        {
          cwd: workspaceCwd,
          timeout: timeoutMs,
          // In the packaged app `process.execPath` is the Electron binary, which
          // only behaves as a plain Node interpreter when ELECTRON_RUN_AS_NODE is
          // set. Without it the probe would spuriously fail in production, report
          // the toolchain "dead", and honor exactly the hallucinated blocks this
          // gate exists to override. (Under vitest execPath is already node, so
          // this is a harmless no-op there.)
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      execOk = stdout.includes('AIO_PROBE_OK');
      details.push(execOk ? 'exec=ok' : 'exec=unexpected-output');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      details.push(`exec=fail:${reason}`);
    }

    try {
      const fs = await import('node:fs/promises');
      const packageJsonPath = path.join(workspaceCwd, 'package.json');
      try {
        await fs.readFile(packageJsonPath, 'utf8');
        fsOk = true;
        details.push('fs=read:package.json');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') {
          const entries = await fs.readdir(workspaceCwd);
          fsOk = entries.length > 0;
          details.push(fsOk ? `fs=readdir:${entries.length}` : 'fs=readdir:empty');
        } else {
          throw err;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      details.push(`fs=fail:${reason}`);
    }

    return { alive: execOk && fsOk, detail: details.join('; ') };
  }

  private async pauseForBlockIntent(state: LoopState, intent: LoopTerminalIntent): Promise<void> {
    const probeCfg = state.config.blockSanityProbe;
    const probeEnabled = probeCfg?.enabled !== false; // default-on when undefined
    let failedProbeDetail: string | undefined;
    if (probeEnabled && this.isToolchainClassBlock(intent.summary, intent.evidence)) {
      const probe = await this.runWorkspaceLivenessProbe(
        state.config.workspaceCwd,
        probeCfg?.timeoutMs ?? 5000,
      );
      if (probe.alive) {
        this.transitionTerminalIntent(
          state,
          intent,
          'rejected',
          `block not honored — liveness probe passed (${probe.detail})`,
        );
        state.terminalIntentPending = undefined;
        state.pendingInterventions.push(this.blockOverrideInterventionText());
        this.convergenceNotes.set(state.id, 'block overridden by liveness probe');
        this.emit('loop:activity', {
          loopRunId: state.id,
          seq: state.totalIterations,
          stage: state.currentStage,
          timestamp: Date.now(),
          kind: 'status',
          message: 'Block intent overridden: liveness probe confirmed toolchain responsive',
          detail: { intentId: intent.id, probe: probe.detail },
        });
        logger.info('Block intent overridden by liveness probe', {
          loopRunId: state.id,
          intentId: intent.id,
          probe: probe.detail,
        });
        return;
      }
      failedProbeDetail = probe.detail;
    }

    this.transitionTerminalIntent(state, intent, 'accepted', 'block intent accepted');
    state.terminalIntentPending = undefined;
    await this.archiveBlockedFileForIntent(state, intent);
    state.status = 'paused';
    const signal: ProgressSignalEvidence = {
      id: 'BLOCKED',
      verdict: 'CRITICAL',
      message: failedProbeDetail
        ? `Loop-control block intent: ${intent.summary} (liveness probe failed: ${failedProbeDetail})`
        : `Loop-control block intent: ${intent.summary}`,
      detail: {
        intentId: intent.id,
        evidence: intent.evidence,
        ...(failedProbeDetail ? { probeDetail: failedProbeDetail } : {}),
      },
    };
    this.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
    this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop paused from loop-control block intent', {
      loopRunId: state.id,
      intentId: intent.id,
      probeDetail: failedProbeDetail,
    });
  }

  private syntheticChildResultFromTerminalIntent(
    intent: LoopTerminalIntent,
    invocationError: string | null,
  ): LoopChildResult {
    const output = [
      `Loop-control ${intent.kind} intent recorded: ${intent.summary}`,
      invocationError ? `Provider invocation also failed: ${invocationError}` : '',
    ].filter(Boolean).join('\n');
    return {
      childInstanceId: null,
      output,
      tokens: 0,
      filesChanged: [],
      toolCalls: [],
      errors: invocationError
        ? [{ bucket: 'provider-invocation-error', exactHash: createHash('sha256').update(invocationError).digest('hex'), excerpt: invocationError }]
        : [],
      testPassCount: null,
      testFailCount: null,
      exitedCleanly: false,
    };
  }

  /**
   * Classify whether an iteration attempt is "degraded" and worth a bounded
   * retry: a transient invocation failure, or a "void" iteration that produced
   * no observable work (no output, no files changed, no tool calls). Returns a
   * short reason, or null when the attempt should be accepted as-is.
   *
   * NOTE: a child whose *internal* tools returned empty/batched/synthetic
   * results is NOT detectable here — the child still streams full narration so
   * `output` is non-empty. That failure mode is mitigated in-child by the
   * block-sanity gate + corrective intervention, not by this retry. True
   * adapter-layer detection is tracked in
   * docs/plans/2026-05-30-loop-adapter-degraded-output-detection.md.
   */
  private classifyDegradedIteration(
    childResult: LoopChildResult | null,
    invocationError: string | null,
  ): 'invocation-error' | 'void-iteration' | null {
    if (!childResult) {
      return invocationError ? 'invocation-error' : null;
    }
    const noOutput = childResult.output.trim().length === 0;
    const noWork = childResult.filesChanged.length === 0 && childResult.toolCalls.length === 0;
    if (noOutput && noWork) return 'void-iteration';
    return null;
  }

  private async archiveBlockedFileForIntent(state: LoopState, intent: LoopTerminalIntent): Promise<void> {
    const loopControl = this.loopControls.get(state.id);
    if (!loopControl) return;
    const fs = await import('node:fs/promises');
    const blockedPath = path.join(state.config.workspaceCwd, 'BLOCKED.md');
    const target = path.join(loopControl.controlDir, `blocked-handled-${intent.iterationSeq}.md`);
    try {
      await fs.rename(blockedPath, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        // Operator (or another process) removed BLOCKED.md between the
        // iteration ending and this archive running. The structured
        // intent path proceeds unchanged.
        logger.debug?.('BLOCKED.md absent at archive time — operator likely removed it', {
          loopRunId: state.id,
          intentId: intent.id,
        });
        return;
      }
      // EACCES, EBUSY, EXDEV, EEXIST, etc. — leave BLOCKED.md in place
      // and surface the failure so the next pre-flight that re-pauses on
      // the residual file is at least explained to the operator.
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to archive BLOCKED.md after structured block intent', {
        loopRunId: state.id,
        intentId: intent.id,
        errorCode: code ?? null,
        error: reason,
      });
      this.emit('loop:claimed-done-but-failed', {
        loopRunId: state.id,
        signal: 'declared-complete',
        failure: `block intent recorded but BLOCKED.md could not be archived (${code ?? 'unknown'}): ${reason}. The next iteration will re-pause on the residual file until you resolve it manually.`,
      });
    }
  }

  private async moveBlockedFileAside(state: LoopState): Promise<void> {
    const fs = await import('node:fs/promises');
    const blockedPath = path.join(state.config.workspaceCwd, 'BLOCKED.md');
    const loopControl = this.loopControls.get(state.id);
    const preferredTarget = loopControl
      ? path.join(loopControl.controlDir, `blocked-overridden-${state.totalIterations}.md`)
      : path.join(state.config.workspaceCwd, 'BLOCKED.overridden.md');

    try {
      await fs.rename(blockedPath, preferredTarget);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return;
      if (!loopControl) {
        logger.warn('Failed to move BLOCKED.md aside after override', {
          loopRunId: state.id,
          errorCode: code ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    const fallbackTarget = path.join(state.config.workspaceCwd, 'BLOCKED.overridden.md');
    try {
      await fs.rename(blockedPath, fallbackTarget);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return;
      logger.warn('Failed to move BLOCKED.md aside after override', {
        loopRunId: state.id,
        errorCode: code ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Read `BLOCKED.md` from the workspace if it exists. Returns the trimmed
   * contents (truncated to a reasonable size) so it can be surfaced to the
   * operator. Returns null when the file is absent or unreadable.
   *
   * The convention is: the AI writes BLOCKED.md when genuinely stuck, then
   * exits. We pause the loop and let the operator intervene. After the
   * operator resumes, the file is left alone — they can delete it manually
   * if it's no longer relevant; otherwise the next iteration will trip again.
   */
  private async readBlockedFileIfPresent(workspaceCwd: string): Promise<{ message: string } | null> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const target = path.join(workspaceCwd, 'BLOCKED.md');
    try {
      const raw = await fs.readFile(target, 'utf8');
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const message = trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}\n…(truncated)` : trimmed;
      return { message };
    } catch {
      return null;
    }
  }

  private async waitWhilePaused(loopRunId: string): Promise<void> {
    // already pause-emitted by the caller; just wait until resumed.
    await new Promise<void>((resolve) => {
      this.pauseGates.set(loopRunId, { resolve });
    });
  }

  private checkHardCaps(state: LoopState): null | 'iterations' | 'wall-time' | 'tokens' | 'cost' {
    const caps = state.config.caps;
    if (state.totalIterations >= caps.maxIterations) return 'iterations';
    if (Date.now() - state.startedAt >= caps.maxWallTimeMs) return 'wall-time';
    if (state.totalTokens >= caps.maxTokens) return 'tokens';
    if (caps.maxCostCents !== null && state.totalCostCents >= caps.maxCostCents) return 'cost';
    return null;
  }

  /**
   * Build a human-readable cap-stop reason that explains *why* the loop
   * stopped without converging. Prefers the most recent convergence obstacle
   * (verify red, unverifiable, rename gate unmet, blocking review findings);
   * falls back to the last iteration's verify status so the operator can tell
   * "capped while still red/blocking" from "capped while genuinely idle".
   */
  private describeCapReason(
    state: LoopState,
    cap: 'iterations' | 'wall-time' | 'tokens' | 'cost',
  ): string {
    const parts = [`cap=${cap}`, `after ${state.totalIterations} iteration(s)`];
    const note = this.convergenceNotes.get(state.id);
    if (note) {
      parts.push(`stopped while ${note}`);
    } else {
      const verify = state.lastIteration?.verifyStatus;
      if (verify === 'failed') {
        parts.push('stopped while the last verify was FAILING');
      } else if (verify === 'passed') {
        parts.push('last verify passed but no clean completion was accepted');
      } else {
        parts.push('no completion was attempted (agent never reached a verifiable done state)');
      }
    }
    return parts.join('; ');
  }

  private terminate(state: LoopState, status: LoopState['status'], reason?: string): void {
    // Idempotent: if we're already in a terminal state we must not emit
    // duplicate cancelled/error events. Without this, a force-terminate from
    // `cancelLoop` followed by runLoop's own next-iter cancel check would
    // emit `loop:cancelled` twice and double-clean attachments.
    if (this.isTerminalStatus(state.status)) return;
    state.status = status;
    state.endedAt = Date.now();
    state.endReason = reason ?? status;
    state.endEvidence = {
      lastIterationSeq: state.totalIterations - 1,
      terminalIntent: state.terminalIntentHistory?.at(-1),
    };
    // LF-6: distill a terminal learning BEFORE the convergence note is cleared.
    this.recordLoopLearning(state, status);
    const watcher = this.watchers.get(state.id);
    if (watcher) {
      void watcher.stop();
      this.watchers.delete(state.id);
    }
    this.runtimeContexts.delete(state.id);
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

  /**
   * LF-4 — disposable-plan regeneration on stall. When `plan.regenerateOnStall`
   * is set and the per-streak cap isn't reached, inject a "throw out the plan
   * and regenerate" directive, clear the WARN streak, and return true (the
   * caller continues/bypasses the pause). Returns false when disabled or capped
   * (the caller pauses normally). Bounded by `LOOP_MAX_PLAN_REGENERATIONS` so it
   * can't loop forever.
   */
  /**
   * LF-4 — read-only check: is the loop still eligible to regenerate its plan
   * on stall (enabled + under the cap)? Used by the pre-iteration kill switch
   * to decide bypass-vs-pause WITHOUT consuming budget; the actual increment +
   * directive injection happens once per iteration in
   * {@link maybeRegeneratePlanOnStall} at the post-iteration site.
   */
  private canRegeneratePlanOnStall(state: LoopState): boolean {
    if (!state.config.plan?.regenerateOnStall) return false;
    return (this.planRegenerations.get(state.id) ?? 0) < LOOP_MAX_PLAN_REGENERATIONS;
  }

  private maybeRegeneratePlanOnStall(state: LoopState, seq: number): boolean {
    if (!state.config.plan?.regenerateOnStall) return false;
    const done = this.planRegenerations.get(state.id) ?? 0;
    if (done >= LOOP_MAX_PLAN_REGENERATIONS) {
      logger.info('Loop disposable-plan regeneration cap reached — pausing', {
        loopRunId: state.id,
        attempts: done,
      });
      return false;
    }
    this.planRegenerations.set(state.id, done + 1);
    // Clear the WARN/stall streak so the regenerated approach gets a clean slate.
    state.recentWarnIterationSeqs = [];
    state.pendingInterventions.push(
      'The current plan/approach is STALLING (repeated no-progress). Treat the plan as ' +
      'disposable: throw it out and regenerate it from the goal. Re-derive the task list in ' +
      '`LOOP_TASKS.md` from scratch, pick a DIFFERENT approach for the stuck part, and proceed. ' +
      `(disposable-plan regeneration ${done + 1}/${LOOP_MAX_PLAN_REGENERATIONS})`,
    );
    this.emit('loop:plan-regenerated', {
      loopRunId: state.id,
      seq,
      attempt: done + 1,
      max: LOOP_MAX_PLAN_REGENERATIONS,
    });
    logger.info('Loop disposable-plan regeneration injected on stall', {
      loopRunId: state.id,
      seq,
      attempt: done + 1,
    });
    return true;
  }

  /**
   * LF-6 — distill + persist a cross-loop learning record. Best-effort: any
   * failure is logged and swallowed (memory must never break the loop). Reads
   * the convergence note as the "why" / dead-end, so call it before that note
   * is cleared in terminate().
   */
  private recordLoopLearning(state: LoopState, status: string): void {
    try {
      const note = this.convergenceNotes.get(state.id);
      const record = distillLearning({
        workspaceCwd: state.config.workspaceCwd,
        goal: state.config.initialPrompt,
        status,
        reason: state.endReason ?? note ?? status,
        lastCompletionOutcome: state.lastCompletionOutcome,
        deadEnds: note ? [note] : [],
      });
      void Promise.resolve(this.loopMemoryStore.recordLearning(record)).catch((err) => {
        logger.warn('recordLoopLearning persist failed', {
          loopRunId: state.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.warn('recordLoopLearning threw', { loopRunId: state.id, error: String(err) });
    }
  }

  /** Deep-ish clone for safe broadcast — strips cycles and large arrays. */
  private cloneStateForBroadcast(s: LoopState): LoopState {
    return {
      ...s,
      config: { ...s.config },
      pendingInterventions: [...s.pendingInterventions],
      recentWarnIterationSeqs: [...s.recentWarnIterationSeqs],
      completionAttempts: s.completionAttempts,
      loopControl: s.loopControl ? { ...s.loopControl } : undefined,
      terminalIntentPending: s.terminalIntentPending
        ? { ...s.terminalIntentPending, evidence: s.terminalIntentPending.evidence.map((item) => ({ ...item })) }
        : undefined,
      terminalIntentHistory: (s.terminalIntentHistory ?? []).map((intent) => ({
        ...intent,
        evidence: intent.evidence.map((item) => ({ ...item })),
      })),
    };
  }
}

export function getLoopCoordinator(): LoopCoordinator {
  return LoopCoordinator.getInstance();
}
