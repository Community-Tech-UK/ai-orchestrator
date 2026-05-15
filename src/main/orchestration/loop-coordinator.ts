/**
 * Loop Coordinator
 *
 * Per-chat-session "Ralph loop" with fresh-context iterations, aggressive
 * no-progress detection, and verify-before-stop completion. The coordinator
 * itself never invokes LLMs — it emits an extensibility event
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
import * as path from 'path';
import { getLogger } from '../logging/logger';
import {
  defaultLoopConfig,
  defaultCrossModelReviewConfig,
  type LoopConfig,
  type LoopCrossModelReviewConfig,
  type LoopErrorRecord,
  type LoopFileChange,
  type LoopIteration,
  type LoopStage,
  type LoopState,
  type LoopStreamEvent,
  type LoopToolCallRecord,
  type LoopVerdict,
  type CompletionSignalEvidence,
  type ProgressSignalEvidence,
  type LoopTerminalIntent,
} from '../../shared/types/loop.types';
import {
  LoopCompletionDetector,
  CompletedFileWatcher,
  completedPlanFileCandidates,
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

const logger = getLogger('LoopCoordinator');

/** Approximate Claude Sonnet cost in cents per 1M tokens, rounded up. */
const COST_PER_M_TOKENS_CENTS = 1500;

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
}

interface PauseGate { resolve: () => void }

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
 * Severity of a fresh-eyes review finding. Mirrors
 * `HeadlessReviewFinding.severity` from
 * `src/main/cli-entrypoints/review-command-output.ts` but is kept as a local
 * type so this module does not pull in the headless-review surface at
 * import time (LoopCoordinator runs in tests that mock the review service).
 */
export type FreshEyesSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface FreshEyesFinding {
  title: string;
  body: string;
  severity: FreshEyesSeverity;
  file?: string;
  confidence: number;
}

export interface FreshEyesReviewerInput {
  loopRunId: string;
  workspaceCwd: string;
  /** The user's actual goal — fed to the reviewer as taskDescription. */
  goal: string;
  /** Excerpt of the iteration output that claimed completion. */
  iterationOutput: string;
  /** Files changed across the run (best-effort, can be empty). */
  filesChangedThisIteration: readonly string[];
  /** Plan files that started uncompleted in this run. */
  uncompletedPlanFilesAtStart: readonly string[];
  /** Verify output passed-in for context. */
  verifyOutputExcerpt: string;
  /** Coordinator's signal that fired this completion attempt. */
  signal: string;
  /** Explicit terminal intent that caused the completion attempt, if present. */
  terminalIntent?: LoopTerminalIntent;
  /** Review configuration (reviewers, severities, depth, timeout). */
  config: LoopCrossModelReviewConfig;
}

export interface FreshEyesReviewerResult {
  findings: FreshEyesFinding[];
  /** Provider names actually used as reviewers. Empty when none available. */
  reviewersUsed: string[];
  /** Plain-English summary returned by the review service. */
  summary: string;
  /** Whether the underlying review infrastructure failed entirely. */
  infrastructureError?: string;
}

export type FreshEyesReviewer = (
  input: FreshEyesReviewerInput,
) => Promise<FreshEyesReviewerResult>;

/**
 * Default implementation — lazily imports `CrossModelReviewService` and
 * dispatches a headless review. Returns an empty findings list when the
 * service has no reviewers available (degrades safely).
 */
