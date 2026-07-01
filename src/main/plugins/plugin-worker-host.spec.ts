import { EventEmitter } from 'node:events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginWorkerHost, resolveWorkerExecArgv } from './plugin-worker-host';
import { ProviderAdapterRegistryImpl } from '../providers/provider-adapter-registry';

describe('resolveWorkerExecArgv (Task 17)', () => {
  it('registers tsx when the plugin file is TypeScript, even with a .js host', () => {
    expect(resolveWorkerExecArgv('/app/plugin-worker-host.js', '/plugins/index.ts')).toEqual(['--import', 'tsx']);
    expect(resolveWorkerExecArgv('/app/plugin-worker-host.js', '/plugins/index.mts')).toEqual(['--import', 'tsx']);
  });

  it('registers tsx when the worker-host entrypoint itself is TypeScript (dev build)', () => {
    expect(resolveWorkerExecArgv('/app/plugin-worker-host.ts', '/plugins/index.js')).toEqual(['--import', 'tsx']);
  });

  it('uses no extra execArgv for a plain JavaScript plugin under a JavaScript host', () => {
    expect(resolveWorkerExecArgv('/app/plugin-worker-host.js', '/plugins/index.js')).toEqual([]);
  });
});

describe('PluginWorkerHost', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-worker-host-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs hook plugins in a worker with SDK-only context', async () => {
    const markerPath = path.join(tempDir, 'marker.json');
    const pluginFile = path.join(tempDir, 'hook-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        const fs = require('fs');
        module.exports = async (ctx) => ({
          hooks: {
            'instance.removed': async (payload) => {
              fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
                payload,
                hasInstanceManager: Object.prototype.hasOwnProperty.call(ctx, 'instanceManager'),
                appPath: ctx.appPath,
                homeDir: ctx.homeDir
              }));
            }
          }
        });
      `,
    );

    const host = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
    });

    const runtime = await host.start();
    await runtime.hooks['instance.removed']?.({ instanceId: 'inst-1' });
    await host.stop();

    const marker = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as {
      payload: { instanceId: string };
      hasInstanceManager: boolean;
      appPath: string;
      homeDir: string;
    };
    expect(marker).toEqual({
      payload: { instanceId: 'inst-1' },
      hasInstanceManager: false,
      appPath: '/tmp/test-app',
      homeDir: '/tmp/test-home',
    });
  });

  it('proxies notifier runtime calls through the worker', async () => {
    const markerPath = path.join(tempDir, 'notify.json');
    const pluginFile = path.join(tempDir, 'notifier-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        const fs = require('fs');
        module.exports = {
          slot: 'notifier',
          create: async () => ({
            notify: async (notification) => {
              fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(notification));
            }
          })
        };
      `,
    );

    const host = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: null },
      requestedSlot: 'notifier',
    });

    const runtime = await host.start();
    await runtime.notifier?.notify({
      event: 'reaction.ci.failing',
      message: 'CI is failing',
      timestamp: 123,
    });
    await host.stop();

    await expect(fs.readFile(markerPath, 'utf-8'))
      .resolves
      .toContain('CI is failing');
  });

  it('registers provider adapters declared from worker context before ready', async () => {
    const pluginFile = path.join(tempDir, 'provider-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        module.exports = async (ctx) => {
          ctx.providerAdapters.registerProviderAdapterFactory('factory:worker-provider', () => ({
            provider: 'plugin:worker-provider',
            capabilities: {
              interruption: true,
              permissionPrompts: false,
              sessionResume: true,
              streamingOutput: true,
              usageReporting: false,
              subAgents: false
            },
            events$: { subscribe: () => ({ unsubscribe() {} }) },
            getCapabilities: () => ({
              toolExecution: false,
              streaming: true,
              multiTurn: true,
              vision: false,
              fileAttachments: false,
              functionCalling: false,
              builtInCodeTools: false
            }),
            checkStatus: async () => ({ type: 'openai-compatible', available: true, authenticated: true }),
            initialize: async () => undefined,
            sendMessage: async () => undefined,
            terminate: async () => undefined,
            getUsage: () => null,
            getPid: () => null,
            isRunning: () => false,
            getSessionId: () => ''
          }));
          ctx.providerAdapters.registerProviderAdapter({
            provider: 'plugin:worker-provider',
            displayName: 'Worker Provider',
            capabilities: {
              interruption: true,
              permissionPrompts: false,
              sessionResume: true,
              streamingOutput: true,
              usageReporting: false,
              subAgents: false
            },
            defaultConfig: {
              type: 'openai-compatible',
              name: 'Worker Provider',
              enabled: true
            },
            isolation: 'worker'
          }, 'factory:worker-provider');
          return { hooks: {} };
        };
      `,
    );
    const registrations: unknown[] = [];
    const host = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
      providerAdapterApi: {
        registerProviderAdapter: (descriptor, factoryRef) => {
          registrations.push({ descriptor, factoryRef });
        },
      },
    });

    const runtime = await host.start();
    await host.stop();

    expect(runtime.providerAdapters).toEqual([
      {
        descriptor: expect.objectContaining({
          provider: 'plugin:worker-provider',
          displayName: 'Worker Provider',
          isolation: 'worker',
        }),
        factoryRef: 'factory:worker-provider',
      },
    ]);
    expect(registrations).toEqual(runtime.providerAdapters);
  });

  it('unregisters worker provider adapters on stop so the plugin can reload', async () => {
    const pluginFile = path.join(tempDir, 'provider-reload-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        module.exports = async (ctx) => {
          ctx.providerAdapters.registerProviderAdapterFactory('factory:worker-provider', () => ({
            provider: 'plugin:worker-provider',
            capabilities: {
              interruption: true,
              permissionPrompts: false,
              sessionResume: true,
              streamingOutput: true,
              usageReporting: false,
              subAgents: false
            },
            events$: { subscribe: () => ({ unsubscribe() {} }) },
            getCapabilities: () => ({
              toolExecution: false,
              streaming: true,
              multiTurn: true,
              vision: false,
              fileAttachments: false,
              functionCalling: false,
              builtInCodeTools: false
            }),
            checkStatus: async () => ({ type: 'plugin:worker-provider', available: true, authenticated: true }),
            initialize: async () => undefined,
            sendMessage: async () => undefined,
            terminate: async () => undefined,
            getUsage: () => null,
            getPid: () => null,
            isRunning: () => false,
            getSessionId: () => ''
          }));
          ctx.providerAdapters.registerProviderAdapter({
            provider: 'plugin:worker-provider',
            displayName: 'Worker Provider',
            capabilities: {
              interruption: true,
              permissionPrompts: false,
              sessionResume: true,
              streamingOutput: true,
              usageReporting: false,
              subAgents: false
            },
            defaultConfig: {
              type: 'plugin:worker-provider',
              name: 'Worker Provider',
              enabled: true
            },
            isolation: 'worker'
          }, 'factory:worker-provider');
          return { hooks: {} };
        };
      `,
    );
    const registry = new ProviderAdapterRegistryImpl();
    const firstHost = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
      providerAdapterApi: registry,
    });

    await firstHost.start();
    expect(registry.listCreatablePluginProviderAdapters()).toHaveLength(1);
    await firstHost.stop();
    expect(registry.listCreatablePluginProviderAdapters()).toHaveLength(0);

    const secondHost = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
      providerAdapterApi: registry,
    });
    await expect(secondHost.start()).resolves.toMatchObject({ ready: true });
    await secondHost.stop();
  });

  it('creates and invokes worker provider adapters through a registered factory ref', async () => {
    const markerPath = path.join(tempDir, 'provider-marker.json');
    const pluginFile = path.join(tempDir, 'provider-factory-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        const fs = require('fs');
        const events$ = { subscribe: () => ({ unsubscribe() {} }) };
        module.exports = async (ctx) => {
          ctx.providerAdapters.registerProviderAdapterFactory('factory:worker-provider', (config) => {
            let running = false;
            let sessionId = '';
            return {
              provider: 'plugin:worker-provider',
              capabilities: {
                interruption: true,
                permissionPrompts: false,
                sessionResume: true,
                streamingOutput: true,
                usageReporting: true,
                subAgents: false
              },
              events$,
              getCapabilities: () => ({
                toolExecution: true,
                streaming: true,
                multiTurn: true,
                vision: false,
                fileAttachments: true,
                functionCalling: true,
                builtInCodeTools: false
              }),
              checkStatus: async () => ({
                type: config.type,
                available: true,
                authenticated: true
              }),
              initialize: async (options) => {
                running = true;
                sessionId = options.sessionId || 'worker-session';
                fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
                  config,
                  initialize: options
                }));
              },
              sendMessage: async (message, attachments) => {
                const current = JSON.parse(fs.readFileSync(${JSON.stringify(markerPath)}, 'utf8'));
                fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
                  ...current,
                  message,
                  attachmentCount: attachments ? attachments.length : 0
                }));
              },
              terminate: async () => {
                running = false;
              },
              getUsage: () => ({
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3
              }),
              getPid: () => 4242,
              isRunning: () => running,
              getSessionId: () => sessionId
            };
          });
          ctx.providerAdapters.registerProviderAdapter({
            provider: 'plugin:worker-provider',
            displayName: 'Worker Provider',
            capabilities: {
              interruption: true,
              permissionPrompts: false,
              sessionResume: true,
              streamingOutput: true,
              usageReporting: true,
              subAgents: false
            },
            defaultConfig: {
              type: 'openai-compatible',
              name: 'Worker Provider',
              enabled: true
            },
            isolation: 'worker'
          }, 'factory:worker-provider');
          return { hooks: {} };
        };
      `,
    );
    const registry = new ProviderAdapterRegistryImpl();
    const host = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
      providerAdapterApi: registry,
    });

    await host.start();
    const adapter = registry.createPluginProviderAdapter('plugin:worker-provider', {
      type: 'openai-compatible',
      name: 'Runtime Worker Provider',
      enabled: true,
    });
    await expect(adapter.checkStatus()).resolves.toMatchObject({
      type: 'openai-compatible',
      available: true,
      authenticated: true,
    });
    await adapter.initialize({ workingDirectory: tempDir, instanceId: 'inst-1' });
    await adapter.sendMessage('hello worker', [{ type: 'file', name: 'note.txt', mimeType: 'text/plain', data: 'hi' }]);

    expect(adapter.provider).toBe('plugin:worker-provider');
    expect(adapter.isRunning()).toBe(true);
    expect(adapter.getSessionId()).toBe('worker-session');
    expect(adapter.getPid()).toBe(4242);
    expect(adapter.getUsage()).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    await expect(fs.readFile(markerPath, 'utf-8')).resolves.toContain('hello worker');

    await adapter.terminate();
    expect(adapter.isRunning()).toBe(false);
    await host.stop();
  });

  it('rejects and terminates when a plugin never reaches worker startup ready', async () => {
    const pluginFile = path.join(tempDir, 'startup-hang-plugin.js');
    await fs.writeFile(
      pluginFile,
      `
        while (true) {}
        module.exports = { hooks: { 'instance.removed': () => undefined } };
      `,
    );

    const host = new PluginWorkerHost({
      filePath: pluginFile,
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      requestedSlot: 'hook',
      rpcTimeoutMs: 100,
    });

    try {
      const result = await Promise.race([
        host.start().then(
          () => 'started',
          (error: unknown) => error instanceof Error ? error.message : String(error),
        ),
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 750)),
      ]);

      expect(result).toContain('Plugin worker startup timeout');
    } finally {
      await host.stop();
    }
  });

  it('handles worker runtime errors after startup without throwing in the host', async () => {
    const fakeWorker = new EventEmitter() as Worker & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    fakeWorker.postMessage = vi.fn();
    fakeWorker.terminate = vi.fn().mockResolvedValue(0);

    const host = new PluginWorkerHost({
      filePath: path.join(tempDir, 'fake-worker-plugin.js'),
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      workerFactory: () => fakeWorker,
    });

    const started = host.start();
    fakeWorker.emit('message', {
      type: 'ready',
      slot: 'hook',
      detected: true,
      ready: true,
      hookKeys: ['instance.removed'],
    });
    const runtime = await started;

    expect(() => fakeWorker.emit('error', new Error('worker-crash'))).not.toThrow();
    await expect(runtime.hooks['instance.removed']?.({ instanceId: 'inst-1' }))
      .rejects
      .toThrow('Plugin worker is not running');
  });

  it('does not cache a stale runtime when a worker exits immediately after ready', async () => {
    const workers: (Worker & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    })[] = [];
    const host = new PluginWorkerHost({
      filePath: path.join(tempDir, 'exiting-worker-plugin.js'),
      context: { appPath: '/tmp/test-app', homeDir: '/tmp/test-home' },
      workerFactory: () => {
        const worker = new EventEmitter() as Worker & {
          postMessage: ReturnType<typeof vi.fn>;
          terminate: ReturnType<typeof vi.fn>;
        };
        worker.postMessage = vi.fn();
        worker.terminate = vi.fn().mockResolvedValue(0);
        workers.push(worker);
        return worker;
      },
    });

    const firstStart = host.start();
    workers[0]?.emit('message', {
      type: 'ready',
      slot: 'hook',
      detected: true,
      ready: true,
      hookKeys: ['instance.removed'],
    });
    workers[0]?.emit('exit', 0);
    const staleRuntime = await firstStart;

    await expect(staleRuntime.hooks['instance.removed']?.({ instanceId: 'inst-1' }))
      .rejects
      .toThrow('Plugin worker is not running');

    const secondStart = host.start();
    expect(workers).toHaveLength(2);
    workers[1]?.emit('message', {
      type: 'ready',
      slot: 'hook',
      detected: true,
      ready: true,
      hookKeys: [],
    });
    await expect(secondStart).resolves.toMatchObject({ ready: true });
  });
});
