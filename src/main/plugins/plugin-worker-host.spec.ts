import { EventEmitter } from 'node:events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginWorkerHost, resolveWorkerExecArgv } from './plugin-worker-host';

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
    const workers: Array<Worker & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    }> = [];
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