const defaultFreshEyesReviewer: FreshEyesReviewer = async (input) => {
  // Lazy import to avoid pulling the review service into test paths that
  // mock `getCrossModelReviewService`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCrossModelReviewService } = require(
    './cross-model-review-service',
  ) as typeof import('./cross-model-review-service');
  const service = getCrossModelReviewService();

  const filesBlock =
    input.filesChangedThisIteration.length > 0
      ? `\n\nFiles changed in this iteration:\n${input.filesChangedThisIteration.slice(0, 50).map((f) => `  - ${f}`).join('\n')}`
      : '';
  const plansBlock =
    input.uncompletedPlanFilesAtStart.length > 0
      ? `\n\nPlan files that existed at loop start (the agent was asked to address these):\n${input.uncompletedPlanFilesAtStart.map((f) => `  - ${f}`).join('\n')}`
      : '';
  const intentBlock = input.terminalIntent
    ? `\n\nExplicit terminal intent:\n  - kind: ${input.terminalIntent.kind}\n  - summary: ${input.terminalIntent.summary}\n`
    : '';

  const content =
    `# Fresh-eyes review request\n\n` +
    `A long-running autonomous loop has signalled completion via "${input.signal}" and ` +
    `verify passed. Before the loop terminates, please review the workspace with fresh eyes.\n\n` +
    `## What to look for\n` +
    `- Items the goal asked for that are NOT actually implemented in code (orphan modules, stubs returning constants, "completed" docs with no real wiring).\n` +
    `- Specs that say one thing but code does another.\n` +
    `- Half-done features or TODOs left behind.\n` +
    `- Integration gaps: new code that is never imported or invoked outside its own tests.\n\n` +
    `## What "ready_for_done" means here\n` +
    `Mark a finding as **critical** or **high** severity ONLY for blocking issues that would make a reasonable reviewer say "no, this isn't done yet."\n` +
    `Use **medium** or **low** for nice-to-haves, style nits, or follow-up suggestions — those do not block completion.\n\n` +
    `## Iteration output (what the agent said it did)\n${input.iterationOutput}${filesBlock}${plansBlock}${intentBlock}\n\n` +
    `## Verify output\n${input.verifyOutputExcerpt}\n`;

  try {
    const result = await service.runHeadlessReview({
      target: `loop:${input.loopRunId}`,
      cwd: input.workspaceCwd,
      content,
      taskDescription: input.goal,
      reviewers: input.config.reviewers,
      reviewDepth: input.config.reviewDepth,
      timeoutSeconds: input.config.timeoutSeconds,
    });

    return {
      findings: result.findings.map((f) => ({
        title: f.title,
        body: f.body,
        severity: f.severity,
        file: f.file,
        confidence: f.confidence,
      })),
      reviewersUsed: result.reviewers
        .filter((r) => r.status === 'used')
        .map((r) => r.provider),
      summary: result.summary,
      infrastructureError:
        result.infrastructureErrors && result.infrastructureErrors.length > 0
          ? result.infrastructureErrors.join('; ')
          : undefined,
    };
  } catch (err) {
    return {
      findings: [],
      reviewersUsed: [],
      summary: 'Fresh-eyes review threw.',
      infrastructureError: err instanceof Error ? err.message : String(err),
    };
  }
};

export interface LoopRuntimeContext {
  /**
   * Prior visible-session transcript used as read-only background for loop
   * children. Kept outside LoopState/config so it is not shown as the user's
   * goal or persisted as loop configuration.
   */
  existingSessionContext?: string;
}

export class LoopCoordinator extends EventEmitter {
  private static instance: LoopCoordinator | null = null;

