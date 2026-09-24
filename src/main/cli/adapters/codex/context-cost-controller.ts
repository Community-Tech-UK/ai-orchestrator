import type { InterruptResult, TurnInterruptCompletion } from '../base-cli-adapter';
import type { ProviderContextActionHandlerResult } from '../../../context-evidence/provider-context-action-executor';
import { getLogger } from '../../../logging/logger';
import type { SurfacedToUserError } from '../surfaced-error';
import type { AppServerNotification } from './app-server-types';
import { CompactionGate, type CompactionGateOutcome } from './compaction-gate';
import { CodexCompactionSignalTracker, type CodexCompactionSignal } from './compaction-signals';
import { classifyCodexAppServerFailure } from './app-server-runtime-errors';
import {
  CodexTurnCostGovernor,
  type CodexTurnCostObservation,
} from './turn-cost-governor';

const logger = getLogger('CodexContextCostController');

/**
 * The provider's own compaction turn can still be closing when the
 * continuation is submitted right after `contextCompaction` completes.
 * One short retry clears that race without surfacing it to the user.
 */
const CONTINUE_TURN_RETRY_DELAY_MS = 750;

export const COST_RECOVERY_CONTINUATION =
  'Continue the interrupted task from where you left off. Inspect the current workspace state before acting, do not repeat completed edits or commands, and finish the original request.';

type RecoveryReason = 'interrupt-unconfirmed' | 'compaction-unobserved';
type RecoveryStage = 'interrupt-requested' | 'interrupt-observed' | 'compaction-observed' | 'continued' | 'paused';
export type CodexContextAction =
  | 'controlled-interrupt'
  | 'controlled-recovery'
  | 'native-compaction'
  | 'same-thread-continuation'
  | 'provider-counter-reset';
export type CodexContextActionProofStage = 'requested' | 'acknowledged' | 'observed';

/**
 * A controlled recovery paused. The controller has already posted the reason as
 * a system notice, so callers must not add their own notice for it.
 */
export class CodexContextRecoveryPausedError extends Error implements SurfacedToUserError {
  readonly surfacedToUser = true;

  constructor(message: string, readonly reasonCode: RecoveryReason) {
    super(message);
    this.name = 'CodexContextRecoveryPausedError';
  }
}

interface PendingRecovery {
  action: 'controlled-interrupt' | 'controlled-recovery';
  interruptResult: InterruptResult;
}

export interface CompactionTarget {
  threadId: string;
  start(): Promise<unknown>;
  /** Interrupts the provider turn running the compaction. */
  interrupt?(turnId: string): Promise<unknown>;
}

export interface CodexContextCostControllerDeps {
  /** @deprecated Decisions are owned by ContextSafetyPolicy; retained for config compatibility. */
  enabled?: boolean;
  /** Window for the provider to report a requested compaction as running. */
  compactionTimeoutMs: number;
  /** Window for a compaction reported as running to finish. Defaults to `compactionTimeoutMs`. */
  compactionRunningTimeoutMs?: number;
  /**
   * Liveness heartbeat interval while the provider runs a compaction. The
   * provider streams its own keepalives to Codex, but the app-server does not
   * forward them, so without this the session looks silent to the stuck
   * detector for the whole compaction.
   */
  compactionHeartbeatMs?: number;
  interrupt(): InterruptResult;
  getCompactionTarget(): CompactionTarget | null;
  emitSystem(content: string, metadata: Record<string, unknown>): void;
  emitHeartbeat?(): void;
  recordObservation?(observation: CodexTurnCostObservation): void;
  recordActionProof?(action: CodexContextAction, stage: CodexContextActionProofStage): void;
  recordRecovery?(stage: RecoveryStage, reasonCode?: RecoveryReason): void;
  recordCompactionRpc?(stage: 'requested' | 'accepted' | 'failed'): void;
}

export interface RecoverAfterTurnParams {
  turnStatus: string | null | undefined;
  recoveryCount: number;
  continueTurn(message: string, nextRecoveryCount: number): Promise<void>;
}

