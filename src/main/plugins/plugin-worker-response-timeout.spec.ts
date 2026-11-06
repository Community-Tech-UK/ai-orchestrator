import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type { WorkerPluginProviderAdapterOperation } from '@sdk/provider-adapter-worker-bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdapterRegistryImpl } from '../providers/provider-adapter-registry';
import { PluginWorkerHost, PROVIDER_RESPONSE_IDLE_TIMEOUT_MS } from './plugin-worker-host';

describe('provider worker response timeouts', () => {
  const snapshot = {
    providerCapabilities: {
      toolExecution: false, streaming: true, multiTurn: false, vision: false,
      fileAttachments: false, functionCalling: false, builtInCodeTools: false,
    },
    usage: null, pid: null, running: true, sessionId: 'fixture-session',
  };
  let host: PluginWorkerHost;
  let adapter: ProviderAdapter;
  let runtime: Awaited<ReturnType<PluginWorkerHost['start']>>;
  let worker: Worker & { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    worker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(0),
    }) as unknown as typeof worker;
    const registry = new ProviderAdapterRegistryImpl();
    host = new PluginWorkerHost({
      filePath: '/fixture/provider.cjs', context: { appPath: '/fixture', homeDir: null },
      workerFactory: () => worker, providerAdapterApi: registry,
    });
    const started = host.start();
    worker.emit('message', {
      type: 'ready', slot: 'provider', detected: true, ready: true, hookKeys: ['instance.removed'],
      providerAdapters: [{
        descriptor: {
          provider: 'plugin:proof', displayName: 'Fixture provider', isolation: 'worker',
          capabilities: {
            interruption: false, permissionPrompts: false, sessionResume: false,
            streamingOutput: true, usageReporting: false, subAgents: false,
          },
          defaultConfig: { type: 'plugin:proof', name: 'Fixture provider', enabled: true },
        },
        factoryRef: 'factory:proof',
      }],
    });
    runtime = await started;
    adapter = registry.createPluginProviderAdapter('plugin:proof', {
      type: 'plugin:proof', name: 'Fixture provider', enabled: true,
    });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await host.stop();
    vi.useRealTimers();
  });

  function pendingMessage() {
    return worker.postMessage.mock.lastCall![0] as {
      id: number;
      operation: { kind: 'provider_adapter'; operation: WorkerPluginProviderAdapterOperation };
    };
  }

  function progress(adapterId: string): void {
    worker.emit('message', { type: 'provider-event', adapterId, envelope: {
      eventId: randomUUID(), provider: 'plugin:proof', instanceId: 'fixture-instance',
      timestamp: Date.now(), seq: 0, event: { kind: 'output', content: 'partial' },
    } });
  }

  function complete(id: number): void {
    worker.emit('message', { type: 'rpc-response', id, result: { snapshot } });
  }

  it('accepts a send operation that returns after thirty seconds', async () => {
    const sent = adapter.sendMessage('hello');
    const message = pendingMessage();
    let settled = false;
    const outcome = sent.then(() => { settled = true; }, (error: unknown) => { settled = true; throw error; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    complete(message.id);
    await expect(outcome).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a matching adapter response alive while it streams beyond five minutes', async () => {
    const sent = adapter.sendMessage('hello');
    const message = pendingMessage();
    const adapterId = message.operation.operation.adapterId;
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
    progress(adapterId);
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
    progress(adapterId);
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
    complete(message.id);
    await expect(sent).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a silent adapter even when a different adapter emits output', async () => {
    const outcome = adapter.sendMessage('hello').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
    progress('another-adapter');
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringContaining('Plugin worker operation timeout') }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the five-second bound on ordinary worker operations', async () => {
    const outcome = Promise.resolve(runtime.hooks['instance.removed']!({ instanceId: 'fixture-instance' }))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringContaining('Plugin worker operation timeout') }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
