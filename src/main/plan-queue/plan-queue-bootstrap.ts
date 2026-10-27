import { attachPlanQueueSpendRecorder } from './plan-queue-spend';
/**
 * Boot wiring for the Plan Queue: build the coordinator's dependencies from
 * the app singletons, then run recovery (relaxation restore, reconciler,
 * item re-attach). Runs after the loop store opens, beside Campaigns.
 */

import type { AppSettings } from '../../shared/types/settings.types';
import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES } from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../core/config/settings-manager';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getHistoryManager } from '../history/history-manager';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getLoopStoreService } from '../orchestration/loop-store';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getOrchestratorToolsRpcSocketPath } from '../mcp/orchestrator-tools-rpc-server';
import { getPlanQueueCoordinator } from './plan-queue-coordinator';
import { findRestoredSessionId } from './plan-queue-parent';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import { PlanQueueStore } from './plan-queue-store';

const logger = getLogger('PlanQueueBootstrap');
let planQueueStore: PlanQueueStore | null = null;
let stopSpendRecorder: (() => void) | undefined;

export function getPlanQueueStoreIfInitialized(): PlanQueueStore | null {
  return planQueueStore;
}

/**
 * The tools RPC server starts in a later boot step. Recovery must not spawn
 * a verifier until that socket exists, and this wait must not block the boot
 * step that starts the server.
 */
export function waitForOrchestratorToolsListening(): Promise<void> {
  if (getOrchestratorToolsRpcSocketPath()) return Promise.resolve();
  logger.info('Plan queue recovery is waiting for the orchestrator-tools RPC server');
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!getOrchestratorToolsRpcSocketPath()) return;
      clearInterval(timer);
      logger.info('Plan queue recovery continuing; orchestrator-tools RPC is listening', {
        waitedMs: Date.now() - started,
      });
      resolve();
    }, 50);
    timer.unref?.();
  });
}

export async function initializePlanQueue(instanceManager: InstanceManager): Promise<void> {
  const db = getLoopStoreService().getDb();
  if (!db) {
    logger.warn('Plan queue not started: the loop database is unavailable');
    return;
  }
  const settings = getSettingsManager();
  const coordinator = getPlanQueueCoordinator();
  planQueueStore = new PlanQueueStore(db);
  coordinator.initialize({
    store: planQueueStore,
    instances: instanceManager,
    worktreeCreator: getWorktreeManager(),
    relaxation: new PlanQueueRelaxation({
      get: (key) => settings.get(key as keyof AppSettings),
      set: (key, value) => settings.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings]),
    }),
    accountRules: {
      onChanged: (listener) => {
        const onSettingChanged = (key: string): void => {
          if (key === 'planQueueAccountRules') listener(settings.getAll().planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES);
        };
        settings.on('setting-changed', onSettingChanged);
        return () => { settings.off('setting-changed', onSettingChanged); };
      },
      persistPreferences: (instanceId, preferences) => {
        getSessionContinuityManager().updateState(instanceId, { accountPreferences: preferences }).catch((error: unknown) => logger.warn('Could not save a session\'s account preferences', {
          instanceId, error: error instanceof Error ? error.message : String(error),
        }));
      },
    },
    whenOrchestratorToolsListening: waitForOrchestratorToolsListening,
    findRestoredSession: (instanceId) =>
      findRestoredSessionId(instanceId, getHistoryManager().getEntries(), instanceManager.getAllInstances()),
  });
  stopSpendRecorder?.();
  stopSpendRecorder = attachPlanQueueSpendRecorder({ store: planQueueStore, getInstanceMetadata: (id) => instanceManager.getInstance(id)?.metadata, onRecorded: (runId, itemId) => { coordinator.emit('state-changed', { runId, itemId }); } });
  // Do not await. The tools socket is started by a later boot step; awaiting
  // here would deadlock recovery behind that step (LT-700).
  void coordinator.recover().catch((error: unknown) => {
    logger.warn('Plan queue recovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
