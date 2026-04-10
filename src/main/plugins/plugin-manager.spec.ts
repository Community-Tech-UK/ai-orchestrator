import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-home'),
    getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
  },
}));

vi.mock('../orchestration/multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: () => ({
    on: vi.fn(),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      agents: {},
      appearance: {},
    }),
  }),
}));

import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  _resetOrchestratorPluginManagerForTesting,
  OrchestratorPluginManager,
} from './plugin-manager';
import type { TypedOrchestratorHooks } from '../../shared/types/plugin.types';

beforeEach(() => {
  _resetOrchestratorPluginManagerForTesting();
});

describe('OrchestratorPluginManager', () => {
  it('accepts typed hook payloads at compile time', () => {
    const hooks: TypedOrchestratorHooks = {
      'instance.created': (payload) => {
        const instanceId: string = payload.instanceId;
        const workingDirectory: string = payload.workingDirectory;
        void instanceId;
        void workingDirectory;
      },
      'instance.output': (payload) => {
        const instanceId: string = payload.instanceId;
        const messageId: string = payload.message.id;
        void instanceId;
        void messageId;
      },
      'verification.error': (payload) => {
        const verificationId: string = payload.verificationId;
        void verificationId;
      },
    };

    expect(Object.keys(hooks)).toHaveLength(3);
  });

  it('dispatches typed payloads to the matching plugin hook', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi.fn();
    const ctx = {
      instanceManager: {} as never,
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    };

    vi.spyOn(
      manager as unknown as {
        getPlugins: (workingDirectory: string, pluginCtx: unknown) => Promise<unknown[]>;
      },
      'getPlugins',
    ).mockResolvedValue([
      {
        filePath: '/tmp/plugin.js',
        hooks: {
          'instance.output': hook,
        },
      },
    ]);

    await (
      manager as unknown as {
        emitToPlugins: (
          workingDirectory: string,
          pluginCtx: typeof ctx,
          event: 'instance.output',
          payload: { instanceId: string; message: { id: string } },
        ) => Promise<void>;
      }
    ).emitToPlugins('/tmp/project', ctx, 'instance.output', {
      instanceId: 'inst-1',
      message: { id: 'msg-1' } as never,
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'inst-1',
        message: expect.objectContaining({ id: 'msg-1' }),
      }),
    );
  });

  it('reads plugin.json manifest during plugin scan', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'my-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    // Write the plugin JS file (content doesn't matter — loadModule is spied)
    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    // Write the manifest
    const manifest = {
      name: 'my-plugin',
      version: '1.2.3',
      description: 'A test plugin',
      author: 'Tester',
      hooks: ['instance.created'],
    };
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest),
    );

    const manager = OrchestratorPluginManager.getInstance();

    // Spy on loadModule so we don't actually import the temp JS file
    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({});

    const result = await manager.listPlugins(tmpDir, {} as never);

    const pluginEntry = result.plugins.find((p) => p.filePath === pluginFile);
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry?.manifest).toMatchObject({
      name: 'my-plugin',
      version: '1.2.3',
      description: 'A test plugin',
      author: 'Tester',
      hooks: ['instance.created'],
    });

    // Cleanup
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('swallows plugin hook errors so one plugin cannot crash dispatch', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const ctx = {
      instanceManager: {} as never,
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    };

    vi.spyOn(
      manager as unknown as {
        getPlugins: (workingDirectory: string, pluginCtx: unknown) => Promise<unknown[]>;
      },
      'getPlugins',
    ).mockResolvedValue([
      {
        filePath: '/tmp/plugin.js',
        hooks: {
          'instance.removed': vi.fn().mockRejectedValue(new Error('boom')),
        },
      },
    ]);

    await expect(
      (
        manager as unknown as {
          emitToPlugins: (
            workingDirectory: string,
            pluginCtx: typeof ctx,
            event: 'instance.removed',
            payload: { instanceId: string },
          ) => Promise<void>;
        }
      ).emitToPlugins('/tmp/project', ctx, 'instance.removed', {
        instanceId: 'inst-1',
      }),
    ).resolves.toBeUndefined();
  });
});
