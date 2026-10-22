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
  runtimeStatus: vi.fn(),
  stopAndWait: vi.fn(),
  readPairing: vi.fn(),
  sendToRenderer: vi.fn(),
  signInSupported: vi.fn(() => true),
  signInInstall: vi.fn(),
  signInStop: vi.fn(),
  signInRemove: vi.fn(),
  signInEndWorker: vi.fn(),
  signInTaskState: vi.fn(),
  lockHeld: vi.fn(() => false),
  readConnection: vi.fn(() => null as unknown),
  stoppedRecently: vi.fn(() => false),
  clearConnection: vi.fn(),
  watcherStart: vi.fn(),
  // Options each PairBothRendezvousService was constructed with. A plain array
  // (not a mock) so vi.clearAllMocks() leaves it alone: the handler module
  // builds its service once and caches it across tests.
  rendezvousOptions: [] as Array<{ beforeWorkerConfigWrite?: () => Promise<unknown> | unknown }>,
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

vi.mock('../../../remote-node/coordinator-tailscale-watcher', () => ({
  getActiveCoordinatorTailscaleWatcher: () => ({ start: mocks.watcherStart }),
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
  PairBothRendezvousService: vi.fn().mockImplementation((options) => {
    mocks.rendezvousOptions.push(options);
    return {
      shutdown: mocks.shutdown,
      startCoordinatorPairing: mocks.startCoordinatorPairing,
      getLocalCandidate: mocks.getLocalCandidate,
      getCoordinatorState: mocks.getCoordinatorState,
      approveCoordinatorPairing: mocks.approveCoordinatorPairing,
      rejectCoordinatorPairing: mocks.rejectCoordinatorPairing,
      connectWorkerToCandidate: mocks.connectWorkerToCandidate,
      confirmWorkerCode: mocks.confirmWorkerCode,
      waitForWorkerPairingResult: mocks.waitForWorkerPairingResult,
    };
  }),
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
  readWorkerModePairing: mocks.readPairing,
  getWorkerModeRuntimeService: () => ({
    start: mocks.startRuntime,
    stop: mocks.stopRuntime,
    installService: mocks.installService,
    status: mocks.runtimeStatus,
    stopAndWait: mocks.stopAndWait,
    stoppedRecently: mocks.stoppedRecently,
  }),
}));

vi.mock('../../../remote-node/worker-sign-in-task', () => ({
  getWorkerSignInTask: () => ({
    isSupported: mocks.signInSupported,
    install: mocks.signInInstall,
    stop: mocks.signInStop,
    remove: mocks.signInRemove,
    endWorker: mocks.signInEndWorker,
    getTaskState: mocks.signInTaskState,
  }),
}));

vi.mock('../../../../worker-agent/single-instance-lock', () => ({
  isSingleInstanceLockHeld: mocks.lockHeld,
}));

