/**
 * Idle Monitor
 *
 * Owns the periodic (60s) check loop extracted from InstanceLifecycleManager:
 *   - polls each instance's ActivityStateDetector
 *   - classifies detected failures and dispatches recovery via callback
 *   - auto-hibernates or auto-terminates truly idle instances
 *   - cleans up zombie adapters
 *
 * Also exposes `terminateIdleHalf()` for memory-pressure-driven termination.
 *
 * Behavior here is intentionally identical to the previous private methods in
 * instance-lifecycle.ts — this is extraction without logic change.
 */
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { ActivityStateDetector } from '../../providers/activity-state-detector';
import type { RecoveryRecipeEngine } from '../../session/recovery-recipe-engine';
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
import type { DetectedFailure } from '../../../shared/types/recovery.types';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';

const logger = getLogger('IdleMonitor');

const DEFAULT_INTERVAL_MS = 60_000;

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

export interface IdleMonitorDeps {
  // readers
  getSettings: () => { autoTerminateIdleMinutes: number };
  getRecoveryEngine: () => RecoveryRecipeEngine | null;
  getActivityDetectors: () => Map<string, ActivityStateDetector>;
  getInstance: (id: string) => Instance | undefined;
  forEachInstance: (cb: (instance: Instance, id: string) => void) => void;
  getAdapter: (id: string) => CliAdapter | undefined;

  // writers
  queueUpdate: QueueUpdate;
  deleteAdapter: (id: string) => void;
  transitionState: (instance: Instance, newState: InstanceStatus) => void;

  // callbacks back into the lifecycle layer
  terminateInstance: (id: string, graceful: boolean) => Promise<void>;
  hibernateInstance: (id: string) => Promise<void>;
  dispatchRecovery: (instanceId: string, failure: DetectedFailure) => Promise<void>;
}

