import { describe, expect, it, vi } from 'vitest';
import { WorkerPluginProviderAdapterRuntime } from '../provider-adapter-worker-bridge';
import type { WorkerPluginProviderAdapterOperation } from '../provider-adapter-worker-bridge';
import type { ProviderConfig } from '@shared/types/provider.types';

function makeFakeAdapter(overrides: Record<string, unknown> = {}) {
  const unsubscribe = vi.fn();
  const adapter: Record<string, unknown> = {
    provider: 'plugin:test',
    capabilities: {
      interruption: false,
      permissionPrompts: false,
      sessionResume: false,
      streamingOutput: false,
      usageReporting: false,
      subAgents: false,
    },
    events$: { subscribe: vi.fn(() => ({ unsubscribe })) },
    getCapabilities: vi.fn(() => ({
      toolExecution: false,
      streaming: false,
      multiTurn: false,
      vision: false,
      fileAttachments: false,
      functionCalling: false,
      builtInCodeTools: false,
    })),
    checkStatus: vi.fn(async () => ({ type: 'plugin:test', available: true, authenticated: true })),
    initialize: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    getUsage: vi.fn(() => null),
    getPid: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    getSessionId: vi.fn(() => 'session'),
    ...overrides,
  };
  return { adapter, unsubscribe };
}

function operation(overrides: Partial<WorkerPluginProviderAdapterOperation> = {}): WorkerPluginProviderAdapterOperation {
  return {
    provider: 'plugin:test',
    factoryRef: 'ref',
    adapterId: 'adapter-1',
    config: {} as ProviderConfig,
    method: 'getCapabilities',
    args: [],
    ...overrides,
  };
}

describe('WorkerPluginProviderAdapterRuntime', () => {
  it('terminates the adapter when validation throws after the factory created it', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const { adapter } = makeFakeAdapter({ getSessionId: undefined });
    const factory = vi.fn(async () => adapter);
    runtime.api.registerProviderAdapterFactory('ref', factory as never);

    await expect(runtime.invoke(operation())).rejects.toThrow('missing getSessionId()');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(adapter['terminate']).toHaveBeenCalledWith(true);

    // The failed adapter must not be retained; the next call re-runs the factory.
    await expect(runtime.invoke(operation())).rejects.toThrow('missing getSessionId()');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not throw when a validation-failed adapter has no callable terminate', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const { adapter } = makeFakeAdapter({ getSessionId: undefined, terminate: undefined });
    runtime.api.registerProviderAdapterFactory('ref', (async () => adapter) as never);

    await expect(runtime.invoke(operation())).rejects.toThrow('missing terminate()');
  });

  it('rethrows the original validation error even when terminate itself fails', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const { adapter } = makeFakeAdapter({
      getSessionId: undefined,
      terminate: vi.fn(async () => {
        throw new Error('terminate exploded');
      }),
    });
    runtime.api.registerProviderAdapterFactory('ref', (async () => adapter) as never);

    await expect(runtime.invoke(operation())).rejects.toThrow('missing getSessionId()');
  });

  it('disposeAll unsubscribes, terminates every live adapter, and clears the map', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const first = makeFakeAdapter();
    const second = makeFakeAdapter();
    const adapters = [first.adapter, second.adapter];
    const factory = vi.fn(async () => adapters[factory.mock.calls.length - 1]);
    runtime.api.registerProviderAdapterFactory('ref', factory as never);

    await runtime.invoke(operation({ adapterId: 'adapter-1' }));
    await runtime.invoke(operation({ adapterId: 'adapter-2' }));
    expect(factory).toHaveBeenCalledTimes(2);

    await runtime.disposeAll();
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.adapter['terminate']).toHaveBeenCalledWith(true);
    expect(second.adapter['terminate']).toHaveBeenCalledWith(true);

    // Map cleared: a new invoke for a disposed id re-runs the factory.
    const third = makeFakeAdapter();
    adapters.push(third.adapter);
    await runtime.invoke(operation({ adapterId: 'adapter-1' }));
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('disposeAll is idempotent with per-adapter terminate', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const { adapter, unsubscribe } = makeFakeAdapter();
    runtime.api.registerProviderAdapterFactory('ref', (async () => adapter) as never);

    await runtime.invoke(operation());
    await runtime.invoke(operation({ method: 'terminate', args: [true] }));
    expect(adapter['terminate']).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await runtime.disposeAll();
    await runtime.disposeAll();
    // Already terminated via the RPC path; disposeAll must not double-terminate.
    expect(adapter['terminate']).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('disposeAll continues after one adapter cleanup fails', async () => {
    const runtime = new WorkerPluginProviderAdapterRuntime(vi.fn());
    const failing = makeFakeAdapter({
      terminate: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const healthy = makeFakeAdapter();
    const adapters = [failing.adapter, healthy.adapter];
    const factory = vi.fn(async () => adapters[factory.mock.calls.length - 1]);
    runtime.api.registerProviderAdapterFactory('ref', factory as never);

    await runtime.invoke(operation({ adapterId: 'adapter-1' }));
    await runtime.invoke(operation({ adapterId: 'adapter-2' }));

    await expect(runtime.disposeAll()).resolves.toBeUndefined();
    expect(healthy.adapter['terminate']).toHaveBeenCalledWith(true);
    expect(healthy.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
