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