  private active = new Map<string, LoopState>();
  private pauseGates = new Map<string, PauseGate>();
  private cancelFlags = new Map<string, boolean>();
  private histories = new Map<string, LoopIteration[]>();
  private watchers = new Map<string, CompletedFileWatcher>();
  private runtimeContexts = new Map<string, LoopRuntimeContext>();
  private loopControls = new Map<string, LoopControlRuntime>();
  private iterationHooks: LoopIterationHook[] = [];
  private intentPersistHook: LoopIntentPersistHook | null = null;

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
      this.instance.watchers.clear();
      this.instance.runtimeContexts.clear();
      this.instance.loopControls.clear();
      this.instance.iterationHooks = [];
      this.instance.intentPersistHook = null;
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
    // Same idea for cross-model fresh-eyes review: only auto-enable when
    // the caller did not give us a concrete config block.
    const userExplicitlySetCrossModelReview =
      partialConfig.completion?.crossModelReview !== undefined;
    const config = this.materializeConfig(partialConfig);
    if (!config.initialPrompt.trim()) throw new Error('initialPrompt is required');
    if (!config.workspaceCwd.trim()) throw new Error('workspaceCwd is required');

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
    // Auto-enable mandatory fresh-eyes cross-model review for the same
    // trigger: if the workspace had uncompleted plan files and the caller
    // did not explicitly configure the review block, default it on.
    // This is the loop's automated "check again with fresh eyes" gate.
    if (
      !userExplicitlySetCrossModelReview &&
      !config.completion.crossModelReview &&
      snapshot.uncompletedPlanFilesAtStart.length > 0
    ) {
      config.completion.crossModelReview = defaultCrossModelReviewConfig();
      logger.info(
        'Loop start: auto-enabled crossModelReview — uncompleted plan files present',
        { id, blockingSeverities: config.completion.crossModelReview.blockingSeverities },
      );
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
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
    };
    this.active.set(id, state);
    this.histories.set(id, []);
    this.watchers.set(id, watcher);
    this.loopControls.set(id, loopControl);
    this.cancelFlags.set(id, false);
    if (runtimeContext?.existingSessionContext?.trim()) {
      this.runtimeContexts.set(id, {
        existingSessionContext: runtimeContext.existingSessionContext.trim(),
      });
    }

