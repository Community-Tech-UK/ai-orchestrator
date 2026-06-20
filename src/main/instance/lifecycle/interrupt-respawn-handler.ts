/**
 * Interrupt / Respawn Handler
 *
 * Owns the three-stage interrupt flow that used to live on
 * InstanceLifecycleManager:
 *   - `interrupt()`               — user-initiated ESC: interrupts the CLI
 *                                    and flips the instance into
 *                                    `interrupting`. Providers with explicit
 *                                    turn-completion proof can settle back to
 *                                    idle without respawn; process CLIs still
 *                                    recover through `respawning` after exit.
 *                                    A second interrupt escalates cancellation.
 *   - `respawnAfterInterrupt()`   — follow-up to an interrupt: spawns a new
 *                                    adapter, attempts native --resume, and
 *                                    falls back to a fresh session + replay
 *                                    continuity message if resume fails.
 *   - `respawnAfterUnexpectedExit()` — auto-respawn flow invoked by the
 *                                    exit handler when a CLI process dies
 *                                    unexpectedly. Same resume/fallback logic.
 *
 * The pending-respawn promise that `sendInput()` waits on is tracked in a
 * module-scoped WeakMap keyed on the Instance, so messages queued during
 * respawn aren't rejected.
 *
 * Behaviour here is intentionally identical to the previous private methods
 * on `InstanceLifecycleManager` — this is extraction without logic change.
 */
import {
  type CliAdapter,
  type UnifiedSpawnOptions,
} from '../../cli/adapters/adapter-factory';
import type { CliType } from '../../cli/cli-detection';
import type {
  AdapterRuntimeCapabilities,
  InterruptResult,
  TurnInterruptCompletion,
} from '../../cli/adapters/base-cli-adapter';
import { getSessionMutex } from '../../session/session-mutex';
import { planSessionRecovery } from './session-recovery';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';
import {
  emitInterruptBoundaryDisplayMarker,
  type InterruptBoundaryMarker,
} from '../../display-items/interrupt-boundary-renderer';
import type {
  ContextUsage,
  Instance,
  InstanceStatus,
  InstanceWaitReason,
  OutputMessage,
  SessionDiffStats,
} from '../../../shared/types/instance.types';
import type { ActivityState } from '../../../shared/types/activity.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { ErrorInfo } from '../../../shared/types/ipc.types';
import type { BrowserGatewayMcpConfigOptions } from '../../browser-gateway/browser-mcp-config';
import type { ChromeDevtoolsMcpConfigOptions } from '../../browser-gateway/chrome-devtools-mcp-config';
import { getProviderRuntimeService } from '../../providers/provider-runtime-service';
import { withOperationDeadline, isDeadlineExceeded } from '../../runtime/operation-deadline';
import { getOrCreateTurnSupervisor } from '../../session/session-turn-supervisor';
import { getOrCreateCircuitBreaker } from './respawn-circuit-breaker';
import { getSessionContinuityManagerIfInitialized } from '../../session/session-continuity';

const logger = getLogger('InterruptRespawn');

type QueueUpdate = (
  instanceId: string,
  status: InstanceStatus,
  contextUsage?: ContextUsage,
  diffStats?: SessionDiffStats | null,
  displayName?: string,
  error?: ErrorInfo,
  executionLocation?: ExecutionLocation,
  sessionState?: {
    providerSessionId?: string;
    restartEpoch?: number;
    adapterGeneration?: number;
    activeTurnId?: string;
    interruptRequestId?: string;
    interruptRequestedAt?: number;
    interruptPhase?: Instance['interruptPhase'];
    lastTurnOutcome?: Instance['lastTurnOutcome'];
    supersededBy?: string;
    cancelledForEdit?: boolean;
    recoveryMethod?: Instance['recoveryMethod'];
    archivedUpToMessageId?: string;
    historyThreadId?: string;
  },
  activityState?: ActivityState,
  currentModel?: string,
  waitReason?: InstanceWaitReason | null,
) => void;

/**
 * Stash for respawn-promise resolvers. Keyed on Instance so the pending
 * respawn can be resolved (or discarded) without mutating the Instance type.
 * Module-scoped — the handler is the only writer/reader.
 */
const respawnResolvers = new WeakMap<Instance, () => void>();

/**
 * Force-abort net: timers that unconditionally terminate + settle the
 * respawnPromise if the graceful interrupt path does not complete in time.
 * Armed on every accepted interrupt; cancelled by resolveRespawnPromise().
 */
const forceAbortTimers = new WeakMap<Instance, ReturnType<typeof setTimeout>>();

/** How long to wait for a graceful interrupt to settle before force-aborting. */
const INTERRUPT_FORCE_ABORT_MS = 30_000;
/** Deadline for `handleInterruptCompletion()` to receive a provider completion. */
const INTERRUPT_COMPLETION_DEADLINE_MS = 15_000;

export interface InterruptRespawnDeps {
  // readers
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;

  // writers
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => void;
  queueUpdate: QueueUpdate;
  markInterrupted: (id: string) => void;
  clearInterrupted: (id: string) => void;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  setupAdapterEvents: (id: string, adapter: CliAdapter) => void;

