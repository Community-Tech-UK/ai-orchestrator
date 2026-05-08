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
import { getLogger } from '../logging/logger';
import {
  defaultLoopConfig,
  type LoopConfig,
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

export class LoopCoordinator extends EventEmitter {
  private static instance: LoopCoordinator | null = null;

  private active = new Map<string, LoopState>();
  private pauseGates = new Map<string, PauseGate>();
  private cancelFlags = new Map<string, boolean>();
  private histories = new Map<string, LoopIteration[]>();
  private watchers = new Map<string, CompletedFileWatcher>();
  private iterationHooks: LoopIterationHook[] = [];

  private progressDetector = new LoopProgressDetector();
  private completionDetector = new LoopCompletionDetector();

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
      this.instance.iterationHooks = [];
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
  ): Promise<LoopState> {
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
    const watcher = new CompletedFileWatcher(config.workspaceCwd, config.completion.completedFilenamePattern);
    watcher.start();
    // catch existing rename-target if it was created during a previous run
    const existing = watcher.scanOnce();
    const completedRenameSeen = !!existing;
    if (completedRenameSeen) {
      logger.info('Loop start: existing *_Completed.md found in workspace', { id, file: existing });
    }

    const stageMachine = new LoopStageMachine(config.workspaceCwd);
    const initialStage = await stageMachine.bootstrap(config);

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
      completedFileRenameObserved: completedRenameSeen,
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
    };
    this.active.set(id, state);
    this.histories.set(id, []);
    this.watchers.set(id, watcher);
    this.cancelFlags.set(id, false);

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
    const onClaimedFailed = (d: { loopRunId: string; signal: 'completed-rename' | 'done-promise' | 'done-sentinel' | 'all-green' | 'self-declared' | 'plan-checklist'; failure: string }) => {
      if (d.loopRunId === loopRunId) push({ type: 'claimed-done-but-failed', loopRunId, signal: d.signal, failure: d.failure });
    };
    const onIntervention = (d: { loopRunId: string; message: string }) => {
      if (d.loopRunId === loopRunId) push({ type: 'intervention-applied', loopRunId, message: d.message });
    };
    const onCompleted = (d: { loopRunId: string; signal: 'completed-rename' | 'done-promise' | 'done-sentinel' | 'all-green' | 'self-declared' | 'plan-checklist'; verifyOutput: string }) => {
      if (d.loopRunId === loopRunId) {
        push({ type: 'completed', loopRunId, signal: d.signal, verifyOutput: d.verifyOutput });
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
    this.on('loop:intervention-applied', onIntervention);
    this.on('loop:completed', onCompleted);
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
      this.off('loop:intervention-applied', onIntervention);
      this.off('loop:completed', onCompleted);
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
      const prompt = stageMachine.buildPrompt({
        config: state.config,
        iterationSeq: seq,
        pendingInterventions: state.pendingInterventions,
      });
      const consumedInterventions = state.pendingInterventions.splice(0, state.pendingInterventions.length);

      this.emit('loop:iteration-started', { loopRunId: state.id, seq, stage });

      let childResult: LoopChildResult;
      try {
        childResult = await this.invokeChild(state, prompt, stage);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Iteration invocation failed', err instanceof Error ? err : new Error(msg), { loopRunId: state.id, seq });
        this.terminate(state, 'error', msg);
        return;
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
        iteration.verifyStatus = v1.status;
        iteration.verifyOutputExcerpt = excerpt(v1.output);
        verifyOutputForEmit = v1.output;
        if (v1.status === 'failed') {
          this.emit('loop:claimed-done-but-failed', {
            loopRunId: state.id,
            signal: candidate.id,
            failure: excerpt(v1.output, 4096),
          });
          // do not stop; continue
        } else {
          // anti-flake: optionally run again
          let v2: VerifyOutcomeLike = v1;
          if (state.config.completion.runVerifyTwice) {
            v2 = await this.completionDetector.runVerify(state.config);
            if (v2.status === 'failed') {
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
            stopWithSignal = candidate;
          } else if (v2.status === 'passed') {
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

      // -- terminal: completion --
      if (stopWithSignal) {
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
    state.endEvidence = { lastIterationSeq: state.totalIterations - 1 };
    const watcher = this.watchers.get(state.id);
    if (watcher) {
      void watcher.stop();
      this.watchers.delete(state.id);
    }
    if (status === 'cancelled') this.emit('loop:cancelled', { loopRunId: state.id });
    if (status === 'error') this.emit('loop:error', { loopRunId: state.id, error: reason ?? 'unknown error' });
    this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
    logger.info('Loop terminated', { loopRunId: state.id, status, reason });
    // Best-effort cleanup of any attachment files we wrote into the workspace.
    void cleanupLoopAttachments(state.config.workspaceCwd, state.id);
  }

  /** Deep-ish clone for safe broadcast — strips cycles and large arrays. */
  private cloneStateForBroadcast(s: LoopState): LoopState {
    return {
      ...s,
      config: { ...s.config },
      pendingInterventions: [...s.pendingInterventions],
      recentWarnIterationSeqs: [...s.recentWarnIterationSeqs],
    };
  }
}

// ============ module-private helpers ============

interface VerifyOutcomeLike {
  status: 'passed' | 'failed';
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

export function getLoopCoordinator(): LoopCoordinator {
  return LoopCoordinator.getInstance();
}
