import { existsSync as defaultExistsSync } from 'node:fs';
import type { WorkerModeSettings } from '../../shared/types/pair-both.types';
import { DEFAULT_CONFIG_PATH } from '../../worker-agent/worker-config';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import {
  getWorkerModeRuntimeService,
  type WorkerModeRuntimeStatus,
} from './worker-mode-runtime-service';

const logger = getLogger('WorkerModeAutostart');

export type WorkerModeAutostartReason =
  | 'not-worker-role'
  | 'background-service'
  | 'start-disabled'
  | 'missing-config'
  | 'start-failed';

export interface WorkerModeAutostartResult {
  started: boolean;
  reason?: WorkerModeAutostartReason;
  status?: WorkerModeRuntimeStatus;
  error?: string;
}

interface WorkerModeAutostartOptions {
  configPath?: string;
  existsSync?: (path: string) => boolean;
  getWorkerMode?: () => WorkerModeSettings;
  startRuntime?: (configPath: string) => WorkerModeRuntimeStatus;
}

export function maybeStartWorkerModeOnLaunch(
  options: WorkerModeAutostartOptions = {},
): WorkerModeAutostartResult {
  const workerMode = options.getWorkerMode?.() ?? getSettingsManager().get('workerMode');
  if (workerMode.role !== 'worker') {
    return { started: false, reason: 'not-worker-role' };
  }
  if (workerMode.installWorkerService) {
    logger.info('Worker mode background service is selected; OS service owns startup');
    return { started: false, reason: 'background-service' };
  }
  if (!workerMode.startWorkerOnLaunch) {
    return { started: false, reason: 'start-disabled' };
  }

  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const existsSync = options.existsSync ?? defaultExistsSync;
  if (!existsSync(configPath)) {
    logger.warn('Worker mode autostart skipped because worker config is missing', { configPath });
    return { started: false, reason: 'missing-config' };
  }

  try {
    const status = options.startRuntime
      ? options.startRuntime(configPath)
      : getWorkerModeRuntimeService().start({ configPath });
    logger.info('Worker mode runtime started on launch', {
      state: status.state,
      pid: status.pid,
      command: status.command,
    });
    return { started: true, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Worker mode autostart failed', { error: message });
    return { started: false, reason: 'start-failed', error: message };
  }
}
