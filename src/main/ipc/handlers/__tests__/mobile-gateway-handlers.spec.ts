import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const registryMocks = vi.hoisted(() => ({
  revokeDevice: vi.fn((deviceId: string) => deviceId === 'known-device'),
  listDevices: vi.fn(() => []),
  issuePairing: vi.fn(),
  listMembers: vi.fn(() => [{ profileId: 'p1', name: 'Second person', createdAt: 1 }]),
  addMember: vi.fn((name: string) => ({ profileId: 'p2', name, createdAt: 2 })),
  removeMember: vi.fn((profileId: string) => profileId === 'p1'),
  setMemberSession: vi.fn((profileId: string, session: unknown) => ({ profileId, name: 'Second person', createdAt: 1, session })),
}));

const fleetMocks = vi.hoisted(() => ({
  pairedComputers: [{ nodeId: 'paired-only', nodeName: 'Paired only' }],
  connectedComputers: [{ id: 'her-worker', name: 'Her computer', status: 'connected' }],
  accounts: [
    { id: 'acct-claude', provider: 'claude', label: 'Claude A', enabled: true },
    { id: 'acct-codex', provider: 'codex', label: 'Codex A', enabled: true },
    { id: 'acct-off', provider: 'claude', label: 'Claude off', enabled: false },
    { id: 'acct-gemini', provider: 'gemini', label: 'Gemini', enabled: true },
  ],
}));

vi.mock('../../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ listProfiles: () => fleetMocks.accounts }),
}));
vi.mock('../../../auth/remote-auth', () => ({
  getRemoteAuthService: () => ({ listSessions: () => fleetMocks.pairedComputers }),
}));
vi.mock('../../../remote-node', () => ({
  getWorkerNodeRegistry: () => ({ getAllNodes: () => fleetMocks.connectedComputers }),
}));

vi.mock('../../../mobile-gateway/mobile-device-registry', () => ({
  getMobileDeviceRegistry: () => registryMocks,
}));

vi.mock('../../../mobile-gateway/mobile-gateway-server', () => ({
  getMobileGatewayServer: () => ({ getStatus: vi.fn(() => ({ running: false })) }),
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: vi.fn(), set: vi.fn() }),
}));

vi.mock('qrcode', () => ({ toDataURL: vi.fn() }));

import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { registerMobileGatewayHandlers } from '../mobile-gateway-handlers';

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, payload);
}

describe('mobile-gateway-handlers REVOKE_DEVICE', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerMobileGatewayHandlers();
  });

  it('revokes the device named by the renderer payload', async () => {
    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE, { deviceId: 'known-device' });

    expect(result).toEqual({ success: true, data: { revoked: true } });
    expect(registryMocks.revokeDevice).toHaveBeenCalledWith('known-device');
  });

  it.each([
    ['a missing payload', undefined],
    ['a missing deviceId', {}],
    ['an empty deviceId', { deviceId: '' }],
    ['a non-string deviceId', { deviceId: 42 }],
    ['an oversized deviceId', { deviceId: 'x'.repeat(201) }],
  ])('rejects %s without touching the registry', async (_label, payload) => {
    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE, payload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(registryMocks.revokeDevice).not.toHaveBeenCalled();
  });

  it('keeps the handler error code when the registry throws', async () => {
    registryMocks.revokeDevice.mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_REVOKE_DEVICE, { deviceId: 'known-device' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MOBILE_GATEWAY_REVOKE_DEVICE_FAILED');
  });
});

describe('mobile-gateway-handlers people', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerMobileGatewayHandlers();
  });

  it('lists people with the computers and the Claude and Codex accounts they can be given', async () => {
    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_LIST_PEOPLE);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      members: [{ profileId: 'p1', name: 'Second person', createdAt: 1 }],
      computers: [
        { id: 'paired-only', name: 'Paired only', online: false },
        { id: 'her-worker', name: 'Her computer', online: true },
      ],
      accounts: [
        { id: 'acct-claude', provider: 'claude', label: 'Claude A' },
        { id: 'acct-codex', provider: 'codex', label: 'Codex A' },
      ],
    });
  });

  it('adds and removes people', async () => {
    expect((await invoke(IPC_CHANNELS.MOBILE_GATEWAY_ADD_PERSON, { name: 'New person' })).success).toBe(true);
    expect(registryMocks.addMember).toHaveBeenCalledWith('New person');
    expect(await invoke(IPC_CHANNELS.MOBILE_GATEWAY_REMOVE_PERSON, { profileId: 'p1' }))
      .toEqual({ success: true, data: { removed: true } });
    expect((await invoke(IPC_CHANNELS.MOBILE_GATEWAY_ADD_PERSON, { name: '' })).error?.code).toBe('VALIDATION_FAILED');
  });

  it("issues a pairing for a named person's phone, and for the owner's when none is named", async () => {
    // The gateway is stopped in this test, so the handler stops before issuing; the point is the payload is accepted.
    expect((await invoke(IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING, { profileId: 'p1' })).error?.code)
      .toBe('MOBILE_GATEWAY_NOT_RUNNING');
    expect((await invoke(IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING)).error?.code).toBe('MOBILE_GATEWAY_NOT_RUNNING');
    expect((await invoke(IPC_CHANNELS.MOBILE_GATEWAY_ISSUE_PAIRING, { profileId: '' })).error?.code).toBe('VALIDATION_FAILED');
  });

  it('saves where a person works when the computer and accounts are real', async () => {
    const settings = {
      profileId: 'p1',
      workerNodeId: 'her-worker',
      workingDirectory: '/home/member/work',
      allowedAccountProfileIds: ['acct-claude', 'acct-codex'],
    };

    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_SET_PERSON_SESSION, settings);

    expect(result.success).toBe(true);
    expect(registryMocks.setMemberSession).toHaveBeenCalledWith('p1', {
      workerNodeId: 'her-worker',
      workingDirectory: '/home/member/work',
      allowedAccountProfileIds: ['acct-claude', 'acct-codex'],
    });
  });

  it.each([
    ['a computer that is not paired', { workerNodeId: 'unknown-computer' }],
    ['an account that is switched off', { allowedAccountProfileIds: ['acct-off'] }],
    ['an account for another provider', { allowedAccountProfileIds: ['acct-gemini'] }],
    ['an account that does not exist', { allowedAccountProfileIds: ['acct-missing'] }],
  ])('refuses %s without saving anything', async (_label, change) => {
    const result = await invoke(IPC_CHANNELS.MOBILE_GATEWAY_SET_PERSON_SESSION, {
      profileId: 'p1',
      workerNodeId: 'her-worker',
      workingDirectory: '/home/member/work',
      allowedAccountProfileIds: ['acct-claude'],
      ...change,
    });

    expect(result.success).toBe(false);
    expect(registryMocks.setMemberSession).not.toHaveBeenCalled();
  });
});
