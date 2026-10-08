import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerNodeSubsystemStep } from './remote-gateway-initialization-steps';
import type { AppInitializationContext } from './initialization-steps';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

// vi.hoisted runs before imports resolve, so this cannot use node:events.
const fakes = vi.hoisted(() => {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const registry = {
    on(event: string, cb: (payload: unknown) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(cb);
      listeners.set(event, existing);
      return registry;
    },
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    removeAllListeners() {
      listeners.clear();
    },
  };
  return {
    settings: {} as Record<string, unknown>,
    config: {
      enabled: true,
      serverPort: 4878,
      serverHost: '0.0.0.0',
      namespace: 'default',
      autoOffloadBrowser: true,
    },
    registry,
    connectionStart: vi.fn(async () => undefined),
    rpcRouterStart: vi.fn(),
    publish: vi.fn(),
    notify: vi.fn(),
  };
});

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => fakes.settings,
    get: (key: string) => fakes.settings[key],
  }),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeRegistry: () => fakes.registry,
  getWorkerNodeConnectionServer: () => ({
    on: vi.fn(),
    start: fakes.connectionStart,
  }),
  handleNodeFailover: vi.fn(),
  handleLateNodeReconnect: vi.fn(),
  RpcEventRouter: class {
    start = fakes.rpcRouterStart;
  },
  getRemoteNodeConfig: () => fakes.config,
  hydrateRemoteNodeConfig: vi.fn(),
  getDiscoveryService: () => ({ publish: fakes.publish }),
}));

vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: fakes.notify }),
}));

vi.mock('../event-bus/thin-client-ws-server', () => ({ getThinClientWsServer: vi.fn() }));
vi.mock('../mobile-gateway/mobile-gateway-server', () => ({ getMobileGatewayServer: vi.fn() }));
vi.mock('../browser-gateway/browser-unattended-services', () => ({
  setBrowserEscalationNotifyHook: vi.fn(),
}));

