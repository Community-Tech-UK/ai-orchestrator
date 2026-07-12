import * as path from 'path';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import type { InstanceManager } from '../instance/instance-manager';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getContextWorkerClient } from '../instance/context-worker-client';
import { RlmStorageMaintenanceService } from './rlm-storage-maintenance';
import { RlmMaintenanceDatabaseAdapter } from './rlm-storage-maintenance-database';
import { registerCleanup } from '../util/cleanup-registry';
import type { Instance } from '../../shared/types/instance.types';

let service: RlmStorageMaintenanceService | null = null;

export function initializeRlmStorageMaintenance(
  instanceManager: InstanceManager,
): RlmStorageMaintenanceService {
  if (service) return service;
  const coordinator = getLoopCoordinator();
  let maintenanceActive = false;
  coordinator.setMaintenanceGate(() => maintenanceActive);
  service = new RlmStorageMaintenanceService({
    database: new RlmMaintenanceDatabaseAdapter(getRLMDatabase()),
    getProtectedSessionIds: () => getProtectedRlmSessionIds(instanceManager.getAllInstances()),
    setMaintenanceGate: (active) => { maintenanceActive = active; },
    reload: () => getContextWorkerClient().reloadRlmPersistence(),
    loopExists: (loopRunId) => coordinator.getLoop(loopRunId) !== undefined,
    resumeLoop: (loopRunId) => coordinator.resumeLoop(loopRunId),
    now: () => Date.now(),
    createOperationId: () => randomUUID(),
    backupDirectory: path.join(app.getPath('userData'), 'rlm', 'backups'),
  });
  registerCleanup(() => service?.requestShutdown());
  return service;
}

export function getProtectedRlmSessionIds(
  instances: Array<Pick<Instance, 'sessionId' | 'providerSessionId' | 'rlmStoreSessionId'>>,
): Set<string> {
  return new Set(
    instances.flatMap((instance) => [
      instance.rlmStoreSessionId,
      instance.sessionId,
      instance.providerSessionId,
    ]).filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
}

export function getRlmStorageMaintenance(): RlmStorageMaintenanceService {
  if (!service) throw new Error('RLM storage maintenance has not been initialized');
  return service;
}

export function _resetRlmStorageMaintenanceForTesting(): void {
  service = null;
  getLoopCoordinator().setMaintenanceGate(null);
}
