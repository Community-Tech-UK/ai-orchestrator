import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type {
  PairBothCandidate,
  WorkerModeSettings,
  WorkerModeStatus,
} from '../../../shared/types/pair-both.types';
import type { WindowManager } from '../../window-manager';
import {
  DEFAULT_CONFIG_PATH,
  loadWorkerConfig,
  type WorkerConfig,
} from '../../../worker-agent/worker-config';
import {
  PairBothCoordinatorStartPayloadSchema,
  PairBothManualPairingPayloadSchema,
  PairBothSessionPayloadSchema,
  PairBothWorkerConnectPayloadSchema,
  PairBothWorkerRunModePayloadSchema,
} from '@contracts/schemas/remote-node';
import { getRemoteAuthService } from '../../auth/remote-auth';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import {
  getRemoteNodeConfig,
  updateRemoteNodeConfig,
} from '../../remote-node/remote-node-config';
import { getWorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import {
  getWorkerModeRuntimeService,
  clearWorkerModeConfig,
  readWorkerModePairing,
  type WorkerModeRuntimeStatus,
} from '../../remote-node/worker-mode-runtime-service';
import {
  PairBothDiscoveryBrowser,
  PairBothDiscoveryPublisher,
} from '../../remote-node/pair-both-discovery';
import { PairBothRendezvousService } from '../../remote-node/pair-both-rendezvous-service';
import {
  getLocalIpv4Addresses,
  getTailscaleIpv4Address,
  getTailscaleMagicDnsName,
} from '../../util/network-addresses';
import {
  parsePairingConfigInput,
  writePairedWorkerConfig,
} from '../../../worker-agent/cli/pairing-config';
import { getActiveCoordinatorTailscaleWatcher } from '../../remote-node/coordinator-tailscale-watcher';
import { broadcastSettingsChanged } from './settings-broadcast';
import { getWorkerSignInTask } from '../../remote-node/worker-sign-in-task';
import { isSingleInstanceLockHeld } from '../../../worker-agent/single-instance-lock';
import {
  clearWorkerConnectionStatus,
  readWorkerConnectionStatus,
} from '../../../worker-agent/worker-connection-status';

const logger = getLogger('PairBothHandlers');

let service: PairBothRendezvousService | null = null;
let discoveryPublisher: PairBothDiscoveryPublisher | null = null;
let discoveryBrowser: PairBothDiscoveryBrowser | null = null;
let settingsWindow: Pick<WindowManager, 'sendToRenderer'> | null = null;

export interface PairBothHandlerDependencies {
  /** Used to tell the renderer about workerMode changes made here. */
  windowManager?: Pick<WindowManager, 'sendToRenderer'>;
}

export function registerPairBothHandlers(deps: PairBothHandlerDependencies = {}): void {
  settingsWindow = deps.windowManager ?? null;
  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_COORDINATOR_START,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = PairBothCoordinatorStartPayloadSchema.parse(payload);
        const config = getRemoteNodeConfig();
        await ensureRemoteNodeServerRunning();

        const coordinatorUrl = buildCoordinatorUrlForWorker(config.serverPort);
        const state = await getService().startCoordinatorPairing({
          host: validated?.host ?? config.serverHost,
          namespace: config.namespace,
          coordinatorUrl,
          ...(validated?.ttlMs ? { ttlMs: validated.ttlMs } : {}),
        });
        const candidate = getService().getLocalCandidate(
          state.sessionId,
          selectReachableHost(config.serverHost),
        );
        const discoveryDisabledReason = isLoopbackHost(config.serverHost)
          ? 'LAN discovery is disabled because the coordinator is bound to this computer only. Use QR or paste pairing instead.'
          : undefined;
        if (!discoveryDisabledReason) {
          getDiscoveryPublisher().publish(candidate);
        }

        return {
          success: true,
          data: {
            state,
            candidate,
            invitation: JSON.stringify(candidate),
            ...(discoveryDisabledReason ? { discoveryDisabledReason } : {}),
          },
        };
      } catch (error) {
        logger.warn('Failed to start pair-both coordinator session', {
          error: error instanceof Error ? error.message : String(error),
        });
        return failure('PAIR_BOTH_COORDINATOR_START_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_COORDINATOR_STOP,
    async (): Promise<IpcResponse> => {
      try {
        getDiscoveryPublisher().unpublish();
        await getService().shutdown();
        return { success: true };
      } catch (error) {
        return failure('PAIR_BOTH_COORDINATOR_STOP_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_COORDINATOR_APPROVE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const { sessionId } = PairBothSessionPayloadSchema.parse(payload);
        const state = await getService().approveCoordinatorPairing(sessionId);
        getDiscoveryPublisher().unpublish();
        return { success: true, data: state };
      } catch (error) {
        return failure('PAIR_BOTH_COORDINATOR_APPROVE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_COORDINATOR_REJECT,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const { sessionId } = PairBothSessionPayloadSchema.parse(payload);
        getDiscoveryPublisher().unpublish();
        return {
          success: true,
          data: getService().rejectCoordinatorPairing(sessionId),
        };
      } catch (error) {
        return failure('PAIR_BOTH_COORDINATOR_REJECT_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_COORDINATOR_STATE,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: getService().getCoordinatorState() };
      } catch (error) {
        return failure('PAIR_BOTH_COORDINATOR_STATE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_DISCOVER,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: await getDiscoveryBrowser().discover() };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_DISCOVER_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_CONNECT,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const { candidate } = PairBothWorkerConnectPayloadSchema.parse(payload);
        const state = await getService().connectWorkerToCandidate(candidate as PairBothCandidate);
        return { success: true, data: state };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_CONNECT_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_CONFIRM_CODE,
    async (): Promise<IpcResponse> => {
      try {
        await getService().confirmWorkerCode();
        return { success: true };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_CONFIRM_CODE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_WAIT_RESULT,
    async (): Promise<IpcResponse> => {
      try {
        const config = await getService().waitForWorkerPairingResult();
        return { success: true, data: sanitizeWorkerConfig(config) };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_WAIT_RESULT_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const { input } = PairBothManualPairingPayloadSchema.parse(payload);
        const parsed = parsePairingConfigInput(input);
        await stopEveryWorker();
        const config = writePairedWorkerConfig(DEFAULT_CONFIG_PATH, parsed);
        return { success: true, data: sanitizeWorkerConfig(config) };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_APPLY_MANUAL_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_RUN_MODE,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const { mode, openAtLogin } = PairBothWorkerRunModePayloadSchema.parse(payload);
        const runtime = await startWorkerRuntimeForMode(mode, openAtLogin);
        return { success: true, data: runtime };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_RUN_MODE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_STOP,
    async (): Promise<IpcResponse> => {
      try {
        const selected = signInWorkerSelected();
        // Pauses the sign-in task too, so its keep-alive does not restart it
        // (failing that, ends its worker directly).
        const selectedOutcome = selected ? await retireSignInWorkerBestEffort() : 'none';
        // Wait (bounded) for the worker to exit, so the page's next status
        // check does not still see it running.
        const runtime = await getWorkerModeRuntimeService().stopAndWait();
        // Then retire any leftover task Windows earlier refused to remove (after
        // the wait, so Harness's own worker no longer holds the lock).
        const outcome = selected ? selectedOutcome : await pauseLeftoverSignInTask();
        if (outcome === 'ended' || outcome === 'failed' || (selected && pairedWorkerHoldsLock())) {
          // Stop must not look done while a schedule can bring the worker back.
          throw new Error(SIGN_IN_TASK_LEFT_ENABLED_MESSAGE);
        }
        return { success: true, data: runtime };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_STOP_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: buildWorkerModeStatus() };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_STATUS_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR,
    async (): Promise<IpcResponse> => {
      try {
        const runtime = await getWorkerModeRuntimeService().stopAndWait();
        if (signInWorkerSelected()) {
          try {
            await getWorkerSignInTask().remove();
          } catch (error) {
            // Unpairing must still work; at least pause the task or end its worker.
            logger.warn('Could not remove the sign-in worker task while unpairing', {
              error: error instanceof Error ? error.message : String(error),
            });
            await retireSignInWorkerBestEffort();
          }
        } else {
          await pauseLeftoverSignInTask();
        }
        const workerMode = getSettingsManager().get('workerMode');
        // Keep the role: resetting it to 'unset' swapped the whole window for
        // the role picker. An unpaired worker simply shows the pair actions.
        persistWorkerMode({
          ...workerMode,
          runAtSignIn: false,
          lastCoordinatorName: undefined,
          lastCoordinatorUrl: undefined,
        });
        clearWorkerModeConfig(DEFAULT_CONFIG_PATH);
        clearWorkerConnectionStatus(DEFAULT_CONFIG_PATH);
        return { success: true, data: runtime };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_UNPAIR_FAILED', error);
      }
    },
  );
}

function getService(): PairBothRendezvousService {
  service ??= new PairBothRendezvousService({
    auth: getRemoteAuthService(),
    // A re-pair must not leave the old worker running on the old credential.
    beforeWorkerConfigWrite: () => stopEveryWorker(),
  });
  return service;
}

function signInWorkerSelected(): boolean {
  return getSettingsManager().get('workerMode').runAtSignIn === true
    && getWorkerSignInTask().isSupported();
}

/**
 * Stop whichever worker is running — Harness's own child and, on Windows, the
 * sign-in task's (paused, so its keep-alive does not restart it) — and wait
 * for both, before the worker config is rewritten.
 */
async function stopEveryWorker(): Promise<void> {
  await getWorkerModeRuntimeService().stopAndWait();
  if (signInWorkerSelected()) {
    // Best effort: a re-pair must not fail because Windows refused the pause.
    await retireSignInWorkerBestEffort();
  } else {
    await pauseLeftoverSignInTask();
  }
  // The old worker's report (say, "could not start") is about the old pairing.
  clearWorkerConnectionStatus(DEFAULT_CONFIG_PATH);
}

/**
 * Save workerMode and tell the renderer. Writes made here bypass the settings
 * IPC handlers, which are what normally broadcast, so without this the
 * renderer kept a stale role and later wrote it back.
 */
function persistWorkerMode(next: WorkerModeSettings): void {
  getSettingsManager().set('workerMode', next);
  if (settingsWindow) {
    broadcastSettingsChanged(settingsWindow, {
      key: 'workerMode',
      value: getSettingsManager().get('workerMode'),
    });
  }
}

/**
 * Pause a sign-in task the settings no longer point at: one Windows would not
 * let Harness remove (the fallback above). Left enabled, its keep-alive would
 * start a worker after Stop or with Harness closed. Never throws.
 */
async function pauseLeftoverSignInTask(): Promise<SignInRetireOutcome> {
  const signInTask = getWorkerSignInTask();
  if (!signInTask.isSupported()) {
    return 'none';
  }
  let state = { present: true, enabled: true }; // Unknown: assume the worst and try.
  try {
    state = await signInTask.getTaskState();
  } catch {
    // Fall through: ending its worker needs no task-scheduler rights.
  }
  if (!state.present) {
    return 'none';
  }
  if (state.enabled) {
    return retireSignInWorkerBestEffort();
  }
  // Disabled, but a worker from a half-finished pause may still be running.
  if (pairedWorkerHoldsLock()) {
    return (await endSignInWorkerBestEffort()) ? 'paused' : 'failed';
  }
  return 'none';
}

/** Whether some worker process holds this computer's one-worker lock for the saved pairing. */
function pairedWorkerHoldsLock(): boolean {
  try {
    const config = readWorkerModePairing(DEFAULT_CONFIG_PATH).config;
    return config?.nodeId
      ? isSingleInstanceLockHeld({ key: `${config.namespace}:${config.nodeId}` })
      : false;
  } catch {
    return false;
  }
}

async function endSignInWorkerBestEffort(): Promise<boolean> {
  try {
    await getWorkerSignInTask().endWorker();
    return true;
  } catch (error) {
    logger.warn('Could not end the sign-in worker', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * How far retiring a sign-in task got: `paused` (task disabled, worker ended),
 * `ended` (Windows refused the pause, but its worker was ended, so the task's
 * schedule can start it again), or `failed` (neither). `none`: nothing to do.
 */
type SignInRetireOutcome = 'none' | 'paused' | 'ended' | 'failed';

/** Plain advice for a task Windows would not let Harness pause. */
const SIGN_IN_TASK_LEFT_ENABLED_MESSAGE =
  'Windows would not let Harness pause the background worker\'s schedule, so the worker may start again by itself. To stop it for good, open Task Scheduler and disable "Harness Worker" in the Harness folder.';

async function retireSignInWorkerBestEffort(): Promise<SignInRetireOutcome> {
  const signInTask = getWorkerSignInTask();
  try {
    await signInTask.stop();
    return 'paused';
  } catch (error) {
    logger.warn('Could not pause the sign-in worker task; ending its worker', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // If this fails too, the lock wait before any start says plainly that
  // another worker is running.
  return (await endSignInWorkerBestEffort()) ? 'ended' : 'failed';
}

function getDiscoveryPublisher(): PairBothDiscoveryPublisher {
  discoveryPublisher ??= new PairBothDiscoveryPublisher();
  return discoveryPublisher;
}

function getDiscoveryBrowser(): PairBothDiscoveryBrowser {
  discoveryBrowser ??= new PairBothDiscoveryBrowser();
  return discoveryBrowser;
}

async function ensureRemoteNodeServerRunning(): Promise<void> {
  const config = getRemoteNodeConfig();
  if (!getWorkerNodeConnectionServer().isRunning()) {
    await getWorkerNodeConnectionServer().start(config.serverPort, config.serverHost);
  }
  getActiveCoordinatorTailscaleWatcher()?.start();
  if (!config.enabled) {
    updateRemoteNodeConfig({ enabled: true });
    getSettingsManager().set('remoteNodesEnabled', true);
  }
}

function buildCoordinatorUrlForWorker(port: number): string {
  return `ws://${selectReachableHost(getRemoteNodeConfig().serverHost)}:${port}`;
}

function selectReachableHost(configuredHost: string): string {
  if (configuredHost !== '0.0.0.0' && configuredHost !== '::') {
    return configuredHost;
  }
  return getTailscaleMagicDnsName()
    ?? getTailscaleIpv4Address()
    ?? getLocalIpv4Addresses()[0]
    ?? '127.0.0.1';
}

async function startWorkerRuntimeForMode(
  mode: 'run-while-open' | 'background-service' | 'sign-in-task',
  openAtLogin?: boolean,
): Promise<WorkerModeRuntimeStatus | undefined> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(DEFAULT_CONFIG_PATH);
  } catch {
    // Fixed message: a JSON parse error quotes part of the file, which holds
    // the worker's credentials, and this message is shown on the page.
    throw new Error('The worker config could not be read. Pair this computer again.');
  }
  const workerMode = getSettingsManager().get('workerMode');
  if (mode === 'sign-in-task') {
    const signInTask = getWorkerSignInTask();
    if (!signInTask.isSupported()) {
      throw new Error('Keeping the worker running with Harness closed is only available on Windows.');
    }
    // One worker per computer: hand over from Harness's own child first. The
    // task is set up before the settings change, so the role listener (which
    // resumes the task on entering the worker role) finds it registered.
    const runtime = getWorkerModeRuntimeService();
    const inAppWasRunning = runtime.status().state === 'running';
    const hadSignInWorker = signInWorkerSelected();
    await runtime.stopAndWait();
    try {
      // A worker started some other way (by hand, an older setup) would keep
      // the lock, and the task's worker would exit at once while the page
      // showed the other one's report as the background worker. End the
      // task's own worker first (install restarts it), then any lock still
      // held is someone else's.
      if (hadSignInWorker) {
        await endSignInWorkerBestEffort();
      } else {
        await pauseLeftoverSignInTask();
      }
      await waitForPreviousWorkerToExit(config);
      await signInTask.install(DEFAULT_CONFIG_PATH);
    } catch (error) {
      // Leave things as they were: no half-made task (settings would not
      // point at it, so nothing would ever remove it) competing with
      // Harness's own worker for the single-instance lock.
      if (!hadSignInWorker) {
        await signInTask.remove().catch(() => retireSignInWorkerBestEffort());
      }
      if (inAppWasRunning) {
        runtime.start({ configPath: DEFAULT_CONFIG_PATH });
      }
      throw error;
    }
    persistWorkerMode({
      ...workerMode,
      role: 'worker',
      runAtSignIn: true,
      installWorkerService: false,
      // The task brings the worker back at sign-in; opening Harness as well
      // is not needed, and its checkbox is hidden in this mode.
      openAtLogin: false,
    });
    return getWorkerModeRuntimeService().status();
  }
  if (mode === 'run-while-open' && signInWorkerSelected()) {
    // Switching back to "only while Harness is open": retire the task and its
    // worker so Harness's own child can take the single-instance lock. This is
    // also the fallback when Windows refused the task, so a failure to remove
    // it must not stop the worker from starting.
    try {
      await getWorkerSignInTask().remove();
    } catch (error) {
      logger.warn('Could not remove the sign-in worker task; pausing it and starting the worker anyway', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Pause the task and end its worker, so its keep-alive cannot bring the
      // old worker back to hold the lock; failing that, just end the worker.
      await retireSignInWorkerBestEffort();
    }
  } else if (mode === 'run-while-open') {
    // A task the settings no longer point at (Windows refused to remove it
    // earlier) may be running its worker: pause it, or at least end it.
    await pauseLeftoverSignInTask();
  }
  if (mode === 'run-while-open' && getWorkerModeRuntimeService().status().state !== 'running') {
    await waitForPreviousWorkerToExit(config);
  }
  // Running the worker makes this computer a worker. Without the role the
  // next launch skips autostart, so the pairing looked lost after a restart.
  if (mode === 'background-service') {
    persistWorkerMode({
      ...workerMode,
      role: 'worker',
      startWorkerOnLaunch: false,
      installWorkerService: true,
    });
    try {
      return await getWorkerModeRuntimeService().installService({
        configPath: DEFAULT_CONFIG_PATH,
        config,
      });
    } catch (error) {
      // No service exists, so do not leave settings claiming one does: that
      // disabled launch autostart and reported a service that never ran.
      persistWorkerMode(workerMode);
      throw new Error(toGuidedServiceInstallMessage(error));
    }
  }

  persistWorkerMode({
    ...workerMode,
    role: 'worker',
    startWorkerOnLaunch: true,
    installWorkerService: false,
    runAtSignIn: false,
    ...(openAtLogin === undefined ? {} : { openAtLogin }),
  });
  return getWorkerModeRuntimeService().start({ configPath: DEFAULT_CONFIG_PATH });
}

const PREVIOUS_WORKER_EXIT_WAIT_MS = 10_000;
const PREVIOUS_WORKER_POLL_MS = 250;

/**
 * One worker per computer: a new worker exits at once (silently) while an
 * earlier one still holds the lock, for example one still shutting down after
 * Stop. Give it a few seconds; then say plainly why Start cannot work yet.
 */
async function waitForPreviousWorkerToExit(config: WorkerConfig): Promise<void> {
  if (!config.nodeId) {
    return;
  }
  const key = `${config.namespace}:${config.nodeId}`;
  const deadline = Date.now() + PREVIOUS_WORKER_EXIT_WAIT_MS;
  while (isSingleInstanceLockHeld({ key })) {
    if (Date.now() >= deadline) {
      throw new Error(
        'Another copy of the worker is still running on this computer, so a new one cannot start yet. Wait a moment and press Start Worker again.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PREVIOUS_WORKER_POLL_MS));
  }
}

export function buildWorkerModeStatus(): WorkerModeStatus {
  const pairing = readWorkerModePairing(DEFAULT_CONFIG_PATH);
  const backgroundService = getSettingsManager().get('workerMode').installWorkerService;
  const runAtSignInAvailable = getWorkerSignInTask().isSupported();
  const runAtSignIn = signInWorkerSelected();
  const runtime = getWorkerModeRuntimeService().status();
  return {
    ...pairing,
    runtime: runAtSignIn
      // The task's worker is not a Harness child; its own single-instance
      // lock (same user, same temp folder) says whether it is alive.
      ? { state: isPairedWorkerRunning(pairing.config) ? 'running' : 'stopped' }
      // The OS service keeps its own copy of the config and is not a child of
      // Harness, so the in-app runtime reads "stopped" while the service works.
      : backgroundService && runtime.state === 'stopped' && !runtime.error
        ? { state: 'service-installed' }
        : runtime,
    backgroundService,
    runAtSignIn,
    runAtSignInAvailable,
    // Harness just asked its worker to stop: until it has exited, its last
    // report would read as a worker started outside Harness.
    connection: pairing.paired && !getWorkerModeRuntimeService().stoppedRecently()
      ? readWorkerConnectionStatus(DEFAULT_CONFIG_PATH, { expectedNodeId: pairing.config?.nodeId })
      : null,
  };
}

function isPairedWorkerRunning(config: WorkerModeStatus['config']): boolean {
  if (!config?.nodeId) {
    return false;
  }
  return isSingleInstanceLockHeld({ key: `${config.namespace}:${config.nodeId}` });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.startsWith('127.');
}

function toGuidedServiceInstallMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/elevat|administrator|permission|denied|privilege/i.test(message)) {
    return 'Installing the background worker service needs administrator permission. Run Harness as administrator, or choose "Run while Harness is open" for this computer.';
  }
  return message;
}

function sanitizeWorkerConfig(
  config: WorkerConfig,
  runtime?: WorkerModeRuntimeStatus,
): Record<string, unknown> {
  return {
    nodeId: config.nodeId,
    name: config.name,
    coordinatorUrl: config.coordinatorUrl,
    namespace: config.namespace,
    maxConcurrentInstances: config.maxConcurrentInstances,
    workingDirectories: config.workingDirectories,
    ...(runtime ? { runtime } : {}),
  };
}

function failure(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}
