import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { PluginPackageManager } from '../../plugins/plugin-package-manager';
import { registerRuntimePluginHandlers } from './runtime-plugin-handlers';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

function makeManager(): PluginPackageManager {
  return {
    list: vi.fn().mockResolvedValue([{ id: 'plugin-a', status: 'installed' }]),
    validate: vi.fn().mockResolvedValue({ ok: true, manifest: { name: 'plugin-a', version: '1.0.0' }, warnings: [] }),
    install: vi.fn().mockResolvedValue({ id: 'plugin-a', status: 'installed' }),
    update: vi.fn().mockResolvedValue({ id: 'plugin-a', version: '1.1.0', status: 'installed' }),
    prune: vi.fn().mockResolvedValue({ removed: ['stale-plugin'] }),
    uninstall: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginPackageManager;
}

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return handler({}, payload);
}

describe('registerRuntimePluginHandlers', () => {
  let manager: PluginPackageManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    manager = makeManager();
    registerRuntimePluginHandlers({ packageManager: manager });
  });

  it('registers runtime plugin channels separately from provider plugin handlers', async () => {
    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_LIST)).resolves.toMatchObject({
      success: true,
      data: [{ id: 'plugin-a', status: 'installed' }],
    });

    expect(manager.list).toHaveBeenCalledOnce();
  });

  it('validates and installs package sources through schema-checked payloads', async () => {
    const source = { type: 'directory' as const, value: '/tmp/plugin-a' };

    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_VALIDATE, { source })).resolves.toMatchObject({
      success: true,
      data: { ok: true },
    });
    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_INSTALL, { source })).resolves.toMatchObject({
      success: true,
      data: { id: 'plugin-a' },
    });

    expect(manager.validate).toHaveBeenCalledWith(source);
    expect(manager.install).toHaveBeenCalledWith(source);
  });

  it('updates, prunes, and uninstalls runtime plugins', async () => {
    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_UPDATE, { pluginId: 'plugin-a' }))
      .resolves.toMatchObject({ success: true, data: { version: '1.1.0' } });
    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_PRUNE, {}))
      .resolves.toMatchObject({ success: true, data: { removed: ['stale-plugin'] } });
    await expect(invoke(IPC_CHANNELS.RUNTIME_PLUGINS_UNINSTALL, { pluginId: 'plugin-a' }))
      .resolves.toMatchObject({ success: true });

    expect(manager.update).toHaveBeenCalledWith('plugin-a', undefined);
    expect(manager.prune).toHaveBeenCalledOnce();
    expect(manager.uninstall).toHaveBeenCalledWith('plugin-a');
  });

  it('returns a structured error for invalid payloads', async () => {
    const response = await invoke(IPC_CHANNELS.RUNTIME_PLUGINS_INSTALL, {
      source: { type: 'unknown', value: '/tmp/plugin-a' },
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('RUNTIME_PLUGINS_INSTALL_FAILED');
    expect(manager.install).not.toHaveBeenCalled();
  });
});
