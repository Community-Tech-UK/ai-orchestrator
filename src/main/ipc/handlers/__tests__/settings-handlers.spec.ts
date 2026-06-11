import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const settingsMocks = vi.hoisted(() => ({
  values: {
    defaultCli: 'auto',
    fontSize: 14,
    remoteNodesEnrollmentToken: '',
    theme: 'dark',
  } as Record<string, unknown>,
  getAll: vi.fn(() => ({ ...settingsMocks.values })),
  get: vi.fn((key: string) => settingsMocks.values[key]),
  set: vi.fn((key: string, value: unknown) => {
    settingsMocks.values[key] = key === 'defaultCli' && value === 'openai' ? 'codex' : value;
  }),
  update: vi.fn((settings: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(settings)) {
      settingsMocks.values[key] = key === 'defaultCli' && value === 'openai'
        ? 'codex'
        : value;
    }
  }),
  reset: vi.fn(),
  resetOne: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => settingsMocks,
}));

vi.mock('../../../core/config/remote-config', () => ({
  getRemoteConfigManager: () => ({
    fetchFromUrl: vi.fn(),
    fetchFromWellKnown: vi.fn(),
    fetchFromGitHub: vi.fn(),
    discoverForGitRepo: vi.fn(),
    getCachedConfigs: vi.fn(() => []),
    clearCache: vi.fn(),
    invalidateCache: vi.fn(),
  }),
}));

vi.mock('../../../core/config/settings-export', () => ({
  exportSettings: vi.fn(),
  importSettings: vi.fn(),
}));

vi.mock('../../../core/config/config-resolver', () => ({
  resolveConfig: vi.fn(),
  loadProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
  createProjectConfig: vi.fn(),
  findProjectConfigPath: vi.fn(),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { registerSettingsHandlers } from '../settings-handlers';

describe('settings-handlers policy validation', () => {
  let windowManager: { sendToRenderer: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    settingsMocks.values = {
      defaultCli: 'auto',
      fontSize: 14,
      remoteNodesEnrollmentToken: '',
      theme: 'dark',
    };
    windowManager = { sendToRenderer: vi.fn() };
    registerSettingsHandlers({ windowManager: windowManager as never });
  });

  it('rejects unknown settings keys before writing through IPC SETTINGS_SET', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'futureSetting',
      value: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Unknown setting key/);
    expect(settingsMocks.set).not.toHaveBeenCalled();
    expect(windowManager.sendToRenderer).not.toHaveBeenCalled();
  });

  it('allows secret-tier settings through IPC SETTINGS_SET — the Settings UI owns these flows', async () => {
    // Policy tiers gate the MCP tool surface only. The renderer legitimately
    // writes secret-tier keys: enrollment-token regeneration
    // (remote-nodes-settings-tab) and APNs key / TLS path upload
    // (mobile-settings-tab). Refusing them here breaks those forms.
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'remoteNodesEnrollmentToken',
      value: 'new-token',
    });

    expect(result.success).toBe(true);
    expect(settingsMocks.set).toHaveBeenCalledWith('remoteNodesEnrollmentToken', 'new-token');
    expect(windowManager.sendToRenderer).toHaveBeenCalled();
  });

  it('allows the mobile-gateway APNs key upload flow through IPC SETTINGS_SET', async () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(3000)}\n-----END PRIVATE KEY-----`;
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'mobileGatewayApnsKeyP8',
      value: pem,
    });

    expect(result.success).toBe(true);
    expect(settingsMocks.set).toHaveBeenCalledWith('mobileGatewayApnsKeyP8', pem);
  });

  it('still type-checks secret-tier values on the renderer path', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'remoteNodesEnrollmentToken',
      value: 42,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Invalid value/);
    expect(settingsMocks.set).not.toHaveBeenCalled();
  });

  it('rejects invalid open setting values before writing through IPC SETTINGS_SET', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'fontSize',
      value: 999,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Invalid value/);
    expect(settingsMocks.set).not.toHaveBeenCalled();
    expect(windowManager.sendToRenderer).not.toHaveBeenCalled();
  });

  it('broadcasts the normalized value persisted by SettingsManager on IPC SETTINGS_SET', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_SET, {
      key: 'defaultCli',
      value: 'openai',
    });

    expect(result.success).toBe(true);
    expect(settingsMocks.set).toHaveBeenCalledWith('defaultCli', 'openai');
    expect(settingsMocks.get).toHaveBeenLastCalledWith('defaultCli');
    expect(windowManager.sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, {
      key: 'defaultCli',
      value: 'codex',
    });
  });

  it('rejects unknown keys before bulk IPC SETTINGS_UPDATE writes', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_UPDATE, {
      settings: {
        theme: 'light',
        futureSetting: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Unknown setting key/);
    expect(settingsMocks.update).not.toHaveBeenCalled();
    expect(windowManager.sendToRenderer).not.toHaveBeenCalled();
  });

  it('allows secret-tier keys in bulk IPC SETTINGS_UPDATE writes from the renderer', async () => {
    const result = await invoke(IPC_CHANNELS.SETTINGS_UPDATE, {
      settings: {
        theme: 'light',
        remoteNodesEnrollmentToken: 'new-token',
      },
    });

    expect(result.success).toBe(true);
    expect(settingsMocks.update).toHaveBeenCalledWith({
      theme: 'light',
      remoteNodesEnrollmentToken: 'new-token',
    });
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