/** Codex action executor and proof observer. It contains no pressure thresholds. */
export class CodexContextCostController {
  private readonly gate = new CompactionGate();
  private readonly governor = new CodexTurnCostGovernor();
  private readonly signals = new CodexCompactionSignalTracker();
  private pendingRecovery: PendingRecovery | null = null;
  /**
   * Set when a compaction is observed outside an active `compactContext` wait
   * (e.g. Codex self-managed compaction during the controlled-recovery interrupt).
   * Without this the next `compactContext` call starts a fresh gate wait and
   * sends `thread/compact/start` against an already-compacted thread, which
   * never signals again — the wait times out and poisons
   * `nativeCompactionUnobserved` for the rest of the session.
   */
  private compactionObservedSinceCheck = false;
  /**
   * The controlled recovery's own compaction wait. Only the first wait started
   * during a recovery is recorded, so an overlapping plain `compactContext()`
   * call cannot replace it.
   */
  private recoveryWait: Promise<CompactionGateOutcome> | null = null;
  /** True while a controlled recovery is between its interrupt and its continuation. */
  private recoveryInProgress = false;
  /** The user stopped the session while a controlled recovery was waiting on compaction. */
  private recoveryStopRequested = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CodexContextCostControllerDeps) {}

  observe(cumulativeTokens: number, contextWindow: number): void {
    const observation = this.governor.observe({ cumulativeTokens, contextWindow });
    this.deps.recordObservation?.(observation);
    if (observation.counterResetObserved) {
      this.deps.recordActionProof?.('provider-counter-reset', 'observed');
    }
  }

  async requestRecovery(
    action: 'controlled-interrupt' | 'controlled-recovery',
  ): Promise<ProviderContextActionHandlerResult> {
    // A recovery already waiting on compaction owns the thread; interrupting
    // again would target the provider's compaction turn, not the task.
    if (this.pendingRecovery || this.recoveryInProgress) return { proof: 'acknowledged' };
    this.deps.recordActionProof?.(action, 'requested');
    const interruptResult = this.deps.interrupt();
    if (interruptResult.status !== 'accepted' || !interruptResult.completion) {
      // LT-270: on Codex builds observed in the campaign, this is the common,
      // expected outcome — the triggering turn has almost always already
      // completed by the time the async policy queue evaluates the 4x
      // crossing, so there is nothing left to interrupt. It is a safe no-op
      // (no work lost, nothing compacted), not an actionable event, so it is
      // only logged rather than surfaced as a transcript system message.
      logger.info('Context recovery skipped — no active turn to interrupt', {
        action,
        interruptStatus: interruptResult.status,
      });
      this.deps.recordRecovery?.('paused', 'interrupt-unconfirmed');
      return { proof: 'none' };
    }
    this.pendingRecovery = { action, interruptResult };
    this.deps.recordActionProof?.(action, 'acknowledged');
    this.deps.recordRecovery?.('interrupt-requested');
    return { proof: 'acknowledged' };
  }

  /**
   * Classifies an app-server notification for the bound thread and applies the
   * compaction lifecycle it carries. Returns `completed` so the caller can
   * publish the compaction, which then calls {@link recordCompactionObserved}.
   */
  acceptCompactionSignal(
    notification: AppServerNotification,
    threadId: string | null,
  ): CodexCompactionSignal | null {
    const signal = this.signals.accept(notification, threadId);
    if (signal === 'started') this.recordCompactionStarted();
    if (signal === 'aborted') this.recordCompactionAborted();
    return signal;
  }

  recordCompactionObserved(cumulativeTokens: number): void {
    this.stopHeartbeat();
    const awaited = this.gate.hasPendingWaiters();
    this.gate.settle();
    this.governor.recordCompactionObserved(cumulativeTokens);
    // The connected app-server demonstrably does signal compaction, so
    // clear any earlier negative verdict — a CLI upgrade mid-session should
    // re-enable the native path rather than stay disabled until restart.
    this.nativeCompactionUnobserved = false;
    if (!awaited) {
      this.compactionObservedSinceCheck = true;
      this.deps.recordActionProof?.('native-compaction', 'observed');
    }
  }

  /** The provider reported a compaction running; an explicit wait moves to its running window. */
  recordCompactionStarted(): void {
    this.gate.markRunning();
    this.startHeartbeat();
  }

  /** The provider ended the compaction turn without completing the compaction. */
  recordCompactionAborted(): void {
    this.stopHeartbeat();
    this.gate.fail();
  }

  /** The app-server connection is gone, so no compaction signal can still arrive. */
  handleRuntimeExit(): void {
    this.signals.reset();
    this.stopHeartbeat();
    this.gate.cancel();
  }

  /**
   * Stops the provider compaction a controlled recovery is waiting on, when the
   * user interrupts the session. Returns null when there is no such wait or the
   * provider has not reported which turn is running it, so the caller falls
   * back to its normal "no active turn" result.
   */
  interruptRecoveryCompaction(): InterruptResult | null {
    const wait = this.recoveryWait;
    const turnId = this.signals.runningTurnId;
    const target = this.deps.getCompactionTarget();
    if (!this.recoveryInProgress || !wait || !turnId || !target?.interrupt) return null;
    this.recoveryStopRequested = true;
    target.interrupt(turnId).catch((error: unknown) => {
      // The interrupt handler's force-abort net ends the session if the
      // compaction keeps running; nothing more to do here.
      logger.warn('Could not interrupt the Codex compaction turn', {
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const completion = wait.then((outcome): TurnInterruptCompletion => ({
      status: outcome === 'observed' ? 'completed' : 'interrupted',
      turnId,
    }));
    return { status: 'accepted', turnId, completion };
  }

  /**
   * Set once the connected app-server has accepted a compact RPC but reported
   * no compaction at all within the start window. Without this every
   * compaction paid the full timeout again for no possible benefit (LT-017).
   * A compaction that was reported running but finished late does not set it.
   */
  private nativeCompactionUnobserved = false;

  /** Has this session already proven the native compaction notification absent? */
  nativeCompactionKnownUnsupported(): boolean {
    return this.nativeCompactionUnobserved;
  }

  async compactContext(timeoutMs: number): Promise<boolean> {
    // LT-017: don't pay the timeout again once this session has proven the
    // provider never sends the notification. The caller falls back exactly as
    // it would have after waiting, just immediately.
    if (this.nativeCompactionUnobserved) {
      logger.info('Skipping native compaction — this session already proved the notification absent', {
        timeoutMs,
      });
      return false;
    }
    // A compaction that landed outside the previous wait (Codex self-managed
    // during the controlled-recovery interrupt) already shrank the thread.
    // Sending another `thread/compact/start` against it produces no further
    // signal, so the gate would time out and wrongly disable the native path.
    if (this.compactionObservedSinceCheck) {
      this.compactionObservedSinceCheck = false;
      logger.info('Skipping native compaction — a compaction was already observed since the last check');
      return true;
    }
    const observed = this.gate.wait(timeoutMs, this.deps.compactionRunningTimeoutMs ?? timeoutMs);
    if (this.recoveryInProgress && !this.recoveryWait) this.recoveryWait = observed;
    try {
      if (!await this.startCompaction()) {
        this.gate.cancel();
        return false;
      }
      const outcome = await observed;
      if (outcome === 'observed') {
        this.deps.recordActionProof?.('native-compaction', 'observed');
        return true;
      }
      if (outcome === 'timed-out') {
        this.nativeCompactionUnobserved = true;
      }
      logger.warn('Context compaction was acknowledged but not observed', {
        timeoutMs,
        runningTimeoutMs: this.deps.compactionRunningTimeoutMs ?? timeoutMs,
        outcome,
        nativeCompactionDisabledForSession: this.nativeCompactionUnobserved,
      });
      return false;
    } finally {
      if (this.recoveryWait === observed) this.recoveryWait = null;
    }
  }

  async recoverAfterTurn(params: RecoverAfterTurnParams): Promise<boolean> {
    const pending = this.pendingRecovery;
    if (!pending) return false;
    this.pendingRecovery = null;

    const completion = pending.interruptResult.completion
      ? await pending.interruptResult.completion
      : { status: params.turnStatus ?? 'unknown' } as TurnInterruptCompletion;
    if (completion.status === 'completed' || params.turnStatus === 'completed') return false;
    if (completion.status !== 'interrupted' || params.turnStatus !== 'interrupted') {
      throw this.pause(
        'interrupt-unconfirmed',
        'Codex context recovery paused because the active turn did not confirm interruption. The conversation was preserved; retry when ready.',
      );
    }
    this.deps.recordActionProof?.(pending.action, 'observed');
    this.deps.recordRecovery?.('interrupt-observed');

    this.recoveryInProgress = true;
    this.recoveryStopRequested = false;
    let compacted: boolean;
    try {
      compacted = await this.compactContext(this.deps.compactionTimeoutMs);
    } finally {
      this.recoveryInProgress = false;
    }
    if (this.recoveryStopRequested) {
      // The user stopped the session. The interrupt handler reports the stop;
      // continuing the task now would override it.
      this.recoveryStopRequested = false;
      logger.info('Context recovery stopped by the user while Codex was compacting', { compacted });
      this.deps.recordRecovery?.('paused');
      return true;
    }
    if (!compacted) {
      throw this.pause(
        'compaction-unobserved',
        'Codex context recovery paused because compaction could not be confirmed. The conversation was preserved; retry or compact manually before continuing.',
      );
    }

    this.deps.recordRecovery?.('compaction-observed');
    this.deps.emitSystem(
      'Codex reached a shared context-policy boundary, so Harness interrupted it, observed compaction, and is continuing on the same thread.',
      { contextCostRecovery: true, action: pending.action },
    );
    this.deps.recordActionProof?.('same-thread-continuation', 'requested');
    await this.continueTurnWithRetry(params);
    this.deps.recordActionProof?.('same-thread-continuation', 'observed');
    this.deps.recordRecovery?.('continued');
    return true;
  }

  clearPending(): void {
    this.pendingRecovery = null;
  }

  /**
   * Submits the same-thread continuation, retrying once if the provider's own
   * compaction turn is still closing (surfaced as a "not steerable"/"failed
   * to submit turn input" rejection for `turn_kind: Compact`). Codex clears
   * that state almost immediately, so a single short-delayed retry is enough;
   * any other error, or a second failure, is rethrown to the caller.
   */
  private async continueTurnWithRetry(params: RecoverAfterTurnParams): Promise<void> {
    try {
      await params.continueTurn(COST_RECOVERY_CONTINUATION, params.recoveryCount + 1);
    } catch (error) {
      if (classifyCodexAppServerFailure(error).recoverability !== 'retry-thread') throw error;
      logger.warn('Same-thread continuation raced the provider compaction turn closing; retrying once', {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, CONTINUE_TURN_RETRY_DELAY_MS));
      await params.continueTurn(COST_RECOVERY_CONTINUATION, params.recoveryCount + 1);
    }
  }

  private async startCompaction(): Promise<boolean> {
    const target = this.deps.getCompactionTarget();
    if (!target) return false;
    try {
      this.deps.recordActionProof?.('native-compaction', 'requested');
      this.deps.recordCompactionRpc?.('requested');
      await target.start();
      this.deps.recordActionProof?.('native-compaction', 'acknowledged');
      this.deps.recordCompactionRpc?.('accepted');
      return true;
    } catch (error) {
      this.deps.recordCompactionRpc?.('failed');
      logger.warn('Context compaction failed', {
        threadId: target.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Proves liveness while the provider compacts. Bounded by the running window
   * so a completion that never reaches this thread (for example after the
   * thread was replaced) cannot keep the session looking alive forever.
   */
  private startHeartbeat(): void {
    const emitHeartbeat = this.deps.emitHeartbeat;
    if (!emitHeartbeat) return;
    emitHeartbeat();
    const intervalMs = this.deps.compactionHeartbeatMs;
    if (!intervalMs || this.heartbeatTimer) return;
    const stopAt = Date.now() + (this.deps.compactionRunningTimeoutMs ?? this.deps.compactionTimeoutMs);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() >= stopAt) {
        this.stopHeartbeat();
        return;
      }
      emitHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private pause(reasonCode: RecoveryReason, message: string): Error {
    this.deps.recordRecovery?.('paused', reasonCode);
    this.deps.emitSystem(message, { contextCostRecoveryPaused: true, reasonCode });
    return new CodexContextRecoveryPausedError(message, reasonCode);
  }
}