vi.mock('../../../../worker-agent/worker-connection-status', () => ({
  readWorkerConnectionStatus: mocks.readConnection,
  clearWorkerConnectionStatus: mocks.clearConnection,
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
    mocks.stopAndWait.mockResolvedValue({ state: 'stopped' });
    mocks.runtimeStatus.mockReturnValue({ state: 'stopped' });
    mocks.lockHeld.mockReturnValue(false);
    mocks.stoppedRecently.mockReturnValue(false);
    mocks.signInTaskState.mockResolvedValue({ present: false, enabled: false });
    mocks.readPairing.mockReturnValue({ paired: false, enrolled: false, config: null });
    // The real task methods all return promises.
    mocks.signInRemove.mockResolvedValue(undefined);
    mocks.signInStop.mockResolvedValue(undefined);
    mocks.signInEndWorker.mockResolvedValue(undefined);
    registerPairBothHandlers({ windowManager: { sendToRenderer: mocks.sendToRenderer } });
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
    expect(mocks.watcherStart).toHaveBeenCalledOnce();
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
      role: 'worker',
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
      role: 'worker',
      startWorkerOnLaunch: false,
      installWorkerService: true,
    }));
    expect(JSON.stringify(response)).not.toContain('one-time-token');
  });

  it('restores the previous worker settings when the service install fails', async () => {
    const previous = {
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
    };
    mocks.getSetting.mockReturnValue(previous);
    mocks.loadWorkerConfig.mockReturnValueOnce({
      nodeId: 'node-1',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://192.168.1.20:4878',
    });
    mocks.installService.mockRejectedValueOnce(new Error('Access is denied'));

    const response = await handlerFor('pair-both:worker:run-mode')({}, {
      mode: 'background-service',
    });

    expect(response.success).toBe(false);
    expect(response.error?.message).toMatch(/administrator permission/);
    expect(mocks.setSetting).toHaveBeenLastCalledWith('workerMode', previous);
  });

  it('reports saved pairing and live runtime state for the Worker Mode page', async () => {
    mocks.getSetting.mockReturnValue({
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
    });
    mocks.readPairing.mockReturnValueOnce({
      paired: true,
      enrolled: true,
      config: { nodeId: 'node-1', name: 'Noah PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] },
    });
    mocks.runtimeStatus.mockReturnValueOnce({ state: 'running', pid: 42 });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

    expect(mocks.readPairing).toHaveBeenCalledWith('/tmp/worker-node.json');
    expect(response).toEqual({
      success: true,
      data: expect.objectContaining({
        paired: true,
        enrolled: true,
        runtime: { state: 'running', pid: 42 },
        backgroundService: false,
      }),
    });
  });

  it("includes the worker's own connection report for the paired node", async () => {
    const connection = {
      state: 'connected',
      coordinatorUrl: 'ws://mac:4878',
      since: 1,
      updatedAt: 2,
      alive: true,
      stale: false,
    };
    mocks.readPairing.mockReturnValueOnce({
      paired: true,
      enrolled: true,
      config: { nodeId: 'node-1', name: 'Noah PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] },
    });
    mocks.runtimeStatus.mockReturnValueOnce({ state: 'running', pid: 42 });
    mocks.readConnection.mockReturnValueOnce(connection);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

    expect(mocks.readConnection).toHaveBeenCalledWith('/tmp/worker-node.json', { expectedNodeId: 'node-1' });
    expect(response.data).toMatchObject({ connection });
  });

  it("hides the worker's last report while Harness's own stop is still finishing", async () => {
    mocks.readPairing.mockReturnValueOnce({
      paired: true,
      enrolled: true,
      config: { nodeId: 'node-1', name: 'Noah PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] },
    });
    mocks.stoppedRecently.mockReturnValueOnce(true);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

    expect(mocks.readConnection).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({ connection: null });
  });

  it('waits for a worker that is still shutting down before starting a new one', async () => {
    mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
    mocks.lockHeld.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 7 });

    const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

    expect(response.success).toBe(true);
    expect(mocks.lockHeld).toHaveBeenCalledWith({ key: 'default:node-1' });
    expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
  });

  it('says plainly when another worker keeps the computer busy', async () => {
    vi.useFakeTimers();
    try {
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.lockHeld.mockReturnValue(true);

      const pending = handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });
      await vi.advanceTimersByTimeAsync(11_000);
      const response = await pending;

      expect(response.success).toBe(false);
      expect(response.error?.message).toContain('Another copy of the worker is still running on this computer');
      expect(mocks.startRuntime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows config contents when the worker config cannot be read on Start', async () => {
    mocks.loadWorkerConfig.mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected token \'x\', "{"authToken":"secret-pass-value"x" is not valid JSON');
    });

    const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

    expect(response.success).toBe(false);
    expect(response.error?.message).toBe('The worker config could not be read. Pair this computer again.');
    expect(JSON.stringify(response)).not.toContain('secret-pass-value');
  });

  it("clears the old worker's report when new pairing details are written, and on unpair", async () => {
    mocks.parsePairingConfigInput.mockReturnValueOnce({ authToken: 'new-pass', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });
    mocks.writePairedWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', name: 'PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });

    await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL)({}, { input: 'pairing details' });
    expect(mocks.clearConnection).toHaveBeenCalledWith('/tmp/worker-node.json');
    expect(mocks.clearConnection.mock.invocationCallOrder[0]).toBeLessThan(mocks.writePairedWorkerConfig.mock.invocationCallOrder[0]);

    mocks.clearConnection.mockClear();
    await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR)({});
    expect(mocks.clearConnection).toHaveBeenCalledWith('/tmp/worker-node.json');
  });

  it('reports no connection for an unpaired computer', async () => {
    mocks.readPairing.mockReturnValueOnce({ paired: false, enrolled: false, config: null });
    mocks.runtimeStatus.mockReturnValueOnce({ state: 'stopped' });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

    expect(mocks.readConnection).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({ connection: null });
  });

  it('reports the background service as owning the worker when it is selected', async () => {
    mocks.getSetting.mockReturnValue({
      role: 'worker',
      startWorkerOnLaunch: false,
      installWorkerService: true,
    });
    mocks.readPairing.mockReturnValueOnce({ paired: true, enrolled: false, config: null });
    mocks.runtimeStatus.mockReturnValueOnce({ state: 'stopped' });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

    expect(response.data).toMatchObject({
      runtime: { state: 'service-installed' },
      backgroundService: true,
    });
  });

  it('stops the worker runtime through pair-both IPC and waits for it to exit', async () => {
    mocks.stopAndWait.mockResolvedValueOnce({ state: 'stopped' });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

    expect(response).toEqual({ success: true, data: { state: 'stopped' } });
    // Waiting means the page's next status check no longer sees it running.
    expect(mocks.stopAndWait).toHaveBeenCalledTimes(1);
  });

  it('stops the running worker before writing pasted pairing details', async () => {
    const parsed = { authToken: 'new-pass', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] };
    mocks.parsePairingConfigInput.mockReturnValueOnce(parsed);
    mocks.writePairedWorkerConfig.mockReturnValueOnce({
      nodeId: 'node-1',
      name: 'Noah PC',
      ...parsed,
    });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL)({}, { input: 'pairing link' });

    expect(response.success).toBe(true);
    expect(mocks.stopAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writePairedWorkerConfig.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(response)).not.toContain('new-pass');
  });

  it('stops every worker before the QR/LAN rendezvous writes the new worker config', async () => {
    mocks.getSetting.mockReturnValue({
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
      runAtSignIn: true,
    });
    const order: string[] = [];
    mocks.stopAndWait.mockImplementation(async () => {
      order.push('stop-in-app-worker');
      return { state: 'stopped' };
    });
    mocks.signInStop.mockImplementationOnce(async () => {
      order.push('stop-sign-in-worker');
    });
    // Stands in for the real rendezvous service: it runs the callback the
    // handler handed it, then writes the delivered config.
    mocks.connectWorkerToCandidate.mockImplementationOnce(async () => {
      await mocks.rendezvousOptions.at(-1)?.beforeWorkerConfigWrite?.();
      order.push('write-worker-config');
      return makeState(makeCandidate());
    });

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_CONNECT)({}, {
      candidate: makeCandidate(),
    });

    expect(response.success).toBe(true);
    expect(mocks.rendezvousOptions.at(-1)?.beforeWorkerConfigWrite).toBeTypeOf('function');
    expect(order).toEqual(['stop-in-app-worker', 'stop-sign-in-worker', 'write-worker-config']);
  });

  it('saves the open-at-sign-in choice with the run-while-open start', async () => {
    mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
    mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });

    await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open', openAtLogin: true });

    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
      openAtLogin: true,
    }));
  });

  it('leaves the open-at-sign-in choice alone when the start does not mention it', async () => {
    mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, openAtLogin: true });
    mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
    mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });

    await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({ openAtLogin: true }));
  });

  it('tells the renderer about workerMode changes it saves', async () => {
    mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
    mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });
    const saved = { role: 'worker', startWorkerOnLaunch: true, installWorkerService: false };
    mocks.getSetting.mockReturnValue(saved);

    await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

    expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, {
      key: 'workerMode',
      value: saved,
    });
  });

  it('unpairs the worker without exposing persisted credentials', async () => {
    mocks.clearWorkerConfig.mockReturnValueOnce(undefined);

    const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR)({});

    expect(response).toEqual({ success: true, data: { state: 'stopped' } });
    // Waits for the worker to exit so it cannot write the config back.
    expect(mocks.stopAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearWorkerConfig.mock.invocationCallOrder[0],
    );
    expect(mocks.sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.SETTINGS_CHANGED,
      expect.objectContaining({ key: 'workerMode' }),
    );
    expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      lastCoordinatorName: undefined,
      lastCoordinatorUrl: undefined,
    }));
    // Unpairing leaves the role alone so the window is not swapped for the
    // full-screen role picker.
    expect(mocks.setSetting.mock.calls[0]?.[1]).toMatchObject({ role: 'worker' });
    expect(mocks.setSetting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearWorkerConfig.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(response)).not.toMatch(/token|credential/i);
  });

  describe('sign-in worker (Windows)', () => {
    const paired = {
      paired: true,
      enrolled: true,
      config: { nodeId: 'node-1', name: 'PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] },
    };

    it('hands the worker to the sign-in task, then saves the mode', async () => {
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.signInInstall.mockResolvedValueOnce(undefined);
      mocks.runtimeStatus.mockReturnValue({ state: 'stopped' });

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(true);
      expect(mocks.stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(mocks.signInInstall.mock.invocationCallOrder[0]);
      expect(mocks.signInInstall).toHaveBeenCalledWith('/tmp/worker-node.json');
      expect(mocks.signInInstall.mock.invocationCallOrder[0]).toBeLessThan(mocks.setSetting.mock.invocationCallOrder[0]);
      expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({
        role: 'worker',
        runAtSignIn: true,
        installWorkerService: false,
        openAtLogin: false,
      }));
      expect(mocks.startRuntime).not.toHaveBeenCalled();
    });

    it('cleans up and restores the previous worker when the task cannot be set up', async () => {
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.runtimeStatus.mockReturnValueOnce({ state: 'running', pid: 7 });
      mocks.signInInstall.mockRejectedValueOnce(new Error('Windows task setup failed: Access is denied.'));
      mocks.signInRemove.mockResolvedValueOnce(undefined);

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(false);
      expect(response.error?.message).toContain('Access is denied');
      expect(mocks.setSetting).not.toHaveBeenCalled();
      expect(mocks.signInRemove).toHaveBeenCalledTimes(1);
      expect(mocks.startRuntime).toHaveBeenCalledWith({ configPath: '/tmp/worker-node.json' });
    });

    it('keeps an existing sign-in setup when re-choosing the mode fails', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.runtimeStatus.mockReturnValueOnce({ state: 'stopped' });
      mocks.signInInstall.mockRejectedValueOnce(new Error('Windows task setup failed: busy'));

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(false);
      expect(mocks.signInRemove).not.toHaveBeenCalled();
      expect(mocks.startRuntime).not.toHaveBeenCalled();
    });

    it('refuses the mode where it is not supported', async () => {
      mocks.signInSupported.mockReturnValueOnce(false);
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1' });

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.error?.message).toMatch(/only available on Windows/);
      expect(mocks.signInInstall).not.toHaveBeenCalled();
    });

    it('retires the task when switching back to only-while-open', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });

      await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

      expect(mocks.signInRemove).toHaveBeenCalledTimes(1);
      expect(mocks.signInRemove.mock.invocationCallOrder[0]).toBeLessThan(mocks.startRuntime.mock.invocationCallOrder[0]);
      expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({ runAtSignIn: false }));
    });

    it('still starts the worker when Windows will not remove the old task (the fallback path)', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.signInRemove.mockRejectedValueOnce(new Error('Unregister-ScheduledTask : Access is denied.'));
      mocks.signInStop.mockResolvedValueOnce(undefined);
      mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

      expect(response.success).toBe(true);
      // The task is paused (and its worker ended) so its keep-alive cannot hold the lock.
      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
      expect(mocks.signInStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.startRuntime.mock.invocationCallOrder[0]);
      expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
    });

    it('ends the old worker directly when Windows will not pause its task either, then starts', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.signInRemove.mockRejectedValueOnce(new Error('Access is denied.'));
      mocks.signInStop.mockRejectedValueOnce(new Error('Access is denied.'));
      // The old worker holds the lock until it is ended.
      let oldWorkerAlive = true;
      mocks.signInEndWorker.mockImplementationOnce(async () => { oldWorkerAlive = false; });
      mocks.lockHeld.mockImplementation(() => oldWorkerAlive);
      mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 1 });

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

      expect(response.success).toBe(true);
      expect(mocks.signInEndWorker).toHaveBeenCalledTimes(1);
      expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
    });

    it('says plainly that another worker is running when nothing can end the old one', async () => {
      vi.useFakeTimers();
      try {
        mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
        mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
        mocks.signInRemove.mockRejectedValueOnce(new Error('Access is denied.'));
        mocks.signInStop.mockRejectedValueOnce(new Error('Access is denied.'));
        mocks.signInEndWorker.mockRejectedValueOnce(new Error('Access is denied.'));
        mocks.lockHeld.mockReturnValue(true);

        const pending = handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });
        await vi.advanceTimersByTimeAsync(11_000);
        const response = await pending;

        expect(response.success).toBe(false);
        expect(response.error?.message).toContain('Another copy of the worker is still running on this computer');
        expect(mocks.startRuntime).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('Stop also pauses a leftover task that Windows would not let Harness remove', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: false });
      mocks.signInTaskState.mockResolvedValueOnce({ present: true, enabled: true });
      mocks.signInStop.mockResolvedValueOnce(undefined);

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(response.success).toBe(true);
      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
    });

    it('Stop leaves Windows alone when there is no leftover task', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: false });

      await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(mocks.signInTaskState).toHaveBeenCalledTimes(1);
      expect(mocks.signInStop).not.toHaveBeenCalled();
      expect(mocks.signInEndWorker).not.toHaveBeenCalled();
    });

    it('will not set up the background worker while a different worker holds the computer', async () => {
      vi.useFakeTimers();
      try {
        mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
        mocks.lockHeld.mockReturnValue(true);

        const pending = handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });
        await vi.advanceTimersByTimeAsync(11_000);
        const response = await pending;

        expect(response.success).toBe(false);
        expect(response.error?.message).toContain('Another copy of the worker is still running on this computer');
        expect(mocks.signInInstall).not.toHaveBeenCalled();
        expect(mocks.setSetting).not.toHaveBeenCalledWith('workerMode', expect.objectContaining({ runAtSignIn: true }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends the half-made task\'s worker when Windows will not remove it after a failed setup', async () => {
      mocks.loadWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' });
      mocks.signInInstall.mockRejectedValueOnce(new Error('Register-ScheduledTask failed'));
      mocks.signInRemove.mockRejectedValueOnce(new Error('Access is denied.'));
      mocks.signInStop.mockResolvedValueOnce(undefined);

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(false);
      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
    });

    const onlyWhileOpen = { role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: false };
    const pairedConfig = { nodeId: 'node-1', namespace: 'default', authToken: 'pass', coordinatorUrl: 'ws://mac:4878' };

    it('Start (only while open) clears a leftover task whose worker holds the computer, then starts', async () => {
      mocks.getSetting.mockReturnValue(onlyWhileOpen);
      mocks.loadWorkerConfig.mockReturnValueOnce(pairedConfig);
      mocks.signInTaskState.mockResolvedValueOnce({ present: true, enabled: true });
      let leftoverAlive = true;
      mocks.signInStop.mockImplementationOnce(async () => { leftoverAlive = false; });
      mocks.lockHeld.mockImplementation(() => leftoverAlive);
      mocks.startRuntime.mockReturnValueOnce({ state: 'running', pid: 3 });

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'run-while-open' });

      expect(response.success).toBe(true);
      expect(mocks.signInStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.startRuntime.mock.invocationCallOrder[0]);
    });

    it('still tries to pause a leftover task when its state cannot be read', async () => {
      mocks.getSetting.mockReturnValue(onlyWhileOpen);
      mocks.signInTaskState.mockRejectedValueOnce(new Error('Task Scheduler unavailable'));

      await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
    });

    it('ends a worker still running under a disabled leftover task', async () => {
      mocks.getSetting.mockReturnValue(onlyWhileOpen);
      mocks.signInTaskState.mockResolvedValueOnce({ present: true, enabled: false });
      mocks.readPairing.mockReturnValue(paired);
      mocks.lockHeld.mockReturnValue(true);

      await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(mocks.signInStop).not.toHaveBeenCalled();
      expect(mocks.signInEndWorker).toHaveBeenCalledTimes(1);
    });

    const scheduleLeftEnabled = 'Windows would not let Harness pause the background worker\'s schedule, so the worker may start again by itself. To stop it for good, open Task Scheduler and disable "Harness Worker" in the Harness folder.';

    it('Stop ends the background worker directly when Windows will not pause its task, and says the schedule may restart it', async () => {
      mocks.getSetting.mockReturnValue({ ...onlyWhileOpen, runAtSignIn: true });
      mocks.readPairing.mockReturnValue(paired);
      mocks.signInStop.mockRejectedValueOnce(new Error('Access is denied.'));
      let alive = true;
      mocks.signInEndWorker.mockImplementationOnce(async () => { alive = false; });
      mocks.lockHeld.mockImplementation(() => alive);

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(mocks.signInEndWorker).toHaveBeenCalledTimes(1);
      expect(alive).toBe(false);
      // Not "stopped": the task's schedule can start it again.
      expect(response.success).toBe(false);
      expect(response.error?.message).toBe(scheduleLeftEnabled);
    });

    it('Stop says plainly when nothing could stop the background worker', async () => {
      mocks.getSetting.mockReturnValue({ ...onlyWhileOpen, runAtSignIn: true });
      mocks.readPairing.mockReturnValue(paired);
      mocks.signInStop.mockRejectedValueOnce(new Error('Access is denied.'));
      mocks.signInEndWorker.mockRejectedValueOnce(new Error('Access is denied.'));
      mocks.lockHeld.mockReturnValue(true);

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(response.success).toBe(false);
      expect(response.error?.message).toBe(scheduleLeftEnabled);
    });

    it('a normal Stop with no task never blames Windows, even while Harness\'s own worker still holds the lock', async () => {
      mocks.getSetting.mockReturnValue(onlyWhileOpen);
      mocks.readPairing.mockReturnValue(paired);
      mocks.lockHeld.mockReturnValue(true);
      mocks.signInEndWorker.mockRejectedValue(new Error('should not be called'));

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(response.success).toBe(true);
      expect(mocks.signInEndWorker).not.toHaveBeenCalled();
      expect(mocks.stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(mocks.signInTaskState.mock.invocationCallOrder[0]);
    });

    it('unpairs even when Windows will not remove the background task', async () => {
      mocks.getSetting.mockReturnValue({ ...onlyWhileOpen, runAtSignIn: true });
      mocks.signInRemove.mockRejectedValueOnce(new Error('Access is denied.'));

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR)({});

      expect(response.success).toBe(true);
      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
      expect(mocks.clearWorkerConfig).toHaveBeenCalledWith('/tmp/worker-node.json');
    });

    it('re-pairs even when Windows will not pause the background task', async () => {
      mocks.getSetting.mockReturnValue({ ...onlyWhileOpen, runAtSignIn: true });
      mocks.signInStop.mockRejectedValueOnce(new Error('Access is denied.'));
      mocks.parsePairingConfigInput.mockReturnValueOnce({ authToken: 'new-pass', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });
      mocks.writePairedWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', name: 'PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL)({}, { input: 'pairing details' });

      expect(response.success).toBe(true);
      expect(mocks.signInEndWorker).toHaveBeenCalledTimes(1);
      expect(mocks.writePairedWorkerConfig).toHaveBeenCalledTimes(1);
    });

    it('choosing the background mode clears a leftover task holding the computer instead of falling back', async () => {
      mocks.getSetting.mockReturnValue(onlyWhileOpen);
      mocks.loadWorkerConfig.mockReturnValueOnce(pairedConfig);
      mocks.signInTaskState.mockResolvedValueOnce({ present: true, enabled: true });
      let leftoverAlive = true;
      mocks.signInStop.mockImplementationOnce(async () => { leftoverAlive = false; });
      mocks.lockHeld.mockImplementation(() => leftoverAlive);

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(true);
      expect(mocks.signInInstall).toHaveBeenCalledTimes(1);
      expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({ runAtSignIn: true }));
    });

    it('re-choosing the background mode ends its own worker first, then checks nothing else holds the computer', async () => {
      mocks.getSetting.mockReturnValue({ ...onlyWhileOpen, runAtSignIn: true });
      mocks.loadWorkerConfig.mockReturnValueOnce(pairedConfig);
      let ownWorkerAlive = true;
      mocks.signInEndWorker.mockImplementationOnce(async () => { ownWorkerAlive = false; });
      mocks.lockHeld.mockImplementation(() => ownWorkerAlive);

      const response = await handlerFor('pair-both:worker:run-mode')({}, { mode: 'sign-in-task' });

      expect(response.success).toBe(true);
      expect(mocks.signInEndWorker.mock.invocationCallOrder[0]).toBeLessThan(mocks.signInInstall.mock.invocationCallOrder[0]);
    });

    it('Stop pauses the sign-in worker', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STOP)({});

      expect(response.success).toBe(true);
      expect(mocks.signInStop).toHaveBeenCalledTimes(1);
    });

    it('pauses the sign-in worker before pasted pairing details are written', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.parsePairingConfigInput.mockReturnValueOnce({ authToken: 'p', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });
      mocks.writePairedWorkerConfig.mockReturnValueOnce({ nodeId: 'node-1', name: 'PC', coordinatorUrl: 'ws://mac:4878', namespace: 'default', maxConcurrentInstances: 10, workingDirectories: [] });

      await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL)({}, { input: 'link' });

      expect(mocks.signInStop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writePairedWorkerConfig.mock.invocationCallOrder[0],
      );
    });

    it('unpair removes the task before deleting the config', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });

      await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_UNPAIR)({});

      expect(mocks.signInRemove.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.clearWorkerConfig.mock.invocationCallOrder[0],
      );
      expect(mocks.setSetting).toHaveBeenCalledWith('workerMode', expect.objectContaining({ runAtSignIn: false }));
    });

    it('reports the sign-in worker as running from its lock, not a Harness child', async () => {
      mocks.getSetting.mockReturnValue({ role: 'worker', startWorkerOnLaunch: true, installWorkerService: false, runAtSignIn: true });
      mocks.readPairing.mockReturnValueOnce(paired);
      mocks.runtimeStatus.mockReturnValueOnce({ state: 'stopped' });
      mocks.lockHeld.mockReturnValueOnce(true);

      const response = await handlerFor(IPC_CHANNELS.PAIR_BOTH_WORKER_STATUS)({});

      expect(mocks.lockHeld).toHaveBeenCalledWith({ key: 'default:node-1' });
      expect(response.data).toMatchObject({
        runtime: { state: 'running' },
        runAtSignIn: true,
        runAtSignInAvailable: true,
      });
    });
  });
});

