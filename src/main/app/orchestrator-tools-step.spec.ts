import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  initializeOptions: null as null | {
    listRemoteNodes?: () => Promise<unknown>;
    spawnRemoteInstance?: (args: {
      node?: string;
      prompt: string;
      requiresAndroid?: boolean;
      androidDeviceKind?: 'emulator' | 'physical' | 'any';
    }) => Promise<unknown>;
    updateNodeConfig?: (args: {
      nodeId: string;
      extensionRelay?: { enabled: boolean };
    }) => Promise<unknown>;
  },
  registry: {
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
    selectNode: vi.fn(),
  },
  connectionServer: {
    getConnectedNodeIds: vi.fn(),
    isNodeConnected: vi.fn(),
  },
  sendServiceRpc: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn(() => 3),
    getAll: vi.fn(() => ({
      maxSpawnDepth: 3,
      maxTotalInstances: 20,
    })),
  }),
}));

vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({
  initializeOrchestratorToolsRpcServer: vi.fn(async (options) => {
    captured.initializeOptions = options;
    return {};
  }),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/operator.db',
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: () => captured.connectionServer,
  getWorkerNodeRegistry: () => captured.registry,
  isAndroidAutomationReady: (caps: { hasAndroidMcp?: boolean }) => Boolean(caps.hasAndroidMcp),
}));

vi.mock('../remote-node/service-rpc-client', () => ({
  sendServiceRpc: captured.sendServiceRpc,
}));

vi.mock('../automations', () => ({
  getAutomationRunner: vi.fn(),
  getAutomationScheduler: vi.fn(),
  getAutomationStore: vi.fn(),
}));

vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: vi.fn(),
  handlePastOneTimeAutomation: vi.fn(),
}));

vi.mock('../automations/automation-events', () => ({
  getAutomationEvents: vi.fn(),
}));

vi.mock('../automations/automation-tool-impl', () => ({
  createAutomationToolImplementations: vi.fn(() => ({
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    listAutomations: vi.fn(),
    postponeAutomation: vi.fn(),
    updateAutomation: vi.fn(),
  })),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { createOrchestratorToolsStep } from './orchestrator-tools-step';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';

describe('createOrchestratorToolsStep settings node-config integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.initializeOptions = null;
  });

  it('rejects update_node_config for a disconnected node before sending service RPC', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue([]);
    captured.connectionServer.isNodeConnected.mockReturnValue(false);
    await startStep();

    await expect(
      captured.initializeOptions?.updateNodeConfig?.({
        nodeId: 'windows-pc',
        extensionRelay: { enabled: true },
      }),
    ).rejects.toThrow(/no worker nodes are currently connected/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it('sends update_node_config through config.update for a connected node', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({ ok: true });
    await startStep();

    const result = await captured.initializeOptions?.updateNodeConfig?.({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });

    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.CONFIG_UPDATE,
      { extensionRelay: { enabled: true } },
      30_000,
    );
    expect(result).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'windows-pc',
      updatedBlocks: ['extensionRelay'],
      result: { ok: true },
    });
  });

  it('surfaces Android capabilities from list_remote_nodes', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      connectedCount: 1,
      totalCount: 1,
      nodes: [
        expect.objectContaining({
          id: 'node-1',
          name: 'windows-pc',
          hasAndroidMcp: true,
          androidAutomation: expect.objectContaining({
            enabled: true,
            avds: ['Pixel_8'],
          }),
        }),
      ],
    });
  });

  it('passes Android placement through run_on_node spawns', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'run the Android smoke test',
      requiresAndroid: true,
      androidDeviceKind: 'emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      forceNodeId: 'node-1',
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'emulator',
      },
    }));
  });

  it('infers Android placement from an Android run_on_node prompt', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'install the APK and test it on the emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'any',
      },
    }));
  });

  it('rejects Android run_on_node spawns on nodes without Android readiness', async () => {
    const node = makeNode({ hasAndroidMcp: false });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'run the Android smoke test',
        requiresAndroid: true,
      }),
    ).rejects.toThrow(/not Android-automation ready/i);
    expect(createInstance).not.toHaveBeenCalled();
  });
});

function makeNode(overrides: { hasAndroidMcp?: boolean } = {}) {
  const hasAndroidMcp = overrides.hasAndroidMcp ?? false;
  return {
    id: 'node-1',
    name: 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      supportedClis: ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp: false,
      hasAndroidMcp,
      ...(hasAndroidMcp
        ? {
            androidAutomation: {
              enabled: true,
              sdkPath: 'C:\\Android\\Sdk',
              adbVersion: 'Android Debug Bridge version 1.0.41',
              avds: ['Pixel_8'],
              connectedDevices: [],
              emulatorRunning: false,
              hasMaestro: false,
            },
          }
        : {}),
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: ['C:\\work'],
    },
  };
}

async function startStep(instanceManagerOverrides: Record<string, unknown> = {}): Promise<void> {
  const instanceManager = {
    getAllInstances: vi.fn(() => []),
    getInstance: vi.fn(() => undefined),
    createInstance: vi.fn(async () => ({
      id: 'inst-default',
      status: 'initializing',
    })),
    ...instanceManagerOverrides,
  };
  const windowManager = { sendToRenderer: vi.fn() };
  await createOrchestratorToolsStep(instanceManager as never, windowManager as never).fn();
}
