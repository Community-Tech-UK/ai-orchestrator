import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { PairBothCandidate } from '../../../shared/types/pair-both.types';
import type { WorkerConfig } from '../../../worker-agent/worker-config';
import {
  PairBothCoordinatorStartPayloadSchema,
  PairBothManualPairingPayloadSchema,
  PairBothSessionPayloadSchema,
  PairBothWorkerConnectPayloadSchema,
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
import { DEFAULT_CONFIG_PATH } from '../../../worker-agent/worker-config';

const logger = getLogger('PairBothHandlers');

let service: PairBothRendezvousService | null = null;
let discoveryPublisher: PairBothDiscoveryPublisher | null = null;
let discoveryBrowser: PairBothDiscoveryBrowser | null = null;

export function registerPairBothHandlers(): void {
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
        getDiscoveryPublisher().publish(candidate);

        return {
          success: true,
          data: {
            state,
            candidate,
            invitation: JSON.stringify(candidate),
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
        const runtime = startWorkerRuntimeIfConfigured();
        return { success: true, data: sanitizeWorkerConfig(config, runtime) };
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
        const config = writePairedWorkerConfig(DEFAULT_CONFIG_PATH, parsed);
        const runtime = startWorkerRuntimeIfConfigured();
        return { success: true, data: sanitizeWorkerConfig(config, runtime) };
      } catch (error) {
        return failure('PAIR_BOTH_WORKER_APPLY_MANUAL_FAILED', error);
      }
    },
  );
}

function getService(): PairBothRendezvousService {
  service ??= new PairBothRendezvousService({
    auth: getRemoteAuthService(),
  });
  return service;
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

function startWorkerRuntimeIfConfigured(): WorkerModeRuntimeStatus | undefined {
  const workerMode = getSettingsManager().get('workerMode');
  if (!workerMode.startWorkerOnLaunch) {
    return undefined;
  }
  if (workerMode.installWorkerService) {
    throw new Error(
      'Worker service installation from Worker Mode requires the service installer. Disable installWorkerService to run while Harness is open.',
    );
  }
  return getWorkerModeRuntimeService().start({ configPath: DEFAULT_CONFIG_PATH });
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
