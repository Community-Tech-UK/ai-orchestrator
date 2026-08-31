import { getLogger } from '../logging/logger';
import {
  getGracefulShutdownManager,
  ShutdownPriority,
  type ShutdownReport,
} from './graceful-shutdown';

const logger = getLogger('HarnessShutdownOperations');

export interface HarnessShutdownDependencies {
  shutdownContinuitySync: () => void;
  killActiveProcessesSync: () => void;
  stopRemoteServices: () => void | Promise<void>;
  terminateInstances: () => void | Promise<void>;
  flushChatTranscripts: () => void | Promise<void>;
  teardownBootstrap: () => void | Promise<void>;
  flushObservability: () => void | Promise<void>;
  runCleanupRegistry: () => void | Promise<void>;
  stopCliSpawnWorker: () => void | Promise<void>;
  killOrphanedCliProcesses: () => void | Promise<void>;
}

export interface HarnessShutdownOperations {
  cleanupSync: () => void;
  cleanup: () => Promise<ShutdownReport>;
}

export function createHarnessShutdownOperations(
  dependencies: HarnessShutdownDependencies,
): HarnessShutdownOperations {
  return {
    cleanupSync: () => {
      try {
        dependencies.shutdownContinuitySync();
      } catch (error) {
        logger.error('Sync session save failed', error instanceof Error ? error : undefined);
      }

      try {
        dependencies.killActiveProcessesSync();
      } catch (error) {
        logger.error('Sync process kill failed', error instanceof Error ? error : undefined);
      }
    },
    cleanup: () => getGracefulShutdownManager().execute([
      {
        name: 'stop-remote-services',
        priority: ShutdownPriority.STOP_BACKGROUND,
        budgetMs: 1500,
        handler: dependencies.stopRemoteServices,
      },
      {
        name: 'terminate-instances',
        priority: ShutdownPriority.TERMINATE_INSTANCES,
        budgetMs: 8000,
        handler: dependencies.terminateInstances,
      },
      {
        name: 'flush-chat-transcripts',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 1,
        budgetMs: 2000,
        handler: dependencies.flushChatTranscripts,
      },
      {
        name: 'bootstrap-teardown',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 2,
        budgetMs: 3000,
        handler: dependencies.teardownBootstrap,
      },
      {
        name: 'flush-observability',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 3,
        budgetMs: 2500,
        handler: dependencies.flushObservability,
      },
      {
        name: 'cleanup-registry',
        priority: ShutdownPriority.FINAL_CLEANUP,
        budgetMs: 3000,
        handler: dependencies.runCleanupRegistry,
      },
      {
        name: 'stop-cli-spawn-worker',
        priority: ShutdownPriority.FINAL_CLEANUP + 1,
        budgetMs: 3000,
        handler: dependencies.stopCliSpawnWorker,
      },
      {
        name: 'kill-orphaned-cli-processes',
        priority: ShutdownPriority.FINAL_CLEANUP + 2,
        budgetMs: 4000,
        handler: dependencies.killOrphanedCliProcesses,
      },
    ]),
  };
}
