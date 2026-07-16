import nodePath from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WorkerConfig } from '../worker-config';

const providerDiagnostics = vi.hoisted(() => ({
  diagnoseProviderRuntime: vi.fn(),
}));

const wsMockState = vi.hoisted(() => ({
  instances: [] as {
    url: string;
    options?: unknown;
    bufferedAmount: number;
    emit: (event: string, ...args: unknown[]) => boolean;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

const discoveryMockState = vi.hoisted(() => ({
  onUp: null as null | ((coordinator: {
    host: string;
    port: number;
    namespace: string;
    version: string;
  }) => void),
}));

const workerConfigMockState = vi.hoisted(() => ({
  persistConfig: vi.fn(),
}));

const extensionRegistrationMockState = vi.hoisted(() => ({
  checkAndRepair: vi.fn(() => ({
    registration: 'ok',
    lastRegistrationCheckAt: 1234,
    manifestPath: 'C:\\Users\\James\\.orchestrator\\browser-gateway\\native-host\\com.ai_orchestrator.browser_gateway_relay.json',
  })),
}));

// Mock WebSocket
vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    url: string;
    options?: unknown;
    send = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    close = vi.fn();

    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      wsMockState.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const handlers = this.listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
      return handlers.length > 0;
    }
  }
  return { WebSocket: MockWebSocket, default: { WebSocket: MockWebSocket } };
});

vi.mock('../discovery-client', () => ({
  DiscoveryClient: vi.fn().mockImplementation(() => ({
    discover: vi.fn(async () => null),
    startContinuous: vi.fn((_namespace, onUp) => {
      discoveryMockState.onUp = onUp;
    }),
    stopContinuous: vi.fn(),
  })),
}));

vi.mock('../worker-config', () => ({
  DEFAULT_CONFIG_PATH: '/tmp/aio-worker-node-test.json',
  persistConfig: workerConfigMockState.persistConfig,
  defaultBrowserAutomationProfileDir: () => '/tmp/aio-auto-profile',
  defaultExtensionRelaySocketPath: () => '/tmp/aio-extension-relay.sock',
  ensureExtensionRelayDefaults: (
    config: { enabled: boolean; socketPath?: string; extensionToken?: string } | undefined,
    defaultSocketPath: () => string,
  ) => config && config.enabled
    ? {
        ...config,
        socketPath: config.socketPath ?? defaultSocketPath(),
        extensionToken: config.extensionToken ?? 'generated-extension-token',
      }
    : config,
  normalizeFileTransferConfig: vi.fn((config) => config),
}));

vi.mock('../extension-relay-native-registration', () => ({
  ExtensionRelayNativeRegistration: vi.fn().mockImplementation(() => ({
    checkAndRepair: extensionRegistrationMockState.checkAndRepair,
  })),
}));

// Mock capability-reporter
vi.mock('../capability-reporter', () => ({
  resolveChromeExecutablePath: () => '/fake/chrome',
  reportCapabilities: vi.fn(async () => ({
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 96000,
    availableMemoryMB: 64000,
    supportedClis: ['claude', 'codex'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasExtensionRelay: false,
    hasDocker: true,
    maxConcurrentInstances: 10,
    workingDirectories: [],
  })),
}));

class MockLocalInstanceManager extends EventEmitter {
  spawn = vi.fn(async () => undefined);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
  hibernate = vi.fn(async () => undefined);
  wake = vi.fn(async () => undefined);
  terminateAll = vi.fn(async () => undefined);
  getInstanceCount = vi.fn(() => 0);
}

let mockInstanceManager: MockLocalInstanceManager;

vi.mock('../local-instance-manager', () => ({
  LocalInstanceManager: vi.fn().mockImplementation(() => {
    mockInstanceManager = new MockLocalInstanceManager();
    return mockInstanceManager;
  }),
}));

vi.mock('../android/worker-android-manager', () => ({
  WorkerAndroidManager: vi.fn().mockImplementation(() => ({
    getSummary: vi.fn(async () => undefined),
    reconfigure: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  })),
}));

vi.mock('../provider-runtime-diagnostics', () => ({
  diagnoseProviderRuntime: providerDiagnostics.diagnoseProviderRuntime,
  isDiagnosableProvider: (value: unknown) =>
    typeof value === 'string' && ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'grok'].includes(value),
}));

