import type { WorkerModeSettings } from '../../shared/types/pair-both.types';
import { DEFAULT_CONFIG_PATH } from '../../worker-agent/worker-config';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import {
  getWorkerModeRuntimeService,
  readWorkerModePairing,
  type WorkerModePairing,
  type WorkerModeRuntimeStatus,
} from './worker-mode-runtime-service';
import { getWorkerSignInTask, type WorkerSignInTask } from './worker-sign-in-task';

const logger = getLogger('WorkerModeAutostart');

export type WorkerModeAutostartReason =
  | 'not-worker-role'
  | 'background-service'
  | 'sign-in-task'
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
  signInTaskSupported?: boolean;
  readPairing?: (configPath: string) => Pick<WorkerModePairing, 'paired'>;
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
  if (workerMode.runAtSignIn && (options.signInTaskSupported ?? getWorkerSignInTask().isSupported())) {
    logger.info('Worker mode sign-in task is selected; it owns the worker');
    return { started: false, reason: 'sign-in-task' };
  }
  if (workerMode.installWorkerService) {
    logger.info('Worker mode background service is selected; OS service owns startup');
    return { started: false, reason: 'background-service' };
  }
  if (!workerMode.startWorkerOnLaunch) {
    return { started: false, reason: 'start-disabled' };
  }

  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const readPairing = options.readPairing ?? readWorkerModePairing;
  // A config file alone is not a pairing: an unpaired default config has no
  // coordinator, so the worker would exit at once and the supervisor would
  // churn through its crash-restart budget.
  let paired: boolean;
  try {
    paired = readPairing(configPath).paired;
  } catch (error) {
    logger.warn('Worker mode autostart could not read the worker config', {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { started: false, reason: 'missing-config' };
  }
  if (!paired) {
    logger.warn('Worker mode autostart skipped because this computer is not paired', { configPath });
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

interface WorkerModeRoleSource {
  get(key: 'workerMode'): WorkerModeSettings;
  on(event: 'setting:workerMode', listener: (value: WorkerModeSettings) => void): unknown;
}

type SignInTaskControl = Pick<WorkerSignInTask, 'isSupported' | 'start' | 'stop'>;

interface BindWorkerModeRoleLifecycleOptions {
  settings?: WorkerModeRoleSource;
  startIfPaired?: () => WorkerModeAutostartResult;
  stopRuntime?: () => void;
  signInTask?: SignInTaskControl;
}

/**
 * Keep the in-app worker in step with the computer's role. Choosing "Worker"
 * for an already-paired computer starts it (exactly as a relaunch would), and
 * leaving the worker role stops it — previously the worker kept running until
 * quit and then silently never came back, which looked like a lost pairing.
 */
export function bindWorkerModeRoleLifecycle(
  options: BindWorkerModeRoleLifecycleOptions = {},
): void {
  const settings: WorkerModeRoleSource = options.settings ?? getSettingsManager();
  const startIfPaired = options.startIfPaired ?? (() => maybeStartWorkerModeOnLaunch());
  const stopRuntime = options.stopRuntime ?? (() => { getWorkerModeRuntimeService().stop(); });
  const signInTask = options.signInTask ?? getWorkerSignInTask();
  let previousRole = settings.get('workerMode').role;

  const runTaskAction = (action: 'start' | 'stop'): void => {
    void signInTask[action]().catch((error: unknown) => {
      logger.warn(`Could not ${action} the sign-in worker after a role change`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  settings.on('setting:workerMode', (value) => {
    const role = value.role;
    if (role === previousRole) {
      return;
    }
    const leftWorkerRole = previousRole === 'worker';
    previousRole = role;
    const signInWorker = value.runAtSignIn === true && signInTask.isSupported();
    if (role === 'worker') {
      if (signInWorker) {
        runTaskAction('start');
        logger.info('Worker role selected; resuming the sign-in worker');
        return;
      }
      const result = startIfPaired();
      logger.info('Worker role selected', { started: result.started, reason: result.reason });
      return;
    }
    if (leftWorkerRole) {
      stopRuntime();
      if (signInWorker) {
        runTaskAction('stop');
      }
      logger.info('Worker role cleared; worker stopped', { role, signInWorker });
    }
  });
}

interface EnsureSignInWorkerOptions {
  settings?: { get(key: 'workerMode'): WorkerModeSettings };
  signInTask?: Pick<WorkerSignInTask, 'isSupported' | 'ensureCurrent'>;
  readPairing?: (configPath: string) => Pick<WorkerModePairing, 'paired'>;
  configPath?: string;
}

/**
 * Launch-time upkeep for the Windows sign-in worker: move it onto the worker
 * build bundled with this Harness (an update otherwise left it on the old
 * copy forever) and restore the task if it was deleted. Never throws.
 */
export async function ensureSignInWorkerOnLaunch(options: EnsureSignInWorkerOptions = {}): Promise<boolean> {
  const workerMode = (options.settings ?? getSettingsManager()).get('workerMode');
  const signInTask = options.signInTask ?? getWorkerSignInTask();
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  if (workerMode.role !== 'worker' || workerMode.runAtSignIn !== true || !signInTask.isSupported()) {
    return false;
  }
  try {
    if (!(options.readPairing ?? readWorkerModePairing)(configPath).paired) {
      return false;
    }
    return await signInTask.ensureCurrent(configPath);
  } catch (error) {
    logger.warn('Could not update the sign-in worker at launch', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

const SERVICE_CHECK_TIMEOUT_MS = 5_000;

interface StaleServiceFlagOptions {
  settings?: {
    get(key: 'workerMode'): WorkerModeSettings;
    set(key: 'workerMode', value: WorkerModeSettings): void;
  };
  isServiceInstalled?: () => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Clear an "OS service runs the worker" flag that no installed service backs.
 *
 * Earlier builds saved the flag before attempting the install, and from a
 * normal (non-admin) Harness that install always failed — on Windows it also
 * lacked its bundled service wrapper. A computer left with the flag skipped
 * launch autostart forever, so the worker never came back after a restart.
 * Returns true when the flag was cleared. An inconclusive check leaves the
 * settings alone.
 */
export async function reconcileStaleWorkerServiceFlag(
  options: StaleServiceFlagOptions = {},
): Promise<boolean> {
  const settings = options.settings ?? getSettingsManager();
  const workerMode = settings.get('workerMode');
  if (!workerMode.installWorkerService) {
    return false;
  }
  const isServiceInstalled = options.isServiceInstalled ?? defaultIsServiceInstalled;
  let installed: boolean;
  let timer: NodeJS.Timeout | undefined;
  try {
    installed = await Promise.race([
      isServiceInstalled(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out checking for the worker service')),
          options.timeoutMs ?? SERVICE_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    logger.warn('Could not check for the worker background service', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (installed) {
    return false;
  }
  settings.set('workerMode', {
    ...workerMode,
    installWorkerService: false,
    startWorkerOnLaunch: true,
  });
  logger.info('Cleared a background-service flag with no installed service; launch autostart restored');
  return true;
}

async function defaultIsServiceInstalled(): Promise<boolean> {
  const { createServiceManager } = await import('../../worker-agent/service/manager-factory');
  const manager = await createServiceManager();
  return manager.isInstalled();
}