  // lifecycle helpers (private on the lifecycle manager)
  transitionState: (instance: Instance, newState: InstanceStatus) => void;
  getAdapterRuntimeCapabilities: (adapter?: CliAdapter) => AdapterRuntimeCapabilities;
  resolveCliTypeForInstance: (instance: Instance) => Promise<CliType>;
  getMcpConfig: (
    location?: ExecutionLocation,
    instanceId?: string,
    provider?: CliType,
  ) => string[];
  getBrowserGatewayMcpOptions?: (
    location?: ExecutionLocation,
    instanceId?: string,
    provider?: CliType,
  ) => BrowserGatewayMcpConfigOptions | null;
  getChromeDevtoolsMcpOptions?: (
    location?: ExecutionLocation,
  ) => ChromeDevtoolsMcpConfigOptions | null;
  getPermissionHookPath: (yoloMode: boolean) => string | undefined;
  waitForResumeHealth: (instanceId: string, timeoutMs?: number) => Promise<boolean>;
  waitForAdapterWritable: (instanceId: string, timeoutMs: number) => Promise<boolean>;
  buildReplayContinuityMessage: (instance: Instance, reason: string) => string;
  buildFallbackHistory: (instance: Instance, reason: string) => Promise<string>;
  queueContinuityPreamble?: (instanceId: string, preamble: string) => void;

  /** Forward an 'output' event onto the lifecycle EventEmitter. */
  emitOutput: (instanceId: string, message: OutputMessage) => void;

  /** Optional marker bridge for transcript-visible recovery boundaries. */
  emitDisplayMarker?: (instance: Instance, message: OutputMessage) => void;
}

export class InterruptRespawnHandler {
  constructor(private readonly deps: InterruptRespawnDeps) {}

  private shouldAbortRespawn(instanceId: string, instance: Instance): boolean {
    const current = this.deps.getInstance(instanceId);
    if (!current || current !== instance) {
      return true;
    }

    return current.status === 'terminated'
      || current.status === 'failed'
      || current.status === 'superseded'
      || current.status === 'cancelled'
      || current.status === 'error';
  }

