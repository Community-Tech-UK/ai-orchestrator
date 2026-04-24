/**
 * Interrupt / Respawn Handler
 *
 * Owns the three-stage interrupt flow that used to live on
 * InstanceLifecycleManager:
 *   - `interrupt()`               — user-initiated ESC: interrupts the CLI
 *                                    and flips the instance into `respawning`.
 *                                    A second interrupt while respawning
 *                                    force-terminates the adapter.
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
  createCliAdapter,
  type CliAdapter,
  type UnifiedSpawnOptions,
} from '../../cli/adapters/adapter-factory';
import type { CliType } from '../../cli/cli-detection';
import type { AdapterRuntimeCapabilities } from '../../cli/adapters/base-cli-adapter';
import { getSessionMutex } from '../../session/session-mutex';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';
import type {
  ContextUsage,
  Instance,
  InstanceStatus,
  OutputMessage,
  SessionDiffStats,
} from '../../../shared/types/instance.types';
import type { ActivityState } from '../../../shared/types/activity.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { ErrorInfo } from '../../../shared/types/ipc.types';

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
    recoveryMethod?: Instance['recoveryMethod'];
    archivedUpToMessageId?: string;
    historyThreadId?: string;
  },
  activityState?: ActivityState,
) => void;

/**
 * Stash for respawn-promise resolvers. Keyed on Instance so the pending
 * respawn can be resolved (or discarded) without mutating the Instance type.
 * Module-scoped — the handler is the only writer/reader.
 */
const respawnResolvers = new WeakMap<Instance, () => void>();

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
  getMcpConfig: (location?: ExecutionLocation) => string[];
  getPermissionHookPath: (yoloMode: boolean) => string | undefined;
  waitForResumeHealth: (instanceId: string, timeoutMs?: number) => Promise<boolean>;
  waitForAdapterWritable: (instanceId: string, timeoutMs: number) => Promise<boolean>;
  buildReplayContinuityMessage: (instance: Instance, reason: string) => string;
  buildFallbackHistory: (instance: Instance, reason: string) => Promise<string>;

  /** Forward an 'output' event onto the lifecycle EventEmitter. */
  emitOutput: (instanceId: string, message: OutputMessage) => void;
}

export class InterruptRespawnHandler {
  constructor(private readonly deps: InterruptRespawnDeps) {}

  /**
   * Interrupt the currently-busy instance. Returns true if the interrupt
   * signal was delivered (and the instance transitioned into `respawning`).
   *
   * If the instance is already in `respawning` state, a second interrupt
   * force-terminates the adapter (user pressed Escape again while stuck).
   */
  interrupt(instanceId: string): boolean {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    if (!adapter || !instance) {
      logger.warn('Cannot interrupt instance: not found', { instanceId });
      return false;
    }

    // Force-terminate if already respawning (user pressed Escape again while stuck)
    if (instance.status === 'respawning') {
      logger.info('Force-terminating instance during respawning (second interrupt)', { instanceId });

      // Resolve the pending respawn promise so waiters don't hang
      const resolveRespawn = respawnResolvers.get(instance);
      if (resolveRespawn) {
        resolveRespawn();
        respawnResolvers.delete(instance);
        instance.respawnPromise = undefined;
      }

      // Force-kill the adapter (SIGKILL, no graceful wait)
      adapter.terminate(false).catch((err) => {
        logger.warn('Force-terminate during respawn failed', { error: err instanceof Error ? err.message : String(err), instanceId });
      });

      this.deps.clearInterrupted(instanceId);
      this.deps.transitionState(instance, 'error');
      instance.processId = null;
      this.deps.queueUpdate(instanceId, 'error', undefined, undefined, undefined,
        { message: 'Session interrupted — use restart to continue', code: 'FORCE_INTERRUPTED', timestamp: Date.now() });
      return true;
    }

    // Only allow interrupt when busy
    if (instance.status !== 'busy') {
      logger.warn('Cannot interrupt instance: not busy', { instanceId, status: instance.status });
      return false;
    }

    this.deps.markInterrupted(instanceId);

    const success = adapter.interrupt();
    if (success) {
      // Use 'respawning' status to prevent further interrupts during recovery
      this.deps.transitionState(instance, 'respawning');
      instance.lastActivity = Date.now();
      this.deps.queueUpdate(instanceId, 'respawning', instance.contextUsage);

      // Expose a promise that resolves when respawn completes.
      // sendInput() awaits this so messages sent during respawning are
      // held (not rejected) until the new adapter is ready.
      let resolveRespawn!: () => void;
      instance.respawnPromise = new Promise<void>((resolve) => {
        resolveRespawn = resolve;
      });
      respawnResolvers.set(instance, resolveRespawn);
    } else {
      this.deps.clearInterrupted(instanceId);
    }

    return success;
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
    const triggeredByInterrupt = instance.status === 'respawning';
    const replayReason = triggeredByInterrupt ? 'interrupt-respawn' : 'stuck-auto-respawn';

    const release = await getSessionMutex().acquire(instanceId, 'respawn-interrupt');
    try {
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
      const shouldResume =
        capabilities.supportsResume && Boolean(sessionId) && !resumeBlacklisted;
      const shouldForkSession = shouldResume && capabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.deps.resolveCliTypeForInstance(instance);

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.deps.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.deps.getPermissionHookPath(instance.yoloMode),
      };
      let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
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
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            actuallyResumed = false;
            instance.processId = pid;
            instance.providerSessionId = fallbackSessionId;
            await this.deps.waitForAdapterWritable(instanceId, 3000);

            if (hasConversation) {
              await adapter.sendInput(
                await this.deps.buildFallbackHistory(instance, 'resume-failed-fallback'),
              );
              recoveryInputSent = true;
            }
          } else {
            throw spawnError;
          }
        }
        instance.recoveryMethod = actuallyResumed ? 'native' : (hasConversation ? 'replay' : 'fresh');
        if (actuallyResumed) {
          // Clear any stale blacklist — resume just succeeded against this id.
          instance.sessionResumeBlacklisted = false;
        }
        logger.info('Process respawned successfully', { instanceId, pid, resumed: actuallyResumed });

        instance.processId = pid;

        if (!actuallyResumed && shouldResume) {
          // Already sent continuity message in fallback path above
        } else if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.deps.buildReplayContinuityMessage(instance, replayReason));
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
          content: triggeredByInterrupt
            ? (actuallyResumed ? 'Interrupted — waiting for input' : 'Interrupted — session restarted (resume failed)')
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
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          }
        );
        logger.info('Respawn after interrupt complete', { instanceId });
      } catch (error) {
        logger.error('Failed to spawn after interrupt', error instanceof Error ? error : undefined, { instanceId });
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
          }
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

    const release = await getSessionMutex().acquire(instanceId, 'respawn-unexpected');
    try {
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
      const shouldResume =
        capabilities.supportsResume && Boolean(sessionId) && !resumeBlacklisted;
      const shouldForkSession = shouldResume && capabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.deps.resolveCliTypeForInstance(instance);

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.deps.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.deps.getPermissionHookPath(instance.yoloMode),
      };
      let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
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
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

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
        instance.recoveryMethod = actuallyResumed ? 'native' : (hasConversation ? 'replay' : 'fresh');
        if (actuallyResumed) {
          // Clear any stale blacklist — resume just succeeded against this id.
          instance.sessionResumeBlacklisted = false;
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
          }
        );
      } catch (error) {
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
          }
        );
        throw error;
      }
    } finally {
      release();
    }
  }
}
