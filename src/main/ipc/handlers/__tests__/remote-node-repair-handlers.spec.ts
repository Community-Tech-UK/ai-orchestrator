import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { registerRemoteNodeHandlers } from '../remote-node-handlers';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../remote-node', () => ({
  getWorkerNodeRegistry: () => ({ getAllNodes: vi.fn(() => []), getNode: vi.fn() }),
  getWorkerNodeConnectionServer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => true),
    getConnectedNodeIds: vi.fn(() => []),
    isNodeConnected: vi.fn(() => false),
    disconnectNode: vi.fn(),
  }),
}));

vi.mock('../../../remote-node/worker-node-rpc', () => ({
  COORDINATOR_TO_NODE: {
    PROVIDER_DIAGNOSE: 'provider.diagnose',
    SERVICE_STATUS: 'service.status',
    SERVICE_RESTART: 'service.restart',
    SERVICE_STOP: 'service.stop',
    SERVICE_UNINSTALL: 'service.uninstall',
    CONFIG_UPDATE: 'config.update',
  },
}));

vi.mock('../../../remote-node/service-rpc-client', () => ({
  sendServiceRpc: vi.fn(),
}));

vi.mock('../../../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => ({ serverPort: 4878, serverHost: '0.0.0.0', namespace: 'default' }),
}));

vi.mock('../../../remote-node/discovery-service', () => ({
  getDiscoveryService: () => ({ publish: vi.fn(), unpublish: vi.fn() }),
}));

vi.mock('../../../remote-node/auth-validator', () => ({
  generateAuthToken: () => 'manual-token',
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ set: vi.fn() }),
}));

vi.mock('../../../util/network-addresses', () => ({
  getLocalIpv4Addresses: () => [],
  getTailscaleIpv4Address: () => null,
  getTailscaleMagicDnsName: () => null,
}));

const diagnose = vi.fn();
const generateRepairCommand = vi.fn();

vi.mock('../../../remote-node/remote-worker-repair-service', () => ({
  getRemoteWorkerRepairService: () => ({
    diagnose,
    generateRepairCommand,
  }),
}));

vi.mock('../../../auth/remote-auth', () => ({
  getRemoteAuthService: () => ({
    listSessions: () => [],
    setManualPairingCredential: vi.fn(),
    issuePairingCredential: vi.fn(),
    listPendingPairings: () => [],
    revokePairingCredential: vi.fn(),
    revokeSession: vi.fn(),
  }),
}));

type HandlerFn = (
  event: unknown,
  payload: unknown,
) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;

function handlerFor(channel: string): HandlerFn {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as unknown as HandlerFn;
}

describe('remote node repair IPC handlers', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    registerRemoteNodeHandlers();
  });

  it('returns diagnostics through the explicit repair diagnose channel', async () => {
    diagnose.mockReturnValueOnce({ nodeId, status: 'depaired' });

    const response = await handlerFor(IPC_CHANNELS.REMOTE_NODE_REPAIR_DIAGNOSE)({}, { nodeId });

    expect(response).toEqual({ success: true, data: { nodeId, status: 'depaired' } });
    expect(diagnose).toHaveBeenCalledWith(nodeId);
  });

  it('returns commands only through the explicit repair command channel', async () => {
    generateRepairCommand.mockReturnValueOnce({ nodeId, command: 'powershell' });

    const response = await handlerFor(IPC_CHANNELS.REMOTE_NODE_REPAIR_COMMAND)({}, {
      nodeId,
      platform: 'win32',
      operatorConfirmedPlatform: true,
    });

    expect(response).toEqual({ success: true, data: { nodeId, command: 'powershell' } });
    expect(generateRepairCommand).toHaveBeenCalledWith({
      nodeId,
      platform: 'win32',
      operatorConfirmedPlatform: true,
    });
  });

  it('rejects invalid repair command payloads before generating a command', async () => {
    const response = await handlerFor(IPC_CHANNELS.REMOTE_NODE_REPAIR_COMMAND)({}, {
      nodeId,
      operatorConfirmedPlatform: true,
    });

    expect(response.success).toBe(false);
    expect(generateRepairCommand).not.toHaveBeenCalled();
  });

  it('returns a failed response when repair command generation is not allowed', async () => {
    generateRepairCommand.mockImplementationOnce(() => {
      throw new Error('Repair command requires a registered node identity');
    });

    const response = await handlerFor(IPC_CHANNELS.REMOTE_NODE_REPAIR_COMMAND)({}, {
      nodeId,
      platform: 'win32',
      operatorConfirmedPlatform: true,
    });

    expect(response).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'REMOTE_NODE_REPAIR_COMMAND_FAILED',
        message: 'Repair command requires a registered node identity',
      }),
    });
  });
});