vi.mock('../remote-node/coordinator-address-advertiser', () => ({
  advertiseCoordinatorAddresses: vi.fn(async () => undefined),
}));
vi.mock('../remote-node/coordinator-tailscale-watcher', () => ({
  CoordinatorTailscaleWatcher: class {
    noteNodeConnected = vi.fn();
    noteNodeDisconnected = vi.fn();
    start = vi.fn();
  },
  setActiveCoordinatorTailscaleWatcher: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function buildContext(): AppInitializationContext {
  return {
    instanceManager: {
      pauseStuckTrackingForNode: vi.fn(),
      resumeStuckTrackingForNode: vi.fn(),
    },
    windowManager: { sendToRenderer: vi.fn() },
    syncRemoteNodeMetricsToLoadBalancer: vi.fn(),
  } as unknown as AppInitializationContext;
}

describe('createWorkerNodeSubsystemStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.registry.removeAllListeners();
    fakes.settings = {};
    fakes.config.enabled = true;
    fakes.config.autoOffloadBrowser = true;
  });

  // Regression: publish() used to be called ONLY from the Settings
  // "start server" IPC handler, so a normally-started coordinator never
  // advertised and workers had nothing to discover when their pinned
  // coordinator URL died.
  it('advertises over mDNS once the connection server has started', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();

    expect(fakes.connectionStart).toHaveBeenCalledWith(4878, '0.0.0.0');
    expect(fakes.publish).toHaveBeenCalledWith(4878, 'default', 'default');
  });

  it('does not advertise when the remote node subsystem is disabled', async () => {
    fakes.config.enabled = false;

    await createWorkerNodeSubsystemStep(buildContext()).fn();

    expect(fakes.connectionStart).not.toHaveBeenCalled();
    expect(fakes.publish).not.toHaveBeenCalled();
  });

  it('wires RPC registration before a server is started later when initially disabled', async () => {
    fakes.config.enabled = false;
    await createWorkerNodeSubsystemStep(buildContext()).fn();

    expect(fakes.rpcRouterStart).toHaveBeenCalledOnce();
    expect(fakes.connectionStart).not.toHaveBeenCalled();
  });

  it('notifies with the node name when a node disconnects', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();

    // The registry deletes the node before emitting, so the name has to come
    // off the event payload — getNode() would already return undefined.
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc' }));

    expect(fakes.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'node-disconnected',
        body: expect.stringContaining('windows-pc'),
        fingerprintFields: { nodeId: 'node-1' },
      }),
    );
  });

  // NotificationService only bypasses quiet hours and the per-kind cooldown for
  // 'critical' (notification-service.ts:167,173 — and see its own spec, "lets
  // critical notifications bypass quiet hours and cooldown"). A node dropping
  // overnight is the case most worth surfacing, so this must not silently
  // regress to the default 'normal'.
  it('raises the disconnect alert as critical so quiet hours cannot swallow it', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();

    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc' }));

    expect(fakes.notify).toHaveBeenCalledWith(
      expect.objectContaining({ urgency: 'critical' }),
    );
  });

  it('skips the notification when notifyOnNodeDisconnect is disabled', async () => {
    fakes.settings = { notifyOnNodeDisconnect: false };

    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc' }));

    expect(fakes.notify).not.toHaveBeenCalled();
  });

  it('still notifies when the setting is unset, since the default is on', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-2', name: 'noahlaptop' }));

    expect(fakes.notify).toHaveBeenCalledTimes(1);
  });

  it('tells the operator agents will ask before using this Mac when the browser computer drops', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc', hasBrowserMcp: true }));

    expect(fakes.notify).toHaveBeenCalledWith(expect.objectContaining({
      body: "windows-pc is no longer connected. Agents will not use this Mac's browser without asking you first.",
    }));
  });

  it('makes no browser promise when browser offload is switched off', async () => {
    fakes.config.autoOffloadBrowser = false;
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc', hasBrowserMcp: true }));

    expect(fakes.notify).toHaveBeenCalledWith(expect.objectContaining({
      body: 'windows-pc is no longer connected',
    }));
  });

  it('announces the node is back online with how long and why', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 9, 0) });
    try {
      await createWorkerNodeSubsystemStep(buildContext()).fn();
      fakes.registry.emit('node:disconnected', makeNode({
        id: 'node-1', name: 'windows-pc', lastHeartbeat: Date.now(), startedAt: 1_000,
      }));
      vi.setSystemTime(Date.now() + 34 * 60_000);
      fakes.registry.emit('node:connected', makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 }));
    } finally {
      vi.useRealTimers();
    }

    expect(fakes.notify).toHaveBeenLastCalledWith({
      kind: 'node-reconnected',
      title: 'windows-pc is back online',
      body: 'It was offline for 34 min. The Harness worker program kept running but could not reach this Mac '
        + '(a network drop, or the computer was asleep or frozen).',
      urgency: 'critical',
      fingerprintFields: { nodeId: 'node-1' },
    });
  });

  it('keeps registering a node whose report breaks the outage summary', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 }));
    // Registration emits node:connected synchronously; any fault in the
    // diagnostic summary must not escape into it.
    const unreadable = makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 });
    Object.defineProperty(unreadable, 'capabilities', {
      get: () => { throw new Error('unreadable capabilities'); },
    });

    expect(() => fakes.registry.emit('node:connected', unreadable)).not.toThrow();
    expect(fakes.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'node-reconnected' }));
  });

  it('stays quiet for a connect that was never announced as a disconnect', async () => {
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:connected', makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 }));

    expect(fakes.notify).not.toHaveBeenCalled();
  });

  it('skips the back-online notification when node notifications are off', async () => {
    fakes.settings = { notifyOnNodeDisconnect: false };
    await createWorkerNodeSubsystemStep(buildContext()).fn();
    fakes.registry.emit('node:disconnected', makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 }));
    fakes.registry.emit('node:connected', makeNode({ id: 'node-1', name: 'windows-pc', startedAt: 1_000 }));

    expect(fakes.notify).not.toHaveBeenCalled();
  });
});

function makeNode(options: {
  id: string;
  name: string;
  hasBrowserMcp?: boolean;
  lastHeartbeat?: number;
  startedAt?: number;
}): WorkerNodeInfo {
  return {
    id: options.id,
    name: options.name,
    status: 'connected',
    activeInstances: 0,
    ...(options.lastHeartbeat !== undefined ? { lastHeartbeat: options.lastHeartbeat } : {}),
    capabilities: {
      ...(options.startedAt !== undefined ? { workerAgent: { version: '0.1.0', startedAt: options.startedAt } } : {}),
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16_384,
      availableMemoryMB: 8_192,
      supportedClis: [],
      hasBrowserRuntime: options.hasBrowserMcp ?? false,
      hasBrowserMcp: options.hasBrowserMcp ?? false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}