import { WorkerAgent, buildCoordinatorCandidates } from '../worker-agent';
import { reportCapabilities } from '../capability-reporter';
import { NO_THINK_DIRECTIVE } from '../../shared/utils/openai-response';

const mockConfig: WorkerConfig = {
  nodeId: 'test-node-1',
  name: 'test-pc',
  coordinatorUrl: 'ws://localhost:4878',
  authToken: 'test-token',
  maxConcurrentInstances: 10,
  workingDirectories: ['/tmp/work'],
  reconnectIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
};

async function waitForSocket(index = 0): Promise<(typeof wsMockState.instances)[number]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const instance = wsMockState.instances[index];
    if (instance) {
      return instance;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for WebSocket instance ${index}`);
}

describe('WorkerAgent', () => {
  let agent: WorkerAgent;
  let wsSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    wsMockState.instances.length = 0;
    discoveryMockState.onUp = null;
    workerConfigMockState.persistConfig.mockClear();
    extensionRegistrationMockState.checkAndRepair.mockClear();
    vi.mocked(reportCapabilities).mockClear();
    providerDiagnostics.diagnoseProviderRuntime.mockReset();
    agent = new WorkerAgent(mockConfig);
    wsSend = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    (agent as unknown as {
      ws: { readyState: number; bufferedAmount: number; send: typeof wsSend; close: ReturnType<typeof vi.fn> };
    }).ws = {
      readyState: 1,
      bufferedAmount: 0,
      send: wsSend,
      close: vi.fn(),
    };
  });

  afterEach(async () => {
    await agent.disconnect();
    vi.useRealTimers();
  });

  it('creates without error', () => {
    expect(agent).toBeDefined();
  });

  it('uses a re-discovered coordinator IP when an explicit LAN IP stops connecting', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      coordinatorUrl: 'ws://192.168.1.50:4878',
      namespace: 'default',
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const firstSocket = await waitForSocket();

    expect(firstSocket.url).toBe('ws://192.168.1.50:4878');
    expect(discoveryMockState.onUp).not.toBeNull();

    firstSocket.emit('error', new Error('ECONNREFUSED'));
    firstSocket.emit('close');
    await connect;

    discoveryMockState.onUp?.({
      host: '192.168.1.99',
      port: 4878,
      namespace: 'default',
      version: '1.0',
    });

    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = await waitForSocket(1);

    expect(secondSocket.url).toBe('ws://192.168.1.99:4878');
  });

  it('recovers via reconnect (does not crash) when an established coordinator socket errors', async () => {
    const config: WorkerConfig = { ...mockConfig, reconnectIntervalMs: 1000 };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    // Post-open socket error. Previously this re-emitted 'error' on the
    // WorkerAgent EventEmitter with no listener, which threw and crashed the
    // whole process. It must now be swallowed.
    expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();

    // The paired close event drives a reconnect rather than an exit.
    socket.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = await waitForSocket(1);
    expect(secondSocket).toBeDefined();
  });

  it('survives a heartbeat capability-refresh rejection without crashing', async () => {
    const config: WorkerConfig = { ...mockConfig, heartbeatIntervalMs: 5000 };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    // Accept registration so the heartbeat interval starts.
    const registration = JSON.parse(socket.send.mock.calls[0][0] as string) as { id: string };
    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: registration.id,
      result: { nodeId: 'test-node-1', token: 'accepted' },
    }));

    // The next capability probe (inside the heartbeat) rejects. The interval
    // callback must swallow it — an unhandled rejection would kill the worker.
    vi.mocked(reportCapabilities).mockRejectedValueOnce(new Error('probe failed'));

    await vi.advanceTimersByTimeAsync(5000 + 10);

    expect(vi.mocked(reportCapabilities)).toHaveBeenCalled();
    // Process is still alive and the agent still usable.
    expect(agent).toBeDefined();
  });

  it('sets an explicit large CDP payload ceiling on coordinator WebSocket clients', async () => {
    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    expect(socket.options).toMatchObject({
      maxPayload: 80 * 1024 * 1024,
    });
  });

  it('continues connecting when the extension relay cannot start', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      extensionRelay: { enabled: true },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    expect(socket.send).toHaveBeenCalled();
  });

  it('checks extension relay native-host registration before reporting startup capabilities', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      extensionRelay: {
        enabled: true,
        legacyNameRegistration: false,
        socketPath: '/tmp/aio-extension-relay-test.sock',
      },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    expect(extensionRegistrationMockState.checkAndRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        socketPath: '/tmp/aio-extension-relay-test.sock',
      }),
    );
    expect(vi.mocked(reportCapabilities)).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      expect.any(Object),
      undefined,
      expect.objectContaining({
        enabled: true,
        registration: 'ok',
        lastRegistrationCheckAt: 1234,
      }),
      undefined,
    );
  });

  it('advertises managed browser downloads as a read-only file-transfer root', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      browserAutomation: {
        enabled: true,
        profileDir: '/tmp/aio-auto-profile',
      },
      fileTransfer: {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/tmp/aio-transfers',
            read: true,
            write: true,
          },
        ],
      },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    expect(vi.mocked(reportCapabilities)).toHaveBeenCalledWith(
      config.workingDirectories,
      config.maxConcurrentInstances,
      expect.objectContaining({
        enabled: true,
        profileDir: '/tmp/aio-auto-profile',
      }),
      undefined,
      expect.objectContaining({ enabled: false, running: false }),
      expect.objectContaining({
        enabled: true,
        roots: expect.arrayContaining([
          expect.objectContaining({
            id: 'browserDownloads',
            label: 'Browser Downloads',
            path: nodePath.join('/tmp/aio-auto-profile', 'Downloads'),
            read: true,
            write: false,
          }),
        ]),
      }),
    );
  });

  it('keeps browserDownloads pointed at the managed browser profile when a configured root reuses the id', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      browserAutomation: {
        enabled: true,
        profileDir: '/tmp/aio-auto-profile',
      },
      fileTransfer: {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'browserDownloads',
            label: 'Custom Downloads',
            path: '/tmp/other-profile/Downloads',
            read: true,
            write: true,
          },
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/tmp/aio-transfers',
            read: true,
            write: true,
          },
        ],
      },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    const fileTransfer = vi.mocked(reportCapabilities).mock.calls.at(-1)?.[5];

    expect(fileTransfer?.roots.filter((root) => root.id === 'browserDownloads')).toEqual([
      {
        id: 'browserDownloads',
        label: 'Browser Downloads',
        path: nodePath.join('/tmp/aio-auto-profile', 'Downloads'),
        read: true,
        write: false,
      },
    ]);
  });

  it('does not recheck extension relay native-host registration before the 60 second repair interval', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      heartbeatIntervalMs: 5000,
      extensionRelay: {
        enabled: true,
        legacyNameRegistration: false,
        socketPath: '/tmp/aio-extension-relay-test.sock',
      },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;
    expect(extensionRegistrationMockState.checkAndRepair).toHaveBeenCalledTimes(1);

    const registration = JSON.parse(socket.send.mock.calls[0][0] as string) as { id: string };
    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: registration.id,
      result: { nodeId: 'test-node-1', token: 'accepted' },
    }));

    await vi.advanceTimersByTimeAsync(5000);
    expect(extensionRegistrationMockState.checkAndRepair).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(extensionRegistrationMockState.checkAndRepair).toHaveBeenCalledTimes(2);
  });

  it('fails over to a fallback URL when the primary coordinator is unreachable', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      coordinatorUrl: 'ws://192.168.0.156:4878',
      coordinatorUrls: ['ws://macbook-pro.tail4fc107.ts.net:4878'],
      namespace: 'default',
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const firstSocket = await waitForSocket();

    // Primary LAN address is tried first.
    expect(firstSocket.url).toBe('ws://192.168.0.156:4878');

    // Primary fails — worker should fail over to the stable fallback.
    firstSocket.emit('error', new Error('ETIMEDOUT'));
    firstSocket.emit('close');

    const secondSocket = await waitForSocket(1);
    expect(secondSocket.url).toBe('ws://macbook-pro.tail4fc107.ts.net:4878');

    secondSocket.emit('open');
    await connect;

    // Registration is sent over the surviving connection.
    expect(secondSocket.send).toHaveBeenCalled();
  });

  it('falls back to the pairing token when a persisted node token is rejected', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      authToken: 'fresh-pairing-token',
      nodeToken: 'stale-node-token',
      reconnectIntervalMs: 1000,
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const firstSocket = await waitForSocket();
    firstSocket.emit('open');
    await connect;

    const firstRegistration = JSON.parse(firstSocket.send.mock.calls[0][0] as string) as {
      id: string;
      params: { token: string };
    };
    expect(firstRegistration.params.token).toBe('stale-node-token');

    firstSocket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: firstRegistration.id,
      error: { code: -32001, message: 'Invalid or expired pairing token' },
    }));
    firstSocket.emit('close');

    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = await waitForSocket(1);
    secondSocket.emit('open');

    const secondRegistration = JSON.parse(secondSocket.send.mock.calls[0][0] as string) as {
      params: { token: string };
    };
    expect(secondRegistration.params.token).toBe('fresh-pairing-token');
    expect(config.nodeToken).toBeUndefined();
    expect(workerConfigMockState.persistConfig).toHaveBeenCalled();
  });

  it('retries registration with a recovery token before falling back to pairing', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      authToken: 'fresh-pairing-token',
      nodeToken: 'stale-node-token',
      recoveryToken: 'same-node-recovery-token',
      reconnectIntervalMs: 1000,
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const firstSocket = await waitForSocket();
    firstSocket.emit('open');
    await connect;

    const firstRegistration = JSON.parse(firstSocket.send.mock.calls[0][0] as string) as {
      id: string;
      params: { token: string; recoveryToken?: string };
    };
    expect(firstRegistration.params).toMatchObject({
      token: 'stale-node-token',
    });
    expect(firstRegistration.params.recoveryToken).toBeUndefined();

    firstSocket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: firstRegistration.id,
      error: { code: -32000, message: 'Invalid or expired pairing token' },
    }));
    firstSocket.emit('close');

    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = await waitForSocket(1);
    secondSocket.emit('open');

    const secondRegistration = JSON.parse(secondSocket.send.mock.calls[0][0] as string) as {
      params: { token: string; recoveryToken?: string };
    };
    expect(secondRegistration.params).toMatchObject({
      token: 'stale-node-token',
      recoveryToken: 'same-node-recovery-token',
    });
    expect(config.nodeToken).toBe('stale-node-token');
    expect(config.recoveryToken).toBe('same-node-recovery-token');
    expect(workerConfigMockState.persistConfig).not.toHaveBeenCalled();

    secondSocket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: secondRegistration.id,
      error: { code: -32000, message: 'Recovery token rejected' },
    }));
    secondSocket.emit('close');

    await vi.advanceTimersByTimeAsync(2000);
    const thirdSocket = await waitForSocket(2);
    thirdSocket.emit('open');

    const thirdRegistration = JSON.parse(thirdSocket.send.mock.calls[0][0] as string) as {
      params: { token: string; recoveryToken?: string };
    };
    expect(thirdRegistration.params).toMatchObject({
      token: 'fresh-pairing-token',
    });
    expect(thirdRegistration.params.recoveryToken).toBeUndefined();
    expect(config.nodeToken).toBeUndefined();
    expect(config.recoveryToken).toBeUndefined();
    expect(workerConfigMockState.persistConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({
        nodeToken: expect.any(String),
        recoveryToken: expect.any(String),
      }),
    );
  });

  it('does not reset reconnect backoff until registration is accepted', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      authToken: 'expired-pairing-token',
      reconnectIntervalMs: 1000,
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const firstSocket = await waitForSocket();
    firstSocket.emit('open');
    await connect;

    const firstRegistration = JSON.parse(firstSocket.send.mock.calls[0][0] as string) as {
      id: string;
    };
    firstSocket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: firstRegistration.id,
      error: { code: -32001, message: 'Invalid or expired pairing token' },
    }));
    firstSocket.emit('close');

    expect((agent as unknown as { reconnectAttempt: number }).reconnectAttempt).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    const secondSocket = await waitForSocket(1);
    secondSocket.emit('open');

    const secondRegistration = JSON.parse(secondSocket.send.mock.calls[0][0] as string) as {
      id: string;
    };
    secondSocket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: secondRegistration.id,
      error: { code: -32001, message: 'Invalid or expired pairing token' },
    }));
    secondSocket.emit('close');

    expect((agent as unknown as { reconnectAttempt: number }).reconnectAttempt).toBe(2);
  });

  it('persists a recovery token returned by the coordinator during registration', () => {
    const config: WorkerConfig = { ...mockConfig };
    agent = new WorkerAgent(config);
    const msg = (agent as unknown as { buildRegistrationMessage: () => { id: string } }).buildRegistrationMessage();

    (agent as unknown as { handleMessage: (raw: string) => void }).handleMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        nodeId: 'test-node-1',
        token: 'fresh-node-token',
        recoveryToken: 'fresh-recovery-token',
      },
    }));

    expect(config.nodeToken).toBe('fresh-node-token');
    expect(config.recoveryToken).toBe('fresh-recovery-token');
    expect(workerConfigMockState.persistConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        nodeToken: 'fresh-node-token',
        recoveryToken: 'fresh-recovery-token',
      }),
    );
  });

  it('rejects outbound coordinator requests before registration is accepted', async () => {
    await expect(
      agent.sendRequest('browser.ext.pollCommand', { timeoutMs: 100 }),
    ).rejects.toThrow('worker_not_registered');
  });

  it('sends outbound coordinator requests with the accepted session token', async () => {
    const config: WorkerConfig = { ...mockConfig };
    agent = new WorkerAgent(config);
    (agent as unknown as {
      ws: { readyState: number; bufferedAmount: number; send: typeof wsSend; close: ReturnType<typeof vi.fn> };
    }).ws = {
      readyState: 1,
      bufferedAmount: 0,
      send: wsSend,
      close: vi.fn(),
    };
    const registration = (agent as unknown as {
      buildRegistrationMessage: () => { id: string };
    }).buildRegistrationMessage();
    (agent as unknown as { handleMessage: (raw: string) => void }).handleMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: registration.id,
      result: {
        nodeId: 'test-node-1',
        token: 'accepted-node-token',
      },
    }));
    wsSend.mockClear();

    const pending = agent.sendRequest('browser.ext.pollCommand', { timeoutMs: 250 });
    const outbound = JSON.parse(wsSend.mock.calls[0][0] as string) as {
      id: string;
      method: string;
      params: { token: string; timeoutMs: number };
    };
    expect(outbound.method).toBe('browser.ext.pollCommand');
    expect(outbound.params).toEqual({
      timeoutMs: 250,
      token: 'accepted-node-token',
    });

    (agent as unknown as { handleMessage: (raw: string) => void }).handleMessage(JSON.stringify({
      jsonrpc: '2.0',
      id: outbound.id,
      result: { ok: true },
    }));

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('persists runtime config updates to the active config path', async () => {
    agent = new WorkerAgent(mockConfig, '/service/worker-node.json');

    await agent.applyConfigUpdate({
      androidAutomation: {
        enabled: true,
        sdkPath: '/android/sdk',
      },
    });

    expect(workerConfigMockState.persistConfig).toHaveBeenCalledWith(
      '/service/worker-node.json',
      expect.objectContaining({
        androidAutomation: {
          enabled: true,
          sdkPath: '/android/sdk',
        },
      }),
    );
  });

  it('rebuilds filesystem transfer roots when browser automation adds managed downloads', async () => {
    const config: WorkerConfig = {
      ...mockConfig,
      browserAutomation: { enabled: false },
      fileTransfer: {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/tmp/aio-transfers',
            read: true,
            write: true,
          },
        ],
      },
    };
    agent = new WorkerAgent(config);

    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;

    const getTransferRoots = () =>
      (agent as unknown as {
        fsHandler: { getTransferRoots: () => Array<{ id: string; path: string }> };
      }).fsHandler.getTransferRoots();

    expect(getTransferRoots().map((root) => root.id)).not.toContain('browserDownloads');

    await agent.applyConfigUpdate({
      browserAutomation: {
        enabled: true,
        profileDir: '/tmp/aio-auto-profile',
      },
    });

    expect(getTransferRoots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'browserDownloads',
          path: nodePath.join('/tmp/aio-auto-profile', 'Downloads'),
        }),
      ]),
    );
  });

  it('dispatches service-scoped coordinator notifications to the RPC dispatcher', () => {
    const handleRpcNotification = vi.fn();
    (agent as unknown as {
      rpcDispatcher: { handleRpcNotification: typeof handleRpcNotification };
    }).rpcDispatcher = { handleRpcNotification };

    (agent as unknown as { handleMessage: (raw: string) => void }).handleMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'browser.cdp.send',
      scope: 'service',
      params: { sessionId: 's1', frame: 'f' },
    }));

    expect(handleRpcNotification).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'browser.cdp.send',
      scope: 'service',
      params: { sessionId: 's1', frame: 'f' },
    });
  });

  it('closes CDP tunnel sessions when an established coordinator socket closes', async () => {
    const closeAll = vi.spyOn((agent as unknown as {
      cdpTunnel: { closeAll: () => void };
    }).cdpTunnel, 'closeAll');
    const connect = agent.connect();
    const socket = await waitForSocket();
    socket.emit('open');
    await connect;
    closeAll.mockClear();

    socket.emit('close');

    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it('closes a CDP session instead of sending when the coordinator socket is backpressured', () => {
    const cdpTunnel = (agent as unknown as {
      cdpTunnel: EventEmitter & { close: (sessionId: string) => void };
    }).cdpTunnel;
    const close = vi.spyOn(cdpTunnel, 'close');
    const ws = (agent as unknown as { ws: { bufferedAmount: number } }).ws;
    ws.bufferedAmount = 33 * 1024 * 1024;

    cdpTunnel.emit('message', {
      sessionId: 's1',
      frame: '{"id":1,"result":{}}',
    });

    expect(wsSend).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('s1');
  });

  it('builds an ordered, de-duplicated candidate URL list', () => {
    expect(
      buildCoordinatorCandidates(
        'ws://discovered:4878',
        'ws://primary:4878',
        ['ws://fallback:4878', 'ws://primary:4878'],
      ),
    ).toEqual(['ws://discovered:4878', 'ws://primary:4878', 'ws://fallback:4878']);

    // Nullish/empty entries are dropped; a lone primary still works.
    expect(buildCoordinatorCandidates(null, 'ws://primary:4878', undefined)).toEqual([
      'ws://primary:4878',
    ]);
    expect(buildCoordinatorCandidates(undefined, undefined, [])).toEqual([]);
  });

  it('builds registration message with correct fields', () => {
    const msg = (agent as unknown as { buildRegistrationMessage: () => unknown }).buildRegistrationMessage();
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'node.register',
      params: {
        nodeId: 'test-node-1',
        name: 'test-pc',
        token: 'test-token',
      },
    });
  });

  it('maps instance.sendInput failures to INSTANCE_NOT_FOUND', async () => {
    mockInstanceManager.sendInput.mockRejectedValueOnce(new Error('Instance not found: missing'));

    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'instance.sendInput',
      params: { instanceId: 'missing', message: 'hello' },
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.error.code).toBe(-32002);
  });

  it('maps instance.spawn failures to SPAWN_FAILED', async () => {
    mockInstanceManager.spawn.mockRejectedValueOnce(new Error('Worker at capacity (10 instances)'));

    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'instance.spawn',
      params: { instanceId: 'spawn-1', cliType: 'claude', workingDirectory: '/tmp/work' },
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.error.code).toBe(-32003);
  });

  it('handles instance.hibernate RPC requests', async () => {
    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'instance.hibernate',
      params: { instanceId: 'hib-1' },
    });

    expect(mockInstanceManager.hibernate).toHaveBeenCalledWith('hib-1');
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.result).toEqual({ ok: true });
  });

  it('handles instance.wake RPC requests', async () => {
    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'instance.wake',
      params: { instanceId: 'wake-1' },
    });

    expect(mockInstanceManager.wake).toHaveBeenCalledWith('wake-1');
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.result).toEqual({ ok: true });
  });

  it('handles service-scoped provider.diagnose RPC requests', async () => {
    providerDiagnostics.diagnoseProviderRuntime.mockResolvedValueOnce({
      ok: true,
      platform: 'win32',
      identity: {
        username: 'DESKTOP\\james',
        homeDir: 'C:\\Users\\james',
        serviceAccountLikely: false,
      },
      provider: {
        provider: 'copilot',
        available: true,
        authenticated: true,
        version: '1.2.3',
      },
    });

    await (agent as unknown as {
      handleRpcRequest: (msg: unknown) => Promise<void>;
    }).handleRpcRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'provider.diagnose',
      scope: 'service',
      params: { provider: 'copilot' },
    });

    expect(providerDiagnostics.diagnoseProviderRuntime).toHaveBeenCalledWith('copilot');
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.result).toMatchObject({
      ok: true,
      identity: { username: 'DESKTOP\\james' },
      provider: { provider: 'copilot', authenticated: true },
    });
  });

  it('handles auxiliaryModel.generate for an openai-compatible (LM Studio) endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'a concise title' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await (agent as unknown as {
        handleRpcRequest: (msg: unknown) => Promise<void>;
      }).handleRpcRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'auxiliaryModel.generate',
        params: {
          provider: 'openai-compatible',
          model: 'qwen2.5-coder-7b',
          systemPrompt: 'You generate titles.',
          userPrompt: 'Summarize this conversation.',
          temperature: 0.2,
          maxOutputTokens: 128,
          timeoutMs: 30000,
          requireJson: false,
        },
      });

      // Routed to the LM Studio OpenAI-compatible chat-completions endpoint.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
      const body = JSON.parse((init as { body: string }).body);
      expect(body.model).toBe('qwen2.5-coder-7b');
      expect(body.messages).toEqual([
        { role: 'system', content: `${NO_THINK_DIRECTIVE}\n\nYou generate titles.` },
        { role: 'user', content: 'Summarize this conversation.' },
      ]);
      expect(body.response_format).toBeUndefined();

      const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
      expect(payload.result).toEqual({ text: 'a concise title' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requests JSON response_format for openai-compatible generate when requireJson is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"score":1}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await (agent as unknown as {
        handleRpcRequest: (msg: unknown) => Promise<void>;
      }).handleRpcRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'auxiliaryModel.generate',
        params: {
          provider: 'openai-compatible',
          model: 'phi-4',
          systemPrompt: 'Score it.',
          userPrompt: 'Input.',
          temperature: 0,
          maxOutputTokens: 512,
          timeoutMs: 30000,
          requireJson: true,
        },
      });

      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
      expect(body.response_format).toEqual({ type: 'json_object' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards num_ctx to the local Ollama generate call when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: 'compressed' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await (agent as unknown as {
        handleRpcRequest: (msg: unknown) => Promise<void>;
      }).handleRpcRequest({
        jsonrpc: '2.0',
        id: 8,
        method: 'auxiliaryModel.generate',
        params: {
          provider: 'ollama',
          model: 'qwen3:14b',
          systemPrompt: 'You compress.',
          userPrompt: 'A very long document...',
          temperature: 0.2,
          maxOutputTokens: 4096,
          timeoutMs: 60000,
          requireJson: false,
          numCtx: 32768,
        },
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/api/generate');
      const body = JSON.parse((init as { body: string }).body);
      expect(body.options.num_ctx).toBe(32768);
      expect(body.options.num_predict).toBe(4096);

      const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
      expect(payload.result).toEqual({ text: 'compressed' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards permission requests from the local instance manager', () => {
    mockInstanceManager.emit('instance:permissionRequest', 'inst-1', {
      id: 'perm-1',
      prompt: 'Allow command?',
      timestamp: 1234,
    });

    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.permissionRequest');
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      permission: {
        id: 'perm-1',
        prompt: 'Allow command?',
        timestamp: 1234,
      },
      token: 'test-token',
    });
  });

  it('sends instance.output as notification (no id field)', () => {
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'hello' });

    // Advance past the 50ms batch interval to trigger flush
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.output');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      message: { type: 'assistant', content: 'hello' },
      token: 'test-token',
    });
  });

  it('batches multiple output messages into instance.outputBatch', () => {
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'msg1' });
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'tool_use', content: 'msg2' });
    mockInstanceManager.emit('instance:output', 'inst-2', { type: 'assistant', content: 'msg3' });

    // Advance past the 50ms batch interval
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params.items).toHaveLength(3);
    expect(payload.params.items[0]).toMatchObject({ instanceId: 'inst-1' });
    expect(payload.params.items[2]).toMatchObject({ instanceId: 'inst-2' });
  });

  it('flushes output buffer immediately when batch max size is reached', () => {
    // Send 10 messages (max batch size)
    for (let i = 0; i < 10; i++) {
      mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: `msg${i}` });
    }

    // Should flush immediately without waiting for timer
    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.params.items).toHaveLength(10);
  });

  it('sends instance.stateChange as RPC request (with id field)', () => {
    mockInstanceManager.emit('instance:stateChange', 'inst-1', 'processing');

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.stateChange');
    expect(payload.id).toBeDefined(); // RPC request — has id
    expect(payload.params.state).toBe('processing');
  });

  it('sends instance.heartbeat as a notification when an adapter emits liveness', () => {
    mockInstanceManager.emit('instance:heartbeat', 'inst-1');

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.heartbeat');
    expect(payload.id).toBeUndefined();
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      token: 'test-token',
    });
  });

  it('sends instance.complete as a notification with the adapter response payload', () => {
    const response = {
      id: 'response-1',
      role: 'assistant',
      content: 'done',
      usage: { totalTokens: 42, duration: 500 },
    };

    mockInstanceManager.emit('instance:complete', 'inst-1', response);

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.complete');
    expect(payload.id).toBeUndefined();
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      response,
      token: 'test-token',
    });
  });
});