  private async cleanupAbortedRespawnAdapter(
    instanceId: string,
    instance: Instance,
    adapter: CliAdapter,
    reason: string,
  ): Promise<void> {
    logger.info('Respawn aborted; cleaning up replacement adapter', {
      instanceId,
      status: this.deps.getInstance(instanceId)?.status,
      reason,
    });

    adapter.removeAllListeners();
    try {
      await adapter.terminate(false);
    } catch (error) {
      logger.warn('Failed to terminate aborted respawn adapter', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.deps.getAdapter(instanceId) === adapter) {
      this.deps.deleteAdapter(instanceId);
    }

    if (this.deps.getInstance(instanceId) === instance) {
      instance.processId = null;
    }
  }

  private emitInterruptBoundary(instance: Instance, marker: InterruptBoundaryMarker): void {
    const addToOutputBuffer = this.deps.addToOutputBuffer;
    const emitOutput = this.deps.emitOutput;
    if (this.deps.emitDisplayMarker) {
      const captured: OutputMessage[] = [];
      emitInterruptBoundaryDisplayMarker(instance, marker, {
        addToOutputBuffer: (_instance, message) => captured.push(message),
        emitOutput: () => undefined,
      });
      const [message] = captured;
      if (message) {
        this.deps.emitDisplayMarker(instance, message);
      }
      return;
    }

    emitInterruptBoundaryDisplayMarker(instance, marker, {
      addToOutputBuffer,
      emitOutput,
    });
  }

  private createRuntimeAdapter(
    cliType: CliType,
    options: UnifiedSpawnOptions,
    executionLocation?: ExecutionLocation,
  ): CliAdapter {
    return getProviderRuntimeService().createAdapter({ cliType, options, executionLocation });
  }

  private isInterruptRecoveryStatus(status: InstanceStatus): boolean {
    return status === 'interrupting'
      || status === 'cancelling'
      || status === 'respawning'
      || status === 'interrupt-escalating';
  }

  /**
   * Interrupt the currently-busy instance. Returns true if the interrupt
   * signal was delivered (and the instance transitioned into `interrupting`).
   *
   * If the instance is already interrupting/cancelling/respawning, a second
   * interrupt escalates to adapter termination and leaves the instance in a
   * recoverable `cancelled` state.
   */
  interrupt(instanceId: string): boolean {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    if (!adapter || !instance) {
      logger.warn('Cannot interrupt instance: not found', { instanceId });
      return false;
    }

    if (this.isInterruptRecoveryStatus(instance.status)) {
      logger.info('Escalating interrupt on second request', {
        instanceId,
        status: instance.status,
        interruptRequestId: instance.interruptRequestId,
      });

      instance.interruptPhase = 'escalated';
      instance.lastTurnOutcome = 'cancelled';
      this.emitInterruptBoundary(instance, {
        phase: 'escalated',
        requestId: instance.interruptRequestId ?? generateId(),
        outcome: 'cancelled',
        reason: 'second interrupt',
      });
      this.deps.transitionState(instance, 'interrupt-escalating');
      this.deps.queueUpdate(instanceId, 'interrupt-escalating', instance.contextUsage, undefined, undefined, undefined, undefined, {
        activeTurnId: instance.activeTurnId,
        interruptRequestId: instance.interruptRequestId,
        interruptRequestedAt: instance.interruptRequestedAt,
        interruptPhase: instance.interruptPhase,
        lastTurnOutcome: instance.lastTurnOutcome,
        adapterGeneration: instance.adapterGeneration,
      });

      // A1: Pre-capture processId before clearing so terminate() keeps its
      // reference even after we null it on the instance.
      // Note: adapter.terminate() already holds its own `this.process`
      // reference internally, so it can SIGKILL even after we clear ours.

      // A4: Delete the adapter from the registry BEFORE clearing processId so
      // no new operations can grab the stale adapter.
      this.deps.deleteAdapter(instanceId);

      // Resolve the respawnPromise BEFORE the (async) terminate so that any
      // waiting sendInput() unblocks immediately (they will see 'cancelled').
      this.resolveRespawnPromise(instance);

      // Initiate bounded terminate (fire-and-forget — adapter.terminate already
      // SIGTERM→SIGKILL after 5s; we don't block the state machine on this).
      adapter.terminate(true).catch((err) => {
        logger.warn('Escalated interrupt terminate failed', {
          error: err instanceof Error ? err.message : String(err),
          instanceId,
        });
      });

      this.deps.clearInterrupted(instanceId);
      this.deps.transitionState(instance, 'cancelled');
      instance.processId = null;
      const message: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'system',
        content: 'Interrupt escalated — session cancelled. Restart to continue.',
        metadata: {
          interruptRequestId: instance.interruptRequestId,
          interruptPhase: 'escalated',
          turnId: instance.activeTurnId,
        },
      };
      this.deps.addToOutputBuffer(instance, message);
      this.deps.emitOutput(instanceId, message);
      this.deps.queueUpdate(instanceId, 'cancelled', instance.contextUsage, undefined, undefined, undefined, undefined, {
        activeTurnId: instance.activeTurnId,
        interruptRequestId: instance.interruptRequestId,
        interruptRequestedAt: instance.interruptRequestedAt,
        interruptPhase: instance.interruptPhase,
        lastTurnOutcome: instance.lastTurnOutcome,
        adapterGeneration: instance.adapterGeneration,
      }, undefined, undefined, null); // clear waitReason — escalated cancel is terminal
      return true;
    }

    const interruptibleStatuses = new Set<InstanceStatus>([
      'busy',
      'processing',
      'thinking_deeply',
      'waiting_for_input',
      'waiting_for_permission',
    ]);
    if (!interruptibleStatuses.has(instance.status)) {
      logger.warn('Cannot interrupt instance: not interruptible', { instanceId, status: instance.status });
      return false;
    }

    this.deps.markInterrupted(instanceId);

    const interruptResult = adapter.interrupt();
    if (this.isAcceptedInterrupt(interruptResult)) {
      const requestedAt = Date.now();
      instance.interruptRequestId = generateId();
      instance.interruptRequestedAt = requestedAt;
      instance.interruptPhase = interruptResult.status === 'escalated' ? 'escalated' : 'accepted';
      // Bump message generation so wake messages are only consumed by the
      // freshly-spawned process, not the dying one still in its grace period.
      instance.messageGenerationId = (instance.messageGenerationId ?? 0) + 1;
      instance.activeTurnId = interruptResult.turnId ?? instance.activeTurnId;
      // Record interrupt in the per-instance supervisor (interruptSeq fence, §4.A).
      getOrCreateTurnSupervisor(instanceId).recordInterrupt();
      this.emitInterruptBoundary(instance, {
        phase: 'requested',
        requestId: instance.interruptRequestId,
        outcome: 'unresolved',
        at: requestedAt,
      });

      this.deps.transitionState(instance, 'interrupting');
      instance.lastActivity = Date.now();
      this.deps.queueUpdate(instanceId, 'interrupting', instance.contextUsage, undefined, undefined, undefined, undefined, {
        activeTurnId: instance.activeTurnId,
        interruptRequestId: instance.interruptRequestId,
        interruptRequestedAt: instance.interruptRequestedAt,
        interruptPhase: instance.interruptPhase,
        adapterGeneration: instance.adapterGeneration,
      }, undefined, undefined, {
        kind: 'interrupt-ack',
        startedAt: Date.now(),
        deadlineAt: Date.now() + INTERRUPT_FORCE_ABORT_MS,
        attempt: 1,
      });

      // Expose a promise that resolves when respawn completes.
      // sendInput() awaits this so messages sent during interrupt/recovery are
      // held (not rejected) until the adapter is ready or cancelled.
      let resolveRespawn!: () => void;
      instance.respawnPromise = new Promise<void>((resolve) => {
        resolveRespawn = resolve;
      });
      respawnResolvers.set(instance, resolveRespawn);

      // A2: Force-abort net — arm an unconditional timer BEFORE and INDEPENDENT
      // of the graceful path.  If neither handleInterruptCompletion nor
      // respawnAfterInterrupt settles the respawnPromise within the deadline,
      // we forcibly terminate the adapter and settle to 'cancelled'.
      // The timer is cancelled by resolveRespawnPromise() on the happy path.
      const capturedInstance = instance;
      const capturedInstanceId = instanceId;
      const capturedAdapter = adapter;
      const forceAbortTimer = setTimeout(() => {
        const current = this.deps.getInstance(capturedInstanceId);
        if (!current || current !== capturedInstance) return;
        if (!respawnResolvers.has(capturedInstance)) return; // already resolved

        logger.warn('Force-abort net fired: interrupt did not settle within deadline', {
          instanceId: capturedInstanceId,
          status: current.status,
          interruptRequestId: current.interruptRequestId,
          deadlineMs: INTERRUPT_FORCE_ABORT_MS,
        });

        // Delete stale adapter and force-terminate it.
        if (this.deps.getAdapter(capturedInstanceId) === capturedAdapter) {
          this.deps.deleteAdapter(capturedInstanceId);
        }
        capturedAdapter.removeAllListeners();
        capturedAdapter.terminate(true).catch(() => {/* ignore — best effort */});

        // Settle the instance into cancelled state.
        this.deps.clearInterrupted(capturedInstanceId);
        this.deps.transitionState(capturedInstance, 'cancelled');
        capturedInstance.processId = null;
        capturedInstance.interruptPhase = 'escalated';
        capturedInstance.lastTurnOutcome = 'cancelled';

        const forceMessage: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: 'Interrupt timed out — session force-cancelled. Restart to continue.',
          metadata: { interruptRequestId: capturedInstance.interruptRequestId, interruptPhase: 'escalated', forceAborted: true },
        };
        this.deps.addToOutputBuffer(capturedInstance, forceMessage);
        this.deps.emitOutput(capturedInstanceId, forceMessage);
        this.deps.queueUpdate(capturedInstanceId, 'cancelled', capturedInstance.contextUsage, undefined, undefined, undefined, undefined, {
          activeTurnId: capturedInstance.activeTurnId,
          interruptPhase: capturedInstance.interruptPhase,
          lastTurnOutcome: capturedInstance.lastTurnOutcome,
          adapterGeneration: capturedInstance.adapterGeneration,
        }, undefined, undefined, null); // clear waitReason — force-cancelled terminal state

        // Resolve so sendInput() waiters unblock (they'll see 'cancelled' and throw).
        this.resolveRespawnPromise(capturedInstance);
      }, INTERRUPT_FORCE_ABORT_MS);
      if (typeof forceAbortTimer.unref === 'function') forceAbortTimer.unref();
      forceAbortTimers.set(instance, forceAbortTimer);

      if (interruptResult.completion) {
        void this.handleInterruptCompletion(instanceId, instance, interruptResult.completion);
      }
    } else {
      logger.warn('Interrupt was not accepted by adapter', {
        instanceId,
        status: interruptResult.status,
        reason: interruptResult.reason,
      });
      this.deps.clearInterrupted(instanceId);
    }

