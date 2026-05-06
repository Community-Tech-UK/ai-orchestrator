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
  const rawPackage = {
    id: 'plugin-a',
    name: 'Plugin A',
    version: '1.0.0',
    status: 'installed',
    source: {
      type: 'url',
      value: 'https://user:secret@example.test/plugin.zip?token=super-secret&mode=1',
    },
    installPath: '/Users/suas/.orchestrator/plugins/plugin-a',
    cachePath: '/Users/suas/.orchestrator/plugins/plugin-a',
    lastValidationResult: { ok: true, errors: [], warnings: [] },
    lastUpdatedAt: 1,
  };
  return {
    list: vi.fn().mockResolvedValue([rawPackage]),
    validate: vi.fn().mockResolvedValue({ ok: true, manifest: { name: 'plugin-a', version: '1.0.0' }, warnings: [] }),
    install: vi.fn().mockResolvedValue(rawPackage),
    update: vi.fn().mockResolvedValue({ ...rawPackage, version: '1.1.0' }),
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
      data: [{ id: 'plugin-a', status: 'installed', installPath: '[managed]/plugin-a' }],
    });

    expect(manager.list).toHaveBeenCalledOnce();
  });

  it('redacts secret-bearing source values and managed paths before returning package DTOs', async () => {
    const response = await invoke(IPC_CHANNELS.RUNTIME_PLUGINS_LIST);

    expect(response.success).toBe(true);
    const [plugin] = response.data as Array<Record<string, unknown>>;
    expect(plugin['installPath']).toBe('[managed]/plugin-a');
    expect(plugin).not.toHaveProperty('cachePath');
    expect(plugin['source']).toEqual({
      type: 'url',
      value: 'https://example.test/plugin.zip?token=REDACTED&mode=1',
      redacted: true,
    });
    expect(JSON.stringify(plugin)).not.toContain('super-secret');
    expect(JSON.stringify(plugin)).not.toContain('/Users/suas/.orchestrator');
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
