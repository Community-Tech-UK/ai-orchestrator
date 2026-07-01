import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReactionEngine = new EventEmitter();
const mockDebateCoordinator = new EventEmitter();
const mockConsensusCoordinator = new EventEmitter();
const mockSessionContinuity = new EventEmitter();
const settingsMock = vi.hoisted(() => ({
  value: {
    agents: {},
    appearance: {},
    projectPluginTrust: {},
  } as Record<string, unknown>,
}));

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
    getAll: () => settingsMock.value,
  }),
}));

const mockPluginWorkerHostInstances: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  options: unknown;
}[] = [];

vi.mock('./plugin-worker-host', () => ({
  PluginWorkerHost: vi.fn().mockImplementation((options: unknown) => {
    const instance = {
      options,
      start: vi.fn().mockResolvedValue({
        slot: 'hook',
        detected: true,
        ready: true,
        hooks: {
          'instance.removed': vi.fn().mockResolvedValue(undefined),
        },
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mockPluginWorkerHostInstances.push(instance);
    return instance;
  }),
}));

import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  _resetOrchestratorPluginManagerForTesting,
  OrchestratorPluginManager,
} from './plugin-manager';
import { classifyPluginEntrypoint } from './plugin-entrypoint';
import { getPluginRegistry, _resetPluginRegistryForTesting } from './plugin-registry';
import type { TypedOrchestratorHooks } from '../../shared/types/plugin.types';
import type { InstanceManager } from '../instance/instance-manager';

function trustProjectRoot(projectRoot: string): void {
  const current = settingsMock.value['projectPluginTrust'];
  const trustMap = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  settingsMock.value = {
    ...settingsMock.value,
    projectPluginTrust: {
      ...trustMap,
      [path.resolve(projectRoot)]: 'trusted',
    },
  };
}

beforeEach(() => {
  _resetOrchestratorPluginManagerForTesting();
  _resetPluginRegistryForTesting();
  settingsMock.value = {
    agents: {},
    appearance: {},
    projectPluginTrust: {},
  };
  mockReactionEngine.removeAllListeners();
  mockDebateCoordinator.removeAllListeners();
  mockConsensusCoordinator.removeAllListeners();
  mockSessionContinuity.removeAllListeners();
  mockPluginWorkerHostInstances.length = 0;
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
    trustProjectRoot(tmpDir);
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
    trustProjectRoot(tmpDir);
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
    trustProjectRoot(tmpDir);
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

  it('passes SDK-only context to module factories and create hooks', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'ctx-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    const moduleFactory = vi.fn().mockReturnValue({
      slot: 'notifier',
      create: vi.fn().mockResolvedValue({ notify: vi.fn() }),
    });
    const manager = OrchestratorPluginManager.getInstance();

    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue(moduleFactory);

    await manager.listPlugins(tmpDir, {} as never);

    const factoryContext = moduleFactory.mock.calls[0]?.[0] as Record<string, unknown>;
    const createContext = moduleFactory.mock.results[0]?.value.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(factoryContext).toEqual({
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    });
    expect(createContext).toEqual({
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    });
    expect(factoryContext).not.toHaveProperty('instanceManager');
    expect(createContext).not.toHaveProperty('instanceManager');

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads worker-isolated manifest plugins through PluginWorkerHost', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'worker-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'worker-plugin',
        version: '1.0.0',
        isolation: 'worker',
        hooks: ['instance.removed'],
      }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const result = await manager.listPlugins(tmpDir, {} as never);

    const pluginEntry = result.plugins.find((plugin) => plugin.filePath === pluginFile);
    expect(pluginEntry?.loadReport.ready).toBe(true);
    expect(pluginEntry?.hookKeys).toEqual(['instance.removed']);
    expect(mockPluginWorkerHostInstances).toHaveLength(1);
    expect(mockPluginWorkerHostInstances[0]?.options).toMatchObject({
      filePath: pluginFile,
      requestedSlot: 'hook',
      providerAdapterApi: {
        registerProviderAdapter: expect.any(Function),
      },
      context: {
        appPath: '/tmp/test-app',
        homeDir: '/tmp/test-home',
      },
    });

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('classifyPluginEntrypoint distinguishes TypeScript from JavaScript by extension', () => {
    expect(classifyPluginEntrypoint('/x/index.ts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/x/index.mts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/x/index.cts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/x/index.js')).toBe('javascript');
    expect(classifyPluginEntrypoint('/x/Index.JS')).toBe('javascript');
  });

  it('Task 17: loads a worker-isolated TypeScript plugin through PluginWorkerHost', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'ts-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.ts');
    await fsPromises.writeFile(pluginFile, 'export default {};');
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'ts-plugin', version: '1.0.0', isolation: 'worker', hooks: ['instance.removed'] }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const result = await manager.listPlugins(tmpDir, {} as never);

    const entry = result.plugins.find((plugin) => plugin.filePath === pluginFile);
    expect(entry?.loadReport.ready).toBe(true);
    expect(mockPluginWorkerHostInstances).toHaveLength(1);
    expect(mockPluginWorkerHostInstances[0]?.options).toMatchObject({ filePath: pluginFile });

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('Task 17: rejects an in-process (non-worker) TypeScript plugin with an actionable diagnostic', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'ts-inprocess');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.ts');
    await fsPromises.writeFile(pluginFile, 'export default {};');
    // Manifest present but WITHOUT isolation: 'worker'.
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'ts-inprocess', version: '1.0.0', hooks: ['instance.removed'] }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const result = await manager.listPlugins(tmpDir, {} as never);

    const entry = result.plugins.find((plugin) => plugin.filePath === pluginFile);
    expect(entry?.loadReport.ready).toBe(false);
    expect(entry?.loadReport.error).toContain('isolation');
    expect(entry?.loadReport.error).toContain('worker');
    // No worker host was started for the rejected in-process TS plugin.
    expect(mockPluginWorkerHostInstances).toHaveLength(0);

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('Task 17: prefers the compiled .js over a sibling .ts entrypoint (no double-load)', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'dual-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    await fsPromises.writeFile(path.join(pluginDir, 'index.js'), 'module.exports = {};');
    await fsPromises.writeFile(path.join(pluginDir, 'index.ts'), 'export default {};');
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'dual-plugin', version: '1.0.0', hooks: ['instance.removed'] }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const result = await manager.listPlugins(tmpDir, {} as never);

    const dualEntries = result.plugins.filter((plugin) => plugin.filePath.startsWith(pluginDir));
    expect(dualEntries).toHaveLength(1);
    expect(dualEntries[0]?.filePath).toBe(path.join(pluginDir, 'index.js'));

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks non-hook slot plugins not ready when create(ctx) is missing', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    trustProjectRoot(tmpDir);
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

  it('surfaces untrusted project plugin metadata without importing the entrypoint', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'untrusted-plugin');
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'throw new Error("should not import");');
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'untrusted-plugin',
        version: '1.0.0',
        isolation: 'worker',
        hooks: ['instance.removed'],
      }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const loadSpy = vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    );
    const result = await manager.listPlugins(tmpDir, {} as never);

    const pluginEntry = result.plugins.find((plugin) => plugin.filePath === pluginFile);
    expect(pluginEntry?.manifest).toMatchObject({
      name: 'untrusted-plugin',
      version: '1.0.0',
    });
    expect(pluginEntry?.loadReport.ready).toBe(false);
    expect(pluginEntry?.loadReport.detected).toBe(false);
    expect(pluginEntry?.loadReport.phases).toContainEqual(expect.objectContaining({
      phase: 'instantiation',
      status: 'skipped',
      message: expect.stringContaining('trust'),
    }));
    expect(loadSpy).not.toHaveBeenCalled();
    expect(mockPluginWorkerHostInstances).toHaveLength(0);

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads user-installed home plugins without a project trust decision', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-manager-test-'));
    const pluginDir = path.join('/tmp/test-home', '.orchestrator', 'plugins', `home-plugin-${Date.now()}`);
    await fsPromises.mkdir(pluginDir, { recursive: true });

    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'home-plugin',
        version: '1.0.0',
        hooks: ['instance.created'],
      }),
    );

    const manager = OrchestratorPluginManager.getInstance();
    const loadSpy = vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({});
    const result = await manager.listPlugins(tmpDir, {} as never);

    const pluginEntry = result.plugins.find((plugin) => plugin.filePath === pluginFile);
    expect(pluginEntry?.loadReport.ready).toBe(true);
    expect(loadSpy).toHaveBeenCalledWith(pluginFile);

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
    await fsPromises.rm(pluginDir, { recursive: true, force: true });
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