    return this.isAcceptedInterrupt(interruptResult);
  }

  private isAcceptedInterrupt(result: InterruptResult): boolean {
    return result.status === 'accepted' || result.status === 'escalated';
  }

  private resolveRespawnPromise(instance: Instance): void {
    // Cancel force-abort net if it was armed.
    const forceAbortTimer = forceAbortTimers.get(instance);
    if (forceAbortTimer !== undefined) {
      clearTimeout(forceAbortTimer);
      forceAbortTimers.delete(instance);
    }

    const resolveRespawn = respawnResolvers.get(instance);
    if (!resolveRespawn) {
      instance.respawnPromise = undefined;
      return;
    }

    resolveRespawn();
    respawnResolvers.delete(instance);
    instance.respawnPromise = undefined;
  }

  private async handleInterruptCompletion(
    instanceId: string,
    instanceAtInterrupt: Instance,
    completion: Promise<TurnInterruptCompletion>,
  ): Promise<void> {
    let result: TurnInterruptCompletion;
    try {
      // A3: deadline prevents a wedged provider from blocking recovery indefinitely.
      // On timeout, treat as rejected and let the respawn path (or force-abort net)
      // take over.
      result = await withOperationDeadline({
        name: 'interrupt-completion',
        owner: instanceId,
        deadlineMs: INTERRUPT_COMPLETION_DEADLINE_MS,
        operation: completion,
        onTimeout: (name, owner) => {
          logger.warn('Interrupt completion timed out; treating as rejected', { name, owner, instanceId });
        },
      });
    } catch (err) {
      if (isDeadlineExceeded(err)) {
        result = {
          status: 'rejected',
          reason: `interrupt completion timed out after ${INTERRUPT_COMPLETION_DEADLINE_MS}ms`,
        };
      } else {
        result = {
          status: 'rejected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const instance = this.deps.getInstance(instanceId);
    if (!instance || instance !== instanceAtInterrupt) {
      return;
    }
    if (!this.isInterruptRecoveryStatus(instance.status)) {
      this.resolveRespawnPromise(instance);
      return;
    }

    this.deps.clearInterrupted(instanceId);
    instance.interruptPhase = 'completed';
    instance.lastTurnOutcome =
      result.status === 'interrupted' || result.status === 'rejected' ? 'interrupted'
      : result.status === 'cancelled' ? 'cancelled'
      : result.status === 'completed' ? 'completed'
      : 'interrupted';

    if (instance.status === 'interrupting') {
      this.deps.transitionState(instance, 'cancelling');
      this.emitInterruptBoundary(instance, {
        phase: 'cancelling',
        requestId: instance.interruptRequestId ?? generateId(),
        outcome: instance.cancelledForEdit ? 'cancelled-for-edit' : 'unresolved',
      });
      this.deps.queueUpdate(instanceId, 'cancelling', instance.contextUsage, undefined, undefined, undefined, undefined, {
        activeTurnId: instance.activeTurnId,
        interruptRequestId: instance.interruptRequestId,
        interruptRequestedAt: instance.interruptRequestedAt,
        interruptPhase: instance.interruptPhase,
        lastTurnOutcome: instance.lastTurnOutcome,
        adapterGeneration: instance.adapterGeneration,
      });
    }

    if (result.status === 'rejected') {
      logger.warn('Accepted interrupt completed with a rejected turn result; treating as interrupted', {
        instanceId,
        turnId: result.turnId,
        reason: result.reason,
      });
    }

    this.deps.transitionState(instance, 'idle');
    instance.lastActivity = Date.now();
    this.resolveRespawnPromise(instance);

    const message: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Interrupted — waiting for input',
      metadata: {
        interruptStatus: result.status,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.reason ? { interruptReason: result.reason } : {}),
      },
    };
    this.deps.addToOutputBuffer(instance, message);
    this.deps.emitOutput(instanceId, message);
    this.deps.queueUpdate(instanceId, 'idle', instance.contextUsage, undefined, undefined, undefined, undefined, {
      activeTurnId: instance.activeTurnId,
      interruptRequestId: instance.interruptRequestId,
      interruptRequestedAt: instance.interruptRequestedAt,
      interruptPhase: instance.interruptPhase,
      lastTurnOutcome: instance.lastTurnOutcome,
      adapterGeneration: instance.adapterGeneration,
    }, undefined, undefined, null); // clear waitReason on idle
  }

  /**
   * Respawn an instance after interrupt to continue the session.
   */
  async respawnAfterInterrupt(instanceId: string): Promise<void> {
    logger.info('Starting respawn after interrupt', { instanceId });

    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // §6.3: Circuit breaker — exponential backoff on repeated respawns.
    const breaker = getOrCreateCircuitBreaker(instanceId);
    const breakerDelay = breaker.recordAttempt();
    if (breakerDelay > 0) {
      // Surface the backoff as a waitReason so the user knows why respawn is delayed.
      this.deps.queueUpdate(instanceId, instance.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        kind: 'backoff',
        attempt: breaker.snapshot().attempt,
        retryAt: Date.now() + breakerDelay,
      });
      await new Promise<void>(resolve => setTimeout(resolve, breakerDelay));
      // Clear waitReason once the backoff expires (respawn will set its own reason).
      this.deps.queueUpdate(instanceId, instance.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
    }
    const hasActiveInterruptRequest =
      !!instance.interruptRequestId && instance.interruptPhase !== 'completed';
    const triggeredByInterrupt =
      this.isInterruptRecoveryStatus(instance.status) || hasActiveInterruptRequest;
    const replayReason = triggeredByInterrupt ? 'interrupt-respawn' : 'stuck-auto-respawn';

    const release = await getSessionMutex().acquire(instanceId, 'respawn-interrupt', {
      operation: 'respawn',
      recoveryReason: triggeredByInterrupt ? 'interrupt' : 'unexpected-exit',
      turnId: instance.activeTurnId,
      adapterGeneration: instance.adapterGeneration,
    });
    try {
      if (this.shouldAbortRespawn(instanceId, instance)) {
        logger.info('Skipping respawn after interrupt because instance is no longer recoverable', {
          instanceId,
          status: this.deps.getInstance(instanceId)?.status,
        });
        return;
      }

      // C5: Snapshot session state before discarding the current adapter, so
      // a crash/error during respawn does not lose the last known good state.
      void getSessionContinuityManagerIfInitialized()
        ?.createSnapshot(instanceId, 'pre-respawn', 'State captured before interrupt-respawn', 'checkpoint')
        .catch(() => undefined);

      const previousAdapter = this.deps.getAdapter(instanceId);
      const capabilities = this.deps.getAdapterRuntimeCapabilities(previousAdapter);
      const sessionId = instance.sessionId;
      logger.debug('Respawning with session ID', { instanceId, sessionId });
      if (!sessionId && capabilities.supportsResume) {
        throw new Error(`Instance ${instanceId} has no session ID to resume`);
      }
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant',
      );
      // Skip --resume entirely if we previously observed that this session id
      // is unknown to the CLI. Falls through to the fresh-session + replay path.
      const resumeBlacklisted = instance.sessionResumeBlacklisted === true;
      if (resumeBlacklisted) {
        logger.info('Skipping --resume for blacklisted session id', { instanceId, sessionId });
      }
      const recoveryPlan = planSessionRecovery({
        instanceId,
        reason: triggeredByInterrupt ? 'interrupt' : 'unexpected-exit',
        previousAdapterId: previousAdapter?.getName(),
        previousProviderSessionId: sessionId,
        provider: instance.provider,
        model: instance.currentModel,
        agent: instance.agentId,
        cwd: instance.workingDirectory,
        yolo: instance.yoloMode,
        executionLocation: instance.executionLocation.type,
        capabilities,
        activeTurnId: instance.activeTurnId,
        adapterGeneration: instance.adapterGeneration ?? 0,
        hasConversation,
        sessionResumeBlacklisted: resumeBlacklisted,
        providerSessionPersisted: instance.providerSessionPersisted,
      });
      const canAttemptNativeResume =
        recoveryPlan.kind === 'native-resume' || recoveryPlan.kind === 'provider-fork';
      const shouldResume = canAttemptNativeResume;
      const shouldForkSession = shouldResume && recoveryPlan.kind === 'provider-fork';

      // Transition to respawning now that we know the strategy.
      // (Moved here from before the plan so we can include the strategy in waitReason.)
      if (triggeredByInterrupt && instance.status !== 'respawning') {
        this.deps.transitionState(instance, 'respawning');
        this.emitInterruptBoundary(instance, {
          phase: 'respawning',
          requestId: instance.interruptRequestId ?? generateId(),
          outcome: 'unresolved',
        });
        this.deps.queueUpdate(instanceId, 'respawning', instance.contextUsage, undefined, undefined, undefined, undefined, {
          activeTurnId: instance.activeTurnId,
          interruptRequestId: instance.interruptRequestId,
          interruptRequestedAt: instance.interruptRequestedAt,
          interruptPhase: instance.interruptPhase,
          lastTurnOutcome: instance.lastTurnOutcome,
          adapterGeneration: instance.adapterGeneration,
          recoveryMethod: shouldResume ? 'native' : (hasConversation ? 'replay' : 'fresh'),
        }, undefined, undefined, {
          kind: 'respawning',
          strategy: shouldResume ? 'native-resume' : 'fresh-replay',
          startedAt: Date.now(),
        });
      }

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.deps.resolveCliTypeForInstance(instance);
      if (this.shouldAbortRespawn(instanceId, instance)) {
        logger.info('Skipping respawn after interrupt after CLI resolution', {
          instanceId,
          status: this.deps.getInstance(instanceId)?.status,
        });
        return;
      }

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        bare: instance.bareMode === true,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.deps.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.deps.getChromeDevtoolsMcpOptions?.(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.deps.getBrowserGatewayMcpOptions?.(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        permissionHookPath: this.deps.getPermissionHookPath(instance.yoloMode),
      };
      let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        if (this.shouldAbortRespawn(instanceId, instance)) {
          await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'pre-spawn interrupt respawn cancellation');
          return;
        }

        logger.debug('Spawning new process after interrupt', { instanceId });
        let pid: number;
        let actuallyResumed = shouldResume;
        let recoveryInputSent = false;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.deps.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after interrupt');
          }
          instance.providerSessionId = newSessionId;
          await this.deps.waitForAdapterWritable(instanceId, 3000);
        } catch (spawnError) {
          if (this.shouldAbortRespawn(instanceId, instance)) {
            await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'interrupt respawn spawn cancelled');
            return;
          }

          // Resume failed (e.g., corrupted session with empty messages).
          // Fall back to a fresh session with replay continuity message.
          if (shouldResume) {
            logger.warn('Resume failed after interrupt, falling back to fresh session', {
              instanceId,
              error: spawnError instanceof Error ? spawnError.message : String(spawnError),
            });
            // Remove event listeners BEFORE terminating so the exit handler
            // doesn't treat the resume adapter's exit as a real instance exit
            // (which would set the instance to terminated/error state and clear
            // queued messages on the frontend).
            adapter.removeAllListeners();
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            await adapter.terminate(true).catch(() => {});

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            // Fresh session — unblock future resume attempts against the new id.
            instance.sessionResumeBlacklisted = false;
            // New fresh session is not yet persisted; block a premature
            // re-resume until its first turn settles.
            instance.providerSessionPersisted = false;
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            if (this.shouldAbortRespawn(instanceId, instance)) {
              await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'pre-spawn interrupt fallback cancellation');
              return;
            }

            pid = await adapter.spawn();
            actuallyResumed = false;
            instance.processId = pid;
            instance.providerSessionId = fallbackSessionId;
            await this.deps.waitForAdapterWritable(instanceId, 3000);

            if (hasConversation) {
              const fallbackHistory = await this.deps.buildFallbackHistory(instance, 'resume-failed-fallback');
              if (triggeredByInterrupt && this.deps.queueContinuityPreamble) {
                this.deps.queueContinuityPreamble(instanceId, fallbackHistory);
              } else {
                await adapter.sendInput(fallbackHistory);
                recoveryInputSent = true;
              }
            }
          } else {
            throw spawnError;
          }
        }
        if (this.shouldAbortRespawn(instanceId, instance)) {
          await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'post-spawn interrupt respawn cancellation');
          return;
        }

        instance.recoveryMethod = actuallyResumed ? 'native' : (hasConversation ? 'replay' : 'fresh');
        if (actuallyResumed) {
          // Clear any stale blacklist — resume just succeeded against this id.
          instance.sessionResumeBlacklisted = false;
          // A confirmed native resume proves the session is on disk.
          instance.providerSessionPersisted = true;
        }
        logger.info('Process respawned successfully', { instanceId, pid, resumed: actuallyResumed });

        instance.processId = pid;

        if (!actuallyResumed && shouldResume) {
          // Already sent continuity message in fallback path above
        } else if (!shouldResume && hasConversation) {
          const replayContinuity = this.deps.buildReplayContinuityMessage(instance, replayReason);
          if (triggeredByInterrupt && this.deps.queueContinuityPreamble) {
            this.deps.queueContinuityPreamble(instanceId, replayContinuity);
          } else {
            await adapter.sendInput(replayContinuity);
            recoveryInputSent = true;
          }
        }

        if (recoveryInputSent) {
          if (this.isInterruptRecoveryStatus(instance.status)) {
            this.deps.transitionState(instance, 'busy');
          }
        } else {
          this.deps.transitionState(instance, 'idle');
        }
        if (triggeredByInterrupt) {
          instance.interruptPhase = 'completed';
          instance.lastTurnOutcome = recoveryInputSent ? 'completed' : 'interrupted';
          this.emitInterruptBoundary(instance, {
            phase: 'completed',
            requestId: instance.interruptRequestId ?? generateId(),
            outcome: actuallyResumed ? 'respawn-success' : 'respawn-fallback',
            fallbackMode: actuallyResumed ? 'native-resume' : 'replay-fallback',
          });
        }
        instance.lastActivity = Date.now();

        const message = {
          id: generateId(),
          type: 'system' as const,
          content: triggeredByInterrupt
            ? (actuallyResumed || !canAttemptNativeResume
                ? 'Interrupted — waiting for input'
                : 'Interrupted — session restarted (resume failed)')
            : (actuallyResumed ? 'Session reconnected automatically' : 'Session restarted automatically (resume failed)'),
          timestamp: Date.now(),
          metadata: triggeredByInterrupt ? undefined : { autoRespawn: true, recoveryCause: 'stuck' },
        };
        this.deps.addToOutputBuffer(instance, message);
        this.deps.emitOutput(instanceId, message);

        instance.lastRespawnAt = Date.now();
        this.deps.queueUpdate(
          instanceId,
          instance.status,
          instance.contextUsage,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            activeTurnId: instance.activeTurnId,
            interruptRequestId: instance.interruptRequestId,
            interruptRequestedAt: instance.interruptRequestedAt,
            interruptPhase: instance.interruptPhase,
            lastTurnOutcome: instance.lastTurnOutcome,
            adapterGeneration: instance.adapterGeneration,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          },
          undefined,
          undefined,
          null, // clear waitReason — respawn complete
        );
        logger.info('Respawn after interrupt complete', { instanceId });
      } catch (error) {
        if (this.shouldAbortRespawn(instanceId, instance)) {
          const currentAdapter = this.deps.getAdapter(instanceId);
          if (currentAdapter) {
            await this.cleanupAbortedRespawnAdapter(instanceId, instance, currentAdapter, 'interrupt respawn error after cancellation');
          }
          return;
        }

        logger.error('Failed to spawn after interrupt', error instanceof Error ? error : undefined, { instanceId });
        this.deps.transitionState(instance, 'error');
        instance.processId = null;
        instance.recoveryMethod = 'failed';
        instance.lastTurnOutcome = 'failed';
        this.deps.queueUpdate(
          instanceId,
          'error',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            activeTurnId: instance.activeTurnId,
            interruptRequestId: instance.interruptRequestId,
            interruptRequestedAt: instance.interruptRequestedAt,
            interruptPhase: instance.interruptPhase,
            lastTurnOutcome: instance.lastTurnOutcome,
            adapterGeneration: instance.adapterGeneration,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          },
          undefined,
          undefined,
          null, // clear waitReason — error terminal state
        );
        throw error;
      }
    } finally {
      release();

      // Resolve the respawn promise so any sendInput() calls waiting on it
      // can proceed (or fail cleanly if the instance is now in error state).
      const resolveRespawn = respawnResolvers.get(instance);
      if (resolveRespawn) {
        resolveRespawn();
        respawnResolvers.delete(instance);
        instance.respawnPromise = undefined;
      }
    }
  }

  /**
   * Respawn an instance after its CLI process exited unexpectedly.
   * Uses --resume to reconnect to the existing CLI session.
   * Falls back to a fresh session with replay continuity if resume fails.
   */
  async respawnAfterUnexpectedExit(instanceId: string): Promise<void> {
    logger.info('Auto-respawning after unexpected exit', { instanceId });

    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // §6.3: Circuit breaker — exponential backoff on repeated unexpected exits.
    const exitBreaker = getOrCreateCircuitBreaker(instanceId);
    const breakerDelay = exitBreaker.recordAttempt();
    if (breakerDelay > 0) {
      this.deps.queueUpdate(instanceId, instance.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        kind: 'backoff',
        attempt: exitBreaker.snapshot().attempt,
        retryAt: Date.now() + breakerDelay,
      });
      await new Promise<void>(resolve => setTimeout(resolve, breakerDelay));
      this.deps.queueUpdate(instanceId, instance.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
    }

    const release = await getSessionMutex().acquire(instanceId, 'respawn-unexpected', {
      operation: 'respawn',
      recoveryReason: 'unexpected-exit',
      turnId: instance.activeTurnId,
      adapterGeneration: instance.adapterGeneration,
    });
    try {
      if (this.shouldAbortRespawn(instanceId, instance)) {
        logger.info('Skipping auto-respawn because instance is no longer recoverable', {
          instanceId,
          status: this.deps.getInstance(instanceId)?.status,
        });
        return;
      }

      // C5: Snapshot before discarding the crashed adapter.
      void getSessionContinuityManagerIfInitialized()
        ?.createSnapshot(instanceId, 'pre-respawn', 'State captured before unexpected-exit respawn', 'checkpoint')
        .catch(() => undefined);

      // Read capabilities from the previous adapter BEFORE deleting it.
      // The exit handler in instance-communication.ts no longer calls deleteAdapter
      // so the adapter is still available here.
      const previousAdapter = this.deps.getAdapter(instanceId);
      const capabilities = this.deps.getAdapterRuntimeCapabilities(previousAdapter);

      // Now clean up the previous adapter
      this.deps.deleteAdapter(instanceId);

      const sessionId = instance.sessionId;
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant',
      );
      // Skip --resume if the current id was poisoned (e.g. "No conversation
      // found" observed from a previous CLI process).
      const resumeBlacklisted = instance.sessionResumeBlacklisted === true;
      if (resumeBlacklisted) {
        logger.info('Skipping --resume for blacklisted session id in auto-respawn', {
          instanceId,
          sessionId,
        });
      }
      const recoveryPlan = planSessionRecovery({
        instanceId,
        reason: 'unexpected-exit',
        previousAdapterId: previousAdapter?.getName(),
        previousProviderSessionId: sessionId,
        provider: instance.provider,
        model: instance.currentModel,
        agent: instance.agentId,
        cwd: instance.workingDirectory,
        yolo: instance.yoloMode,
        executionLocation: instance.executionLocation.type,
        capabilities,
        activeTurnId: instance.activeTurnId,
        adapterGeneration: instance.adapterGeneration ?? 0,
        hasConversation,
        sessionResumeBlacklisted: resumeBlacklisted,
        providerSessionPersisted: instance.providerSessionPersisted,
      });
      const shouldResume =
        recoveryPlan.kind === 'native-resume' || recoveryPlan.kind === 'provider-fork';
      const shouldForkSession = recoveryPlan.kind === 'provider-fork';

      // Emit respawning waitReason for unexpected-exit path too.
      if (instance.status === 'respawning') {
        this.deps.queueUpdate(instanceId, 'respawning', undefined, undefined, undefined, undefined, undefined, {
          recoveryMethod: shouldResume ? 'native' : (hasConversation ? 'replay' : 'fresh'),
        }, undefined, undefined, {
          kind: 'respawning',
          strategy: shouldResume ? 'native-resume' : 'fresh-replay',
          startedAt: Date.now(),
        });
      }

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.deps.resolveCliTypeForInstance(instance);
      if (this.shouldAbortRespawn(instanceId, instance)) {
        logger.info('Skipping auto-respawn after CLI resolution', {
          instanceId,
          status: this.deps.getInstance(instanceId)?.status,
        });
        return;
      }

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        bare: instance.bareMode === true,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.deps.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.deps.getChromeDevtoolsMcpOptions?.(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.deps.getBrowserGatewayMcpOptions?.(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        permissionHookPath: this.deps.getPermissionHookPath(instance.yoloMode),
      };
      let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        if (this.shouldAbortRespawn(instanceId, instance)) {
          await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'pre-spawn auto-respawn cancellation');
          return;
        }

        let pid: number;
        let actuallyResumed = shouldResume;
        let recoveryInputSent = false;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.deps.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after unexpected exit');
          }
          instance.providerSessionId = newSessionId;
          await this.deps.waitForAdapterWritable(instanceId, 3000);
        } catch (spawnError) {
          if (this.shouldAbortRespawn(instanceId, instance)) {
            await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'auto-respawn spawn cancelled');
            return;
          }

          if (shouldResume) {
            logger.warn('Resume failed during auto-respawn, falling back to fresh session', {
              instanceId,
              error: spawnError instanceof Error ? spawnError.message : String(spawnError),
            });
            // Remove event listeners BEFORE terminating so the exit handler
            // doesn't treat the resume adapter's exit as a real instance exit
            // (which would set the instance to terminated/error state and clear
            // queued messages on the frontend).
            adapter.removeAllListeners();
            await adapter.terminate(true).catch(() => { /* ignore */ });

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            // Fresh session — unblock future resume attempts against the new id.
            instance.sessionResumeBlacklisted = false;
            // New fresh session is not yet persisted; block a premature
            // re-resume until its first turn settles.
            instance.providerSessionPersisted = false;
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            if (this.shouldAbortRespawn(instanceId, instance)) {
              await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'pre-spawn auto-respawn fallback cancellation');
              return;
            }

            pid = await adapter.spawn();
            actuallyResumed = false;
            instance.processId = pid;
            instance.providerSessionId = fallbackSessionId;
            await this.deps.waitForAdapterWritable(instanceId, 3000);

            if (hasConversation) {
              await adapter.sendInput(await this.deps.buildFallbackHistory(instance, 'auto-respawn-fallback'));
              recoveryInputSent = true;
            }
          } else {
            throw spawnError;
          }
        }
        if (this.shouldAbortRespawn(instanceId, instance)) {
          await this.cleanupAbortedRespawnAdapter(instanceId, instance, adapter, 'post-spawn auto-respawn cancellation');
          return;
        }

        instance.recoveryMethod = actuallyResumed ? 'native' : (hasConversation ? 'replay' : 'fresh');
        if (actuallyResumed) {
          // Clear any stale blacklist — resume just succeeded against this id.
          instance.sessionResumeBlacklisted = false;
          // A confirmed native resume proves the session is on disk.
          instance.providerSessionPersisted = true;
        }
        logger.info('Auto-respawn successful', { instanceId, pid, resumed: actuallyResumed });

        instance.processId = pid;

        if (!actuallyResumed && shouldResume) {
          // Already sent continuity message in fallback path
        } else if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.deps.buildReplayContinuityMessage(instance, 'auto-respawn'));
          recoveryInputSent = true;
        }

        if (recoveryInputSent) {
          if (instance.status === 'respawning') {
            this.deps.transitionState(instance, 'busy');
          }
        } else {
          this.deps.transitionState(instance, 'idle');
        }
        instance.lastActivity = Date.now();

        const message = {
          id: generateId(),
          type: 'system' as const,
          content: actuallyResumed
            ? 'Session reconnected automatically'
            : 'Session restarted automatically (resume failed)',
          timestamp: Date.now(),
          metadata: { autoRespawn: true },
        };
        this.deps.addToOutputBuffer(instance, message);
        this.deps.emitOutput(instanceId, message);

        instance.lastRespawnAt = Date.now();
        this.deps.queueUpdate(
          instanceId,
          instance.status,
          instance.contextUsage,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          },
          undefined,
          undefined,
          null, // clear waitReason — auto-respawn complete
        );
      } catch (error) {
        if (this.shouldAbortRespawn(instanceId, instance)) {
          const currentAdapter = this.deps.getAdapter(instanceId);
          if (currentAdapter) {
            await this.cleanupAbortedRespawnAdapter(instanceId, instance, currentAdapter, 'auto-respawn error after cancellation');
          }
          return;
        }

        logger.error('Auto-respawn failed', error instanceof Error ? error : undefined, { instanceId });
        this.deps.transitionState(instance, 'error');
        instance.processId = null;
        instance.recoveryMethod = 'failed';
        this.deps.queueUpdate(
          instanceId,
          'error',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          },
          undefined,
          undefined,
          null, // clear waitReason — error terminal state
        );
        throw error;
      }
    } finally {
      release();
    }
  }
}