export class IdleMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: IdleMonitorDeps) {}

  /** Start the periodic check timer. Safe to call multiple times (no-op if running). */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.check();
      this.cleanupZombieProcesses();
    }, intervalMs);
  }

  /** Stop the periodic check timer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass of the idle-check loop.
   * Polls activity detectors, dispatches recovery for detected failures,
   * and auto-hibernates/auto-terminates instances past their idle threshold.
   */
  check(): void {
    const recoveryEngine = this.deps.getRecoveryEngine();

    for (const [instanceId, detector] of this.deps.getActivityDetectors()) {
      detector
        .detect()
        .then((result) => {
          const instance = this.deps.getInstance(instanceId);
          if (!instance) return;

          const previousActivityState = instance.activityState;
          instance.activityState = result.state;
          if (previousActivityState !== result.state) {
            this.deps.queueUpdate(
              instanceId,
              instance.status,
              instance.contextUsage,
              undefined,
              undefined,
              undefined,
              instance.executionLocation,
              undefined,
              result.state,
            );
          }

          // Skip recovery detection for instances already being handled:
          // - 'respawning': auto-respawn from instance-communication.ts is in progress
          // - 'error': already failed, don't try to recover again
          // - 'initializing': still starting up
          // - 'terminated': intentionally stopped
          // Also skip remote instances for 'exited' detection — the local process
          // check cannot accurately determine if a remote process is alive.
          if (!recoveryEngine) return;

          const skipRecovery =
            instance.status === 'respawning' ||
            instance.status === 'error' ||
            instance.status === 'initializing' ||
            instance.status === 'terminated';
          if (skipRecovery) return;

          const isRemote = instance.executionLocation?.type === 'remote';

          let failure: DetectedFailure | null = null;

          if (result.state === 'blocked' && !isRemote) {
            failure = {
              id: generateId(),
              category: 'agent_stuck_blocked',
              instanceId,
              detectedAt: Date.now(),
              context: {},
              activityState: result.state,
              severity: 'recoverable',
            };
          } else if (result.state === 'exited' && !isRemote && instance.status !== 'terminated') {
            failure = {
              id: generateId(),
              category: 'process_exited_unexpected',
              instanceId,
              detectedAt: Date.now(),
              context: {},
              activityState: result.state,
              severity: 'recoverable',
            };
          }

          if (failure) {
            const detectedFailure = failure;
            recoveryEngine
              .handleFailure(detectedFailure)
              .then((outcome) => {
                logger.info('Recovery outcome', {
                  instanceId,
                  category: detectedFailure.category,
                  outcome: outcome.status,
                });
                this.deps.dispatchRecovery(instanceId, detectedFailure).catch((err) => {
                  logger.warn('Recovery action dispatch failed', { instanceId, error: String(err) });
                });
              })
              .catch((err) => {
                logger.warn('Recovery failed', { instanceId, error: String(err) });
              });
          }
        })
        .catch((err) => {
          logger.warn('Activity detection failed', { instanceId, error: String(err) });
        });
    }

    const settings = this.deps.getSettings();
    const idleMinutes = settings.autoTerminateIdleMinutes;

    if (idleMinutes <= 0) return;

    const idleThreshold = idleMinutes * 60 * 1000;
    const now = Date.now();

    this.deps.forEachInstance((instance) => {
      if (!instance.parentId) return;

      if (instance.status === 'idle' && now - instance.lastActivity > idleThreshold) {
        const hasUserMessages = instance.outputBuffer.some((msg: OutputMessage) => msg.type === 'user');

        if (hasUserMessages) {
          logger.info('Auto-hibernating idle instance (has conversation)', {
            instanceId: instance.id,
            displayName: instance.displayName,
            idleMinutes,
          });
          this.deps.hibernateInstance(instance.id).catch((err) => {
            logger.error('Auto-hibernate failed', err instanceof Error ? err : undefined, {
              instanceId: instance.id,
            });
          });
        } else {
          logger.info('Auto-terminating idle instance (no conversation)', {
            instanceId: instance.id,
            displayName: instance.displayName,
            idleMinutes,
          });
          void this.deps.terminateInstance(instance.id, true).catch((err) =>
            logger.error('Auto-terminate failed', err instanceof Error ? err : undefined, {
              instanceId: instance.id,
            }),
          );
        }
      }
    });
  }

  /**
   * Terminate half of the child idle instances, oldest-first.
   * Called from memory-pressure handlers.
   */
  terminateIdleHalf(): void {
    const idleInstances: Instance[] = [];
    this.deps.forEachInstance((instance) => {
      if (instance.status === 'idle' && instance.parentId) {
        idleInstances.push(instance);
      }
    });

    idleInstances.sort((a, b) => a.lastActivity - b.lastActivity);

    const toTerminate = Math.ceil(idleInstances.length / 2);
    for (let i = 0; i < toTerminate && i < idleInstances.length; i++) {
      logger.warn('Terminating idle instance due to memory pressure', {
        instanceId: idleInstances[i].id,
        displayName: idleInstances[i].displayName,
      });
      void this.deps.terminateInstance(idleInstances[i].id, true);
    }
  }

  /**
   * Scan for orphaned adapters and PIDs, and clean them up.
   *
   * Two-pass:
   *   1. Identify adapters whose instance is error/terminated but whose process is still running.
   *      Clear the adapter entry immediately if the process is not running.
   *      Also clear `instance.processId` if it claims a PID but no adapter is registered,
   *      and transition busy/initializing → error to avoid stuck states.
   *   2. Force-cleanup the zombie adapters identified in pass 1.
   */
  cleanupZombieProcesses(): void {
    const adapterEntriesToCleanup: string[] = [];

    this.deps.forEachInstance((instance, instanceId) => {
      const adapter = this.deps.getAdapter(instanceId);

      if (adapter && (instance.status === 'error' || instance.status === 'terminated')) {
        if (adapter.isRunning()) {
          logger.warn('Found zombie process, force killing', {
            instanceId,
            status: instance.status,
          });
          adapterEntriesToCleanup.push(instanceId);
        } else {
          this.deps.deleteAdapter(instanceId);
        }
      }

      if (instance.processId && !this.deps.getAdapter(instanceId)) {
        logger.warn('Instance claims PID but has no adapter, clearing PID', {
          instanceId,
          processId: instance.processId,
        });
        instance.processId = null;
        if (instance.status === 'busy' || instance.status === 'initializing') {
          this.deps.transitionState(instance, 'error');
          this.deps.queueUpdate(instanceId, 'error');
        }
      }
    });

    for (const instanceId of adapterEntriesToCleanup) {
      this.forceCleanupAdapter(instanceId).catch((err) => {
        logger.error('Failed to cleanup zombie process', err instanceof Error ? err : undefined, { instanceId });
      });
    }
  }

  /** Force-terminate an adapter and drop its registration. */
  async forceCleanupAdapter(instanceId: string): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) return;

    logger.info('Force cleaning up adapter', { instanceId });

    try {
      await adapter.terminate(false);
    } catch (error) {
      logger.error('Error during force cleanup', error instanceof Error ? error : undefined, { instanceId });
    } finally {
      this.deps.deleteAdapter(instanceId);
    }
  }
}
