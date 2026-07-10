import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { registerPairBothHandlers } from '../pair-both-handlers';
import type { PairBothCandidate, PairBothSessionState } from '../../../../shared/types/pair-both.types';

const mocks = vi.hoisted(() => ({
  remoteNodeConfig: {
    enabled: true,
    serverHost: '0.0.0.0',
    serverPort: 4878,
    namespace: 'default',
  },
  discover: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  shutdown: vi.fn(),
  startCoordinatorPairing: vi.fn(),
  getLocalCandidate: vi.fn(),
  getCoordinatorState: vi.fn(),
  approveCoordinatorPairing: vi.fn(),
  rejectCoordinatorPairing: vi.fn(),
  connectWorkerToCandidate: vi.fn(),
  confirmWorkerCode: vi.fn(),
  waitForWorkerPairingResult: vi.fn(),
  writePairedWorkerConfig: vi.fn(),
  parsePairingConfigInput: vi.fn(),
  loadWorkerConfig: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  updateSettings: vi.fn(),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(),
  installService: vi.fn(),
  clearWorkerConfig: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../auth/remote-auth', () => ({
  getRemoteAuthService: () => ({
    issuePairingCredential: vi.fn(),
  }),
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    set: mocks.setSetting,
    update: mocks.updateSettings,
    get: mocks.getSetting,
  }),
}));

vi.mock('../../../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => mocks.remoteNodeConfig,
  updateRemoteNodeConfig: vi.fn(),
}));

vi.mock('../../../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({
    isRunning: () => true,
    start: vi.fn(),
  }),
}));

vi.mock('../../../util/network-addresses', () => ({
  getLocalIpv4Addresses: () => ['192.168.1.20'],
  getTailscaleIpv4Address: () => null,
  getTailscaleMagicDnsName: () => null,
}));

vi.mock('../../../../worker-agent/cli/pairing-config', () => ({
  parsePairingConfigInput: mocks.parsePairingConfigInput,
  writePairedWorkerConfig: mocks.writePairedWorkerConfig,
}));

vi.mock('../../../../worker-agent/worker-config', () => ({
  DEFAULT_CONFIG_PATH: '/tmp/worker-node.json',
  loadWorkerConfig: mocks.loadWorkerConfig,
}));

vi.mock('../../../remote-node/pair-both-rendezvous-service', () => ({
  PairBothRendezvousService: vi.fn().mockImplementation(() => ({
    shutdown: mocks.shutdown,
    startCoordinatorPairing: mocks.startCoordinatorPairing,
    getLocalCandidate: mocks.getLocalCandidate,
    getCoordinatorState: mocks.getCoordinatorState,
    approveCoordinatorPairing: mocks.approveCoordinatorPairing,
    rejectCoordinatorPairing: mocks.rejectCoordinatorPairing,
    connectWorkerToCandidate: mocks.connectWorkerToCandidate,
    confirmWorkerCode: mocks.confirmWorkerCode,
    waitForWorkerPairingResult: mocks.waitForWorkerPairingResult,
  })),
}));

vi.mock('../../../remote-node/pair-both-discovery', () => ({
  PairBothDiscoveryBrowser: vi.fn().mockImplementation(() => ({
    discover: mocks.discover,
  })),
  PairBothDiscoveryPublisher: vi.fn().mockImplementation(() => ({
    publish: mocks.publish,
    unpublish: mocks.unpublish,
  })),
}));

vi.mock('../../../remote-node/worker-mode-runtime-service', () => ({
  clearWorkerModeConfig: mocks.clearWorkerConfig,
  getWorkerModeRuntimeService: () => ({
    start: mocks.startRuntime,
    stop: mocks.stopRuntime,
    installService: mocks.installService,
  }),
}));

type HandlerFn = (
  event: unknown,
  payload?: unknown,
) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;

function handlerFor(channel: string): HandlerFn {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as unknown as HandlerFn;
}

function makeCandidate(): PairBothCandidate {
  return {
    id: 'pair-both:session-1:192.168.1.20:49152',
    product: 'Harness',
    protocol: 'aio-worker-pair-v1',
    protocolVersion: '1',
    pairingSessionId: 'session-1',
    friendlyName: 'James MacBook',
    namespace: 'default',
    port: 49152,
    coordinatorPublicKey: 'public-key-material',
    expiresAt: Date.now() + 60_000,
    host: '192.168.1.20',
    addresses: ['192.168.1.20'],
  };
}

function makeState(candidate: PairBothCandidate): PairBothSessionState {
  return {
    sessionId: candidate.pairingSessionId,
    status: 'waiting',
    protocolVersion: candidate.protocolVersion,
    machineName: candidate.friendlyName,
    namespace: candidate.namespace,
    listenerPort: candidate.port,
    coordinatorUrl: 'ws://192.168.1.20:4878',
    expiresAt: candidate.expiresAt,
    coordinatorHello: {
      protocolVersion: candidate.protocolVersion,
      role: 'coordinator',
      machineName: candidate.friendlyName,
      nonce: 'coordinator-nonce',
      publicKey: candidate.coordinatorPublicKey,
      pairingSessionId: candidate.pairingSessionId,
    },
    workerConfirmed: false,
    coordinatorApproved: false,
    payloadDelivered: false,
  };
}

