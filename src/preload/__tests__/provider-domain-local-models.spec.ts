import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createProviderDomain } from '../domains/provider.preload';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { IPC_CHANNELS } from '../generated/channels';

describe('providerDomain local model inventory', () => {
  it('invokes the local model inventory channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { models: [] } });
    const ipcRenderer = { invoke } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    await domain.getLocalModelInventory();

    expect(invoke).toHaveBeenCalledWith('models:local-model-inventory');
  });

  it('invokes local reviewer qualification with the exact selector', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { status: 'verified' } });
    const ipcRenderer = { invoke } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    await domain.qualifyLocalReviewer('lm://this-device/ollama/ollama/qwen');

    expect(invoke).toHaveBeenCalledWith('models:local-reviewer-qualify', {
      selectorId: 'lm://this-device/ollama/ollama/qwen',
    });
  });

  it('authenticates local reviewer qualification requests', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { status: 'verified' } });
    const ipcRenderer = { invoke } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS, (payload = {}) => ({
      ...payload,
      ipcAuthToken: 'token',
    }));

    await domain.qualifyLocalReviewer('lm://this-device/ollama/ollama/qwen');

    expect(invoke).toHaveBeenCalledWith('models:local-reviewer-qualify', {
      selectorId: 'lm://this-device/ollama/ollama/qwen',
      ipcAuthToken: 'token',
    });
  });

  it('subscribes to local model inventory update pushes', () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipcRenderer = { on, removeListener } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    const cb = vi.fn();
    const unsubscribe = domain.onLocalModelInventoryUpdated(cb);

    expect(on).toHaveBeenCalledWith('models:local-model-inventory-updated', expect.any(Function));
    const handler = on.mock.calls[0][1] as (event: unknown, payload: { models: unknown[] }) => void;
    handler({}, { models: [] });
    expect(cb).toHaveBeenCalledWith({ models: [] });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('models:local-model-inventory-updated', handler);
  });
});

describe('providerDomain.onProviderRuntimeEvent', () => {
  it('registers a listener on PROVIDER_RUNTIME_EVENT and invokes callback with envelope', () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipcRenderer = { on, removeListener } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    const cb = vi.fn();
    const unsub = domain.onProviderRuntimeEvent(cb);
    expect(on).toHaveBeenCalledWith('provider:runtime-event', expect.any(Function));

    const handler = on.mock.calls[0][1] as (e: unknown, env: ProviderRuntimeEventEnvelope) => void;
    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      seq: 0,
      timestamp: Date.now(),
      provider: 'claude',
      instanceId: 'i',
      event: { kind: 'status', status: 'busy' },
    };
    handler({}, env);
    expect(cb).toHaveBeenCalledWith(env);

    unsub();
    expect(removeListener).toHaveBeenCalledWith('provider:runtime-event', handler);
  });
});
