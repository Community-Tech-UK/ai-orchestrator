import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  initializeOptions: null as null | {
    updateNodeConfig?: (args: {
      nodeId: string;
      extensionRelay?: { enabled: boolean };
    }) => Promise<unknown>;
  },
  registry: {
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
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
});

async function startStep(): Promise<void> {
  const instanceManager = {
    getAllInstances: vi.fn(() => []),
    getInstance: vi.fn(() => undefined),
  };
  const windowManager = { sendToRenderer: vi.fn() };
  await createOrchestratorToolsStep(instanceManager as never, windowManager as never).fn();
}
