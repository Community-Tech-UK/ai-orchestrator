import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReactionEngine = new EventEmitter();
const mockDebateCoordinator = new EventEmitter();
const mockConsensusCoordinator = new EventEmitter();
const mockSessionContinuity = new EventEmitter();

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

vi.mock('../orchestration/debate-coordinator', () => ({
  getDebateCoordinator: () => mockDebateCoordinator,
}));

vi.mock('../orchestration/consensus-coordinator', () => ({
  getConsensusCoordinator: () => mockConsensusCoordinator,
}));

vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManager: () => mockSessionContinuity,
}));

vi.mock('../reactions', () => ({
  getReactionEngine: () => mockReactionEngine,
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
import { getPluginRegistry, _resetPluginRegistryForTesting } from './plugin-registry';
import type { TypedOrchestratorHooks } from '../../shared/types/plugin.types';
import type { InstanceManager } from '../instance/instance-manager';

beforeEach(() => {
  _resetOrchestratorPluginManagerForTesting();
  _resetPluginRegistryForTesting();
  mockReactionEngine.removeAllListeners();
  mockDebateCoordinator.removeAllListeners();
  mockConsensusCoordinator.removeAllListeners();
  mockSessionContinuity.removeAllListeners();
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
        slot: 'hook',
        loadReport: {
          slot: 'hook',
          detected: true,
          ready: true,
          phases: [],
        },
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

  it('reads packaged .codex-plugin/plugin.json manifests during plugin scan', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'packaged-plugin');
    await fsPromises.mkdir(path.join(pluginDir, '.codex-plugin'), { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    await fsPromises.writeFile(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'packaged-plugin',
        version: '2.0.0',
        description: 'Packaged runtime plugin',
        hooks: ['instance.created'],
      }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({});

    const result = await manager.listPlugins(tmpDir, {} as never);
    const pluginEntry = result.plugins.find((p) => p.filePath === pluginFile);

    expect(pluginEntry?.manifest).toMatchObject({
      name: 'packaged-plugin',
      version: '2.0.0',
      description: 'Packaged runtime plugin',
    });

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('registers notifier slot plugins with a live runtime', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'notify-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    const notify = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ notify });
    const manager = OrchestratorPluginManager.getInstance();

    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({
      slot: 'notifier',
      create,
    });

    const result = await manager.listPlugins(tmpDir, {} as never);
    const pluginEntry = result.plugins.find((plugin) => plugin.filePath === pluginFile);

    expect(pluginEntry?.slot).toBe('notifier');
    expect(pluginEntry?.loadReport.ready).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    }));
    expect(getPluginRegistry().getRuntimes(tmpDir, 'notifier')).toHaveLength(1);

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks non-hook slot plugins not ready when create(ctx) is missing', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'bad-notifier');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    const manager = OrchestratorPluginManager.getInstance();
    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({
      slot: 'notifier',
    });

    const result = await manager.listPlugins(tmpDir, {} as never);
    const pluginEntry = result.plugins.find((plugin) => plugin.filePath === pluginFile);

    expect(pluginEntry?.slot).toBe('notifier');
    expect(pluginEntry?.loadReport.ready).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      filePath: pluginFile,
      error: 'notifier plugins must export create(ctx)',
    }));

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
        slot: 'hook',
        loadReport: {
          slot: 'hook',
          detected: true,
          ready: true,
          phases: [],
        },
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

  it('routes reaction events to tracker and notifier slot runtimes', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const notify = vi.fn().mockResolvedValue(undefined);
    const track = vi.fn().mockResolvedValue(undefined);
    const instanceManager = new EventEmitter() as InstanceManager & EventEmitter & {
      getInstance: ReturnType<typeof vi.fn>;
    };
    instanceManager.getInstance = vi.fn(() => ({
      id: 'inst-1',
      workingDirectory: '/tmp/project',
    }));

    OrchestratorPluginManager._injectPluginForTesting(manager, '/tmp/project', {}, {
      slot: 'notifier',
      runtime: { notify },
      filePath: '/tmp/project/.orchestrator/plugins/notifier.js',
    });
    OrchestratorPluginManager._injectPluginForTesting(manager, '/tmp/project', {}, {
      slot: 'tracker',
      runtime: { track },
      filePath: '/tmp/project/.orchestrator/plugins/tracker.js',
    });

    manager.initialize(instanceManager);

    mockReactionEngine.emit('reaction:event', {
      id: 'reaction-1',
      type: 'ci.failing',
      priority: 'warning',
      instanceId: 'inst-1',
      timestamp: 123,
      data: { ciStatus: 'failing' },
      message: 'CI is failing',
    });
    mockReactionEngine.emit('reaction:notify-channels', {
      event: {
        id: 'reaction-1',
        type: 'ci.failing',
        priority: 'warning',
        instanceId: 'inst-1',
        timestamp: 123,
        data: { ciStatus: 'failing' },
        message: 'CI is failing',
      },
      priority: 'warning',
      channels: ['desktop'],
    });

    await vi.waitFor(() => {
      expect(track).toHaveBeenCalledWith(expect.objectContaining({
        event: 'reaction.ci.failing',
        instanceId: 'inst-1',
      }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        event: 'reaction.ci.failing',
        message: 'CI is failing',
        channels: ['desktop'],
      }));
    });
  });

  it('routes provider runtime envelopes to telemetry exporter slot runtimes', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const exportRecord = vi.fn().mockResolvedValue(undefined);
    const instanceManager = new EventEmitter() as InstanceManager & EventEmitter & {
      getInstance: ReturnType<typeof vi.fn>;
    };
    instanceManager.getInstance = vi.fn(() => ({
      id: 'inst-1',
      workingDirectory: '/tmp/project',
    }));

    OrchestratorPluginManager._injectPluginForTesting(manager, '/tmp/project', {}, {
      slot: 'telemetry_exporter',
      runtime: { export: exportRecord },
      filePath: '/tmp/project/.orchestrator/plugins/telemetry.js',
    });

    manager.initialize(instanceManager);
    instanceManager.emit('provider:normalized-event', {
      eventId: 'evt-1',
      seq: 7,
      timestamp: 123,
      provider: 'codex',
      instanceId: 'inst-1',
      event: {
        kind: 'status',
        status: 'busy',
      },
    });

    await vi.waitFor(() => {
      expect(exportRecord).toHaveBeenCalledWith(expect.objectContaining({
        event: 'provider.status',
        timestamp: 123,
        attributes: expect.objectContaining({
          provider: 'codex',
          instanceId: 'inst-1',
          seq: 7,
        }),
      }));
    });
  });
});
