/**
 * Boot wiring for the Plan Queue: build the coordinator's dependencies from
 * the app singletons, then run recovery (relaxation restore, reconciler,
 * item re-attach). Runs after the loop store opens, beside Campaigns.
 */

import type { AppSettings } from '../../shared/types/settings.types';
import { getSettingsManager } from '../core/config/settings-manager';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getLoopStoreService } from '../orchestration/loop-store';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getPlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import { PlanQueueStore } from './plan-queue-store';

const logger = getLogger('PlanQueueBootstrap');

export async function initializePlanQueue(instanceManager: InstanceManager): Promise<void> {
  const db = getLoopStoreService().getDb();
  if (!db) {
    logger.warn('Plan queue not started: the loop database is unavailable');
    return;
  }
  const settings = getSettingsManager();
  const coordinator = getPlanQueueCoordinator();
  coordinator.initialize({
    store: new PlanQueueStore(db),
    instances: instanceManager,
    worktreeCreator: getWorktreeManager(),
    relaxation: new PlanQueueRelaxation({
      get: (key) => settings.get(key as keyof AppSettings),
      set: (key, value) => settings.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings]),
    }),
  });
  await coordinator.recover();
}