    // Wire watcher to mutate state.
    watcher.onCompleted((filePath) => {
      state.completedFileRenameObserved = true;
      logger.info('CompletedFileWatcher fired', { id, filePath });
      this.emit('loop:completed-file-observed', { loopRunId: id, filePath });
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
    return true;
  }

  private isTerminalStatus(status: LoopState['status']): boolean {
    return (
      status === 'completed' ||
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
    if (!this.active.has(loopRunId)) {
      yield { type: 'error', loopRunId, error: `Loop ${loopRunId} not found` };
      return;
    }

    const queue: LoopStreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    const push = (e: LoopStreamEvent) => {
      queue.push(e);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const onIterationStarted = (d: { loopRunId: string; seq: number; stage: LoopStage }) => {
      if (d.loopRunId === loopRunId) push({ type: 'iteration-started', loopRunId, seq: d.seq, stage: d.stage });
    };
    const onIterationComplete = (d: { loopRunId: string; seq: number; verdict: LoopVerdict }) => {
      if (d.loopRunId === loopRunId) push({ type: 'iteration-complete', loopRunId, seq: d.seq, verdict: d.verdict });
    };
    const onPaused = (d: { loopRunId: string; signal: ProgressSignalEvidence }) => {
      if (d.loopRunId === loopRunId) push({ type: 'paused-no-progress', loopRunId, signal: d.signal });
    };
    const onClaimedFailed = (d: { loopRunId: string; signal: CompletionSignalEvidence['id']; failure: string }) => {
      if (d.loopRunId === loopRunId) push({ type: 'claimed-done-but-failed', loopRunId, signal: d.signal, failure: d.failure });
    };
    const onTerminalIntentRecorded = (d: { loopRunId: string; intent: LoopTerminalIntent }) => {
      if (d.loopRunId === loopRunId) push({ type: 'terminal-intent-recorded', loopRunId, intent: d.intent });
    };
    const onTerminalIntentRejected = (d: { loopRunId: string; intent: LoopTerminalIntent; reason: string }) => {
      if (d.loopRunId === loopRunId) push({ type: 'terminal-intent-rejected', loopRunId, intent: d.intent, reason: d.reason });
    };
    const onIntervention = (d: { loopRunId: string; message: string }) => {
      if (d.loopRunId === loopRunId) push({ type: 'intervention-applied', loopRunId, message: d.message });
    };
    const onCompleted = (d: { loopRunId: string; signal: CompletionSignalEvidence['id']; verifyOutput: string }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'completed', loopRunId, signal: d.signal, verifyOutput: d.verifyOutput });
        done = true;
        if (resolve) { resolve(); resolve = null; }
      }
    };
    const onFailed = (d: { loopRunId: string; reason: string }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'failed', loopRunId, reason: d.reason });
        done = true;
        if (resolve) { resolve(); resolve = null; }
      }
    };
    const onCap = (d: { loopRunId: string; cap: 'iterations' | 'wall-time' | 'tokens' | 'cost' }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'cap-reached', loopRunId, cap: d.cap });
        done = true;
        if (resolve) { resolve(); resolve = null; }
      }
    };
    const onCancelled = (d: { loopRunId: string }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'cancelled', loopRunId });
        done = true;
        if (resolve) { resolve(); resolve = null; }
      }
    };
    const onError = (d: { loopRunId: string; error: string }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'error', loopRunId, error: d.error });
        done = true;
        if (resolve) { resolve(); resolve = null; }
      }
    };

    this.on('loop:iteration-started', onIterationStarted);
    this.on('loop:iteration-complete', onIterationComplete);
    this.on('loop:paused-no-progress', onPaused);
    this.on('loop:claimed-done-but-failed', onClaimedFailed);
    this.on('loop:terminal-intent-recorded', onTerminalIntentRecorded);
    this.on('loop:terminal-intent-rejected', onTerminalIntentRejected);
    this.on('loop:intervention-applied', onIntervention);
    this.on('loop:completed', onCompleted);
    this.on('loop:failed', onFailed);
    this.on('loop:cap-reached', onCap);
    this.on('loop:cancelled', onCancelled);
    this.on('loop:error', onError);

    yield { type: 'started', loopRunId, chatId: this.active.get(loopRunId)!.chatId };

    try {
      while (!done) {
        if (queue.length > 0) yield queue.shift()!;
        else await new Promise<void>((r) => { resolve = r; });
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      this.off('loop:iteration-started', onIterationStarted);
      this.off('loop:iteration-complete', onIterationComplete);
      this.off('loop:paused-no-progress', onPaused);
      this.off('loop:claimed-done-but-failed', onClaimedFailed);
      this.off('loop:terminal-intent-recorded', onTerminalIntentRecorded);
      this.off('loop:terminal-intent-rejected', onTerminalIntentRejected);
      this.off('loop:intervention-applied', onIntervention);
      this.off('loop:completed', onCompleted);
      this.off('loop:failed', onFailed);
      this.off('loop:cap-reached', onCap);
      this.off('loop:cancelled', onCancelled);
      this.off('loop:error', onError);
    }
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
        this.emit('loop:cap-reached', { loopRunId: state.id, cap: capHit });
        this.terminate(state, 'cap-reached', `cap=${capHit}`);
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
        state.status = 'paused';
        const signal: ProgressSignalEvidence = {
          id: 'BLOCKED',
          verdict: 'CRITICAL',
          message: `BLOCKED.md present: ${blockedFile.message}`,
          detail: { file: 'BLOCKED.md', excerpt: blockedFile.message },
        };
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused because the iteration wrote BLOCKED.md', { loopRunId: state.id });
        continue;
      }

      // -- pre-iteration kill switch --
      const history = this.histories.get(state.id) ?? [];
      const block = this.progressDetector.shouldRefuseToSpawnNext(state, history);
      if (block) {
        // Pause and wait for user.
        state.status = 'paused';
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal: block });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop pre-iteration kill switch fired', { loopRunId: state.id, signal: block });
        continue; // re-enter pause loop on next iteration
      }

      // -- read current stage --
      const stage = await stageMachine.readStage(state.config);
      if (stage !== state.currentStage) {
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
      const prompt = this.appendLoopControlPrompt(state, stageMachine.buildPrompt({
        config: state.config,
        iterationSeq: seq,
        pendingInterventions: state.pendingInterventions,
        existingSessionContext: this.runtimeContexts.get(state.id)?.existingSessionContext,
        uncompletedPlanFilesAtStart: state.uncompletedPlanFilesAtStart,
      }));
      const consumedInterventions = state.pendingInterventions.splice(0, state.pendingInterventions.length);

      this.emit('loop:iteration-started', { loopRunId: state.id, seq, stage });

      let childResult: LoopChildResult | null = null;
      let invocationError: string | null = null;
      try {
        childResult = await this.invokeChild(state, prompt, stage);
      } catch (err) {
        invocationError = err instanceof Error ? err.message : String(err);
        logger.error('Iteration invocation failed', err instanceof Error ? err : new Error(invocationError), { loopRunId: state.id, seq });
      } finally {
        await this.importTerminalIntentsForBoundary(state, {
          maxIterationSeq: seq,
          exactIterationSeq: seq,
          terminalEligible: state.status === 'running',
        });
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
      if (evaluation.verdict === 'WARN') {
        state.recentWarnIterationSeqs.push(seq);
        // keep last warnEscalationWindow + a few
        const keep = state.config.progressThresholds.warnEscalationWindow + 5;
        if (state.recentWarnIterationSeqs.length > keep) {
          state.recentWarnIterationSeqs.splice(0, state.recentWarnIterationSeqs.length - keep);
        }
      }

      const terminalIntentForIteration = state.terminalIntentPending;
      if (terminalIntentForIteration?.kind === 'complete' && consumedInterventions.length > 0) {
        this.transitionTerminalIntent(
          state,
          terminalIntentForIteration,
          'deferred',
          'Completion intent was declared in an intervention-consuming iteration',
        );
        state.terminalIntentPending = undefined;
      }

      // -- completion detection --
      const completionSignals = await this.completionDetector.observe({
        iteration,
        config: state.config,
        state,
      });
      iteration.completionSignalsFired = completionSignals;

      // -- verify-before-stop --
      let stopWithSignal: CompletionSignalEvidence | null = null;
      let verifyOutputForEmit = '';
      if (this.completionDetector.hasSufficientSignal(completionSignals) && !consumedInterventions.length) {
        // Pick the highest-priority sufficient signal for the stop attempt.
        const sufficientList = completionSignals.filter((c) => c.sufficient);
        const candidate = sufficientList[0]!;
        const v1 = await this.completionDetector.runVerify(state.config);
        iteration.verifyStatus = v1.status === 'skipped' ? 'not-run' : v1.status;
        iteration.verifyOutputExcerpt = excerpt(v1.output);
        verifyOutputForEmit = v1.output;
        if (v1.status === 'failed') {
          this.rejectPendingCompleteIntent(state, 'verify failed');
          this.emit('loop:claimed-done-but-failed', {
            loopRunId: state.id,
            signal: candidate.id,
            failure: excerpt(v1.output, 4096),
          });
          // do not stop; continue
        } else if (v1.status === 'skipped') {
          // No verify command is configured, so the loop has NO independent
          // way to confirm the work is done — every completion signal
          // (declared-complete, *_Completed.md rename, DONE.txt, plan
          // checklist) is produced by the agent itself. Refuse to stop on an
          // unverified self-declaration: reject the pending completion,
          // surface why, and keep iterating until a hard cap is reached.
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
              'command (your test / lint / build command) in the loop settings — until then ' +
              'the loop will keep iterating until it reaches a hard cap rather than stop on an ' +
              'unverified, self-declared completion.',
          });
          // Feed the rejection back to the agent: the next iteration must
          // know its completion was not accepted, otherwise it may simply
          // re-declare done each iteration and burn the run out at the cap.
          state.pendingInterventions.push(
            'Your completion was NOT accepted. This loop has no verify command configured, ' +
              'so it cannot independently confirm the work is finished. Do not simply ' +
              're-declare completion — it will be rejected again. Either keep making concrete ' +
              'progress on the task, or, if you believe it is genuinely done, run the ' +
              "project's own checks yourself (tests / lint / typecheck / build) and report " +
              'their actual output as evidence.',
          );
          // do not stop; continue
        } else {
          // anti-flake: optionally run again
          let v2: VerifyOutcomeLike = v1;
          if (state.config.completion.runVerifyTwice) {
            v2 = await this.completionDetector.runVerify(state.config);
            if (v2.status === 'failed') {
              this.rejectPendingCompleteIntent(state, 'second verify failed');
              iteration.verifyStatus = 'failed';
              iteration.verifyOutputExcerpt = excerpt(v2.output);
              verifyOutputForEmit = v2.output;
              this.emit('loop:claimed-done-but-failed', {
                loopRunId: state.id,
                signal: candidate.id,
                failure: 'verify flake suspected: ' + excerpt(v2.output, 4096),
              });
              // do not stop
            }
          }
          if (v2.status === 'passed' && this.completionDetector.passesBeltAndBraces(state, state.config)) {
            // Fresh-eyes cross-model review gate. The previous loop bug was
            // that DONE.txt + passing verify was enough to stop, even when
            // the actual goal hadn't been substantively addressed (orphan
            // code, missed renames, half-done specs). This hook calls a
            // different CLI provider with the iteration output + workspace
            // context and asks "is this really done?". Any blocking finding
            // becomes a user intervention and the loop continues.
            const reviewBlocked = await this.runFreshEyesReviewGate(state, candidate.id, iteration, verifyOutputForEmit);
            if (!reviewBlocked) {
              stopWithSignal = candidate;
            } else {
              this.rejectPendingCompleteIntent(state, 'fresh-eyes review blocked completion');
            }
          } else if (v2.status === 'passed') {
            this.rejectPendingCompleteIntent(state, 'completed-file rename gate did not pass');
            // verify passes but belt-and-braces (rename) hasn't happened yet —
            // surface so the agent can do the rename, but don't stop.
            this.emit('loop:claimed-done-but-failed', {
              loopRunId: state.id,
              signal: candidate.id,
              failure: 'Verify passed but no *_Completed.md rename observed. Rename the plan file to confirm.',
            });
          }
        }
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
          progressNotes: iteration.progressSignals.map((s) => `[${s.id}/${s.verdict}] ${s.message}`),
          completionNotes: iteration.completionSignalsFired.map((c) => `[${c.id}] ${c.detail}`),
        });
      } catch (err) {
        logger.warn('appendIterationLog failed', { error: String(err) });
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

      // -- post-iteration: critical no-progress → pause --
      if (evaluation.verdict === 'CRITICAL') {
        const primary = evaluation.primary ?? evaluation.signals[0];
        state.status = 'paused';
        this.emit('loop:paused-no-progress', { loopRunId: state.id, signal: primary });
        this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
        logger.info('Loop paused — no-progress CRITICAL', { loopRunId: state.id, signal: primary });
        // loop continues after user resumes/cancels
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
  ): Promise<boolean> {
    const reviewCfg = state.config.completion.crossModelReview;
    if (!reviewCfg || !reviewCfg.enabled) return false;

    this.emit('loop:fresh-eyes-review-started', { loopRunId: state.id, signal: signalId });
    let reviewResult: FreshEyesReviewerResult;
    try {
      reviewResult = await this.freshEyesReviewer({
        loopRunId: state.id,
        workspaceCwd: state.config.workspaceCwd,
        goal: state.config.initialPrompt,
        iterationOutput: iteration.outputExcerpt,
        filesChangedThisIteration: iteration.filesChanged.map((f) => f.path),
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
      return false;
    }

    const blocking = reviewResult.findings.filter((f) =>
      (reviewCfg.blockingSeverities as readonly string[]).includes(f.severity),
    );

    if (blocking.length === 0) {
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
      return false;
    }

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
      `\n\nAddress each item, then re-attempt completion.`;

    state.pendingInterventions.push(interventionMessage);
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
    return true;
  }

  // ============ Internal — child invocation (extensibility) ============

  private invokeChild(state: LoopState, prompt: string, stage: LoopStage): Promise<LoopChildResult> {
    if (this.listenerCount('loop:invoke-iteration') === 0) {
      throw new Error(
        'No handler registered for loop:invoke-iteration. ' +
        'Register one in src/main/index.ts to wire LLM invocation.'
      );
    }
    return new Promise<LoopChildResult>((resolve, reject) => {
      let settled = false;
      const correlationId = `${state.id}::${state.totalIterations}`;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Loop iteration timed out after ${state.config.caps.maxWallTimeMs}ms (single-iter wall slice)`));
      }, state.config.caps.maxWallTimeMs);

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
    // from a prior run combined with an unconfigured verify command can
    // terminate the loop on iteration 0.
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

  private async pauseForBlockIntent(state: LoopState, intent: LoopTerminalIntent): Promise<void> {
    this.transitionTerminalIntent(state, intent, 'accepted', 'block intent accepted');
    state.terminalIntentPending = undefined;
    await this.archiveBlockedFileForIntent(state, intent);
    state.status = 'paused';
    const signal: ProgressSignalEvidence = {
      id: 'BLOCKED',
      verdict: 'CRITICAL',
      message: `Loop-control block intent: ${intent.summary}`,
      detail: { intentId: intent.id, evidence: intent.evidence },
    };
    this.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
    this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop paused from loop-control block intent', { loopRunId: state.id, intentId: intent.id });
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
    if (state.totalCostCents >= caps.maxCostCents) return 'cost';
    return null;
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
    const watcher = this.watchers.get(state.id);
    if (watcher) {
      void watcher.stop();
      this.watchers.delete(state.id);
    }
    this.runtimeContexts.delete(state.id);
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
  }

  /** Deep-ish clone for safe broadcast — strips cycles and large arrays. */
  private cloneStateForBroadcast(s: LoopState): LoopState {
    return {
      ...s,
      config: { ...s.config },
      pendingInterventions: [...s.pendingInterventions],
      recentWarnIterationSeqs: [...s.recentWarnIterationSeqs],
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

// ============ module-private helpers ============

interface VerifyOutcomeLike {
  status: 'passed' | 'skipped' | 'failed';
  output: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function excerpt(s: string, max = 4096): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n…\n' + s.slice(-half);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9_\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Compute the work hash for an iteration.
 *
 * sha256( sortedFileDiffPaths ‖ stage ‖ uniqueToolCallSig )
 *
 * This is the structural fingerprint of "what the iteration did" — same
 * fingerprint repeating means the agent is doing the same thing.
 */
export function computeWorkHash(args: {
  stage: LoopStage;
  filesChanged: LoopFileChange[];
  toolCalls: LoopToolCallRecord[];
}): string {
  const sortedFiles = [...args.filesChanged]
    .map((f) => `${f.path}::${f.contentHash}`)
    .sort()
    .join('|');
  const toolSig = [...new Set(args.toolCalls.map((tc) => `${tc.toolName}::${tc.argsHash}`))]
    .sort()
    .join('|');
  return createHash('sha256')
    .update(args.stage)
    .update('\0')
    .update(sortedFiles)
    .update('\0')
    .update(toolSig)
    .digest('hex');
}

function completedPlanWatchDirs(config: LoopConfig): string[] {
  return [...new Set(completedPlanFileCandidates(config).map((candidate) => path.dirname(candidate)))];
}

export function getLoopCoordinator(): LoopCoordinator {
  return LoopCoordinator.getInstance();
}