describe('OrchestratorPluginManager — runtime lifecycle / quarantine (B11)', () => {
  const ctx = {
    instanceManager: {} as never,
    appPath: '/tmp/test-app',
    homeDir: '/tmp/test-home',
  };

  /** Spy getPlugins so a single controlled hook plugin is returned for both emit + list. */
  function spyHookPlugin(
    manager: OrchestratorPluginManager,
    filePath: string,
    hook: (payload: unknown) => unknown,
  ): void {
    vi.spyOn(
      manager as unknown as {
        getPlugins: (workingDirectory: string, pluginCtx: unknown) => Promise<unknown[]>;
      },
      'getPlugins',
    ).mockResolvedValue([
      {
        filePath,
        slot: 'hook',
        loadReport: { slot: 'hook', detected: true, ready: true, phases: [] },
        hooks: { 'instance.removed': hook },
      },
    ]);
  }

  async function emitRemoved(manager: OrchestratorPluginManager, n: number): Promise<void> {
    const emit = (
      manager as unknown as {
        emitToPlugins: (
          wd: string,
          c: typeof ctx,
          event: 'instance.removed',
          payload: { instanceId: string },
        ) => Promise<void>;
      }
    ).emitToPlugins.bind(manager);
    for (let i = 0; i < n; i++) {
      await emit('/tmp/project', ctx, 'instance.removed', { instanceId: `inst-${i}` });
    }
  }

  it('degrades then quarantines after repeated failures and skips the plugin thereafter', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi.fn(() => {
      throw new Error('always boom');
    });
    spyHookPlugin(manager, '/tmp/plugin.js', hook);

    // Threshold is 3 consecutive failures. Emit 6 times.
    await emitRemoved(manager, 6);

    // Invoked exactly 3 times (calls 1-3 fail → quarantine on the 3rd); calls 4-6 skipped.
    expect(hook).toHaveBeenCalledTimes(3);
    expect(manager.isPluginQuarantined('/tmp/plugin.js')).toBe(true);
  });

  it('surfaces lifecycle state (active → degraded → quarantined) via listPlugins', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi.fn(() => {
      throw new Error('boom');
    });
    spyHookPlugin(manager, '/tmp/plugin.js', hook);

    const stateOf = async (): Promise<string | undefined> => {
      const result = await manager.listPlugins('/tmp/project', {} as never);
      return result.plugins.find((p) => p.filePath === '/tmp/plugin.js')?.lifecycle;
    };

    expect(await stateOf()).toBe('active');
    await emitRemoved(manager, 1);
    expect(await stateOf()).toBe('degraded');
    await emitRemoved(manager, 2); // 3 total → quarantined
    expect(await stateOf()).toBe('quarantined');

    const result = await manager.listPlugins('/tmp/project', {} as never);
    const entry = result.plugins.find((p) => p.filePath === '/tmp/plugin.js');
    expect(entry?.health).toMatchObject({
      quarantined: true,
      totalFailures: 3,
      consecutiveFailures: 3,
      lastError: 'boom',
    });
  });

  it('recovers a degraded plugin to active on the next successful dispatch', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient');
      })
      .mockImplementation(() => undefined);
    spyHookPlugin(manager, '/tmp/plugin.js', hook);

    await emitRemoved(manager, 1); // fails → degraded
    let result = await manager.listPlugins('/tmp/project', {} as never);
    expect(result.plugins[0]?.lifecycle).toBe('degraded');

    await emitRemoved(manager, 1); // succeeds → consecutiveFailures reset → active
    result = await manager.listPlugins('/tmp/project', {} as never);
    expect(result.plugins[0]?.lifecycle).toBe('active');
    expect(result.plugins[0]?.health).toMatchObject({ consecutiveFailures: 0, totalFailures: 1 });
    expect(manager.isPluginQuarantined('/tmp/plugin.js')).toBe(false);
  });

  it('resets quarantine when the plugin file changes on disk (hot-reload recovery)', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'plugin-lifecycle-'));
    trustProjectRoot(tmpDir);
    const pluginDir = path.join(tmpDir, '.orchestrator', 'plugins', 'flaky');
    await fsPromises.mkdir(pluginDir, { recursive: true });
    const pluginFile = path.join(pluginDir, 'index.js');
    await fsPromises.writeFile(pluginFile, 'module.exports = {};');

    const manager = OrchestratorPluginManager.getInstance();
    // loadModule is spied (no real import) but the rest of the real load path —
    // including fs.stat + reconcileHealthOnLoad — runs against the temp file.
    vi.spyOn(
      manager as unknown as { loadModule: (filePath: string) => Promise<unknown> },
      'loadModule',
    ).mockResolvedValue({
      'instance.removed': () => {
        throw new Error('disk boom');
      },
    });

    // Initial load → healthy.
    let result = await manager.listPlugins(tmpDir, {} as never);
    expect(result.plugins.find((p) => p.filePath === pluginFile)?.lifecycle).toBe('active');

    // Drive 3 failures through the real cached plugin → quarantined.
    await (manager as unknown as { emitHook: (e: string, p: unknown) => Promise<void> })
      .emitHook('instance.removed', { instanceId: 'x' });
    await (manager as unknown as { emitHook: (e: string, p: unknown) => Promise<void> })
      .emitHook('instance.removed', { instanceId: 'y' });
    await (manager as unknown as { emitHook: (e: string, p: unknown) => Promise<void> })
      .emitHook('instance.removed', { instanceId: 'z' });
    expect(manager.isPluginQuarantined(pluginFile)).toBe(true);

    // Change the file's mtime, force a reload (scoped clear keeps health) → recovery.
    const future = new Date(Date.now() + 60_000);
    await fsPromises.utimes(pluginFile, future, future);
    manager.clearCache(tmpDir);
    result = await manager.listPlugins(tmpDir, {} as never);
    expect(manager.isPluginQuarantined(pluginFile)).toBe(false);
    expect(result.plugins.find((p) => p.filePath === pluginFile)?.lifecycle).toBe('active');

    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('a full clearCache() resets all runtime health', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook = vi.fn(() => {
      throw new Error('boom');
    });
    spyHookPlugin(manager, '/tmp/plugin.js', hook);
    await emitRemoved(manager, 3);
    expect(manager.isPluginQuarantined('/tmp/plugin.js')).toBe(true);

    manager.clearCache(); // no arg → explicit global reset
    expect(manager.isPluginQuarantined('/tmp/plugin.js')).toBe(false);
  });
});
