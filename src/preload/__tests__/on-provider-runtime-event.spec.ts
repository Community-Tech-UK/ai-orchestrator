import { describe, it, expect, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createProviderDomain } from '../domains/provider.preload';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { IPC_CHANNELS } from '../generated/channels';

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