describe('pair-both IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remoteNodeConfig = {
      enabled: true,
      serverHost: '0.0.0.0',
      serverPort: 4878,
      namespace: 'default',
    };
    mocks.getSetting.mockReturnValue({
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
    });
    registerPairBothHandlers();
  });

  it('returns LAN discovery candidates from the pair-both discovery browser', async () => {
    const candidate = makeCandidate();
    mocks.discover.mockResolvedValueOnce([candidate]);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_DISCOVER)({});

    expect(response).toEqual({ success: true, data: [candidate] });
    expect(mocks.discover).toHaveBeenCalledTimes(1);
  });

  it('publishes public discovery metadata when coordinator pairing starts', async () => {
    const candidate = makeCandidate();
    const state = makeState(candidate);
    mocks.startCoordinatorPairing.mockResolvedValueOnce(state);
    mocks.getLocalCandidate.mockReturnValueOnce(candidate);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_COORDINATOR_START)({}, {});

    expect(response).toEqual({
      success: true,
      data: {
        state,
        candidate,
        invitation: JSON.stringify(candidate),
      },
    });
    expect(mocks.publish).toHaveBeenCalledWith(candidate);
  });

  it('returns the paired config without starting the worker before post-pair choice', async () => {
    mocks.waitForWorkerPairingResult.mockResolvedValueOnce({
      nodeId: 'node-1',
      name: 'Noah PC',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://192.168.1.20:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
      reconnectIntervalMs: 5_000,
      heartbeatIntervalMs: 10_000,
    });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_WAIT_RESULT)({});

    expect(response).toEqual({
      success: true,
      data: {
        nodeId: 'node-1',
        name: 'Noah PC',
        coordinatorUrl: 'ws://192.168.1.20:4878',
        namespace: 'default',
        maxConcurrentInstances: 10,
        workingDirectories: [],
      },
    });
    expect(mocks.startRuntime).not.toHaveBeenCalled();
    expect(mocks.installService).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('one-time-token');
  });

  it('skips LAN discovery publication when the coordinator host is loopback-only', async () => {
    mocks.remoteNodeConfig = {
      enabled: true,
      serverHost: '127.0.0.1',
      serverPort: 4878,
      namespace: 'default',
    };
    const candidate = makeCandidate();
    const state = makeState(candidate);
    mocks.startCoordinatorPairing.mockResolvedValueOnce(state);
    mocks.getLocalCandidate.mockReturnValueOnce({
      ...candidate,
      host: '127.0.0.1',
      addresses: ['127.0.0.1'],
    });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_COORDINATOR_START)({}, {});

    expect(response.success).toBe(true);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(response.data)).toContain('QR or paste');
  });

  it('starts the worker runtime after the post-pair run-while-open choice', async () => {
    const config = {
      nodeId: 'node-1',
      name: 'Noah PC',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://192.168.1.20:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
      reconnectIntervalMs: 5_000,
      heartbeatIntervalMs: 10_000,
    };
    mocks.loadWorkerConfig.mockReturnValueOnce(config);
    mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1234 });

    const response = await handlerFor('pair-both:worker:run-mode')({}, {
      mode: 'run-while-open',
    });

    expect(response).toEqual({
      success: true,
      data: { state: 'running', pid: 1234 },
    });
    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      startWorkerOnLaunch: true,
      installWorkerService: false,
    }));
    expect(mocks.startRuntime).toHaveBeenCalledWith({ configPath: '/tmp/worker-node.json' });
    expect(mocks.installService).not.toHaveBeenCalled();
  });

  it('installs the worker service after the post-pair background-service choice', async () => {
    const config = {
      nodeId: 'node-1',
      name: 'Noah PC',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://192.168.1.20:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
      reconnectIntervalMs: 5_000,
      heartbeatIntervalMs: 10_000,
    };
    mocks.loadWorkerConfig.mockReturnValueOnce(config);
    mocks.installService.mockResolvedValueOnce({
      state: 'service-installed',
      command: '/bin/aio-worker',
    });

    const response = await handlerFor('pair-both:worker:run-mode')({}, {
      mode: 'background-service',
    });

    expect(response.success).toBe(true);
    expect(mocks.installService).toHaveBeenCalledWith({
      configPath: '/tmp/worker-node.json',
      config,
    });
    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      startWorkerOnLaunch: false,
      installWorkerService: true,
    }));
    expect(JSON.stringify(response)).not.toContain('one-time-token');
  });

  it('stops the worker runtime through pair-both IPC', async () => {
    mocks.stopRuntime.mockReturnValueOnce({ state: 'stopped' });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

    expect(response).toEqual({ success: true, data: { state: 'stopped' } });
    expect(mocks.stopRuntime).toHaveBeenCalledTimes(1);
  });

  it('unpairs the worker without exposing persisted credentials', async () => {
    mocks.stopRuntime.mockReturnValueOnce({ state: 'stopped' });
    mocks.clearWorkerConfig.mockReturnValueOnce(undefined);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR)({});

    expect(response).toEqual({ success: true, data: { state: 'stopped' } });
    expect(mocks.stopRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      role: 'unset',
      lastCoordinatorName: undefined,
      lastCoordinatorUrl: undefined,
    }));
    expect(mocks.setSetting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearWorkerConfig.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(response)).not.toMatch(/token|credential/i);
  });
});
