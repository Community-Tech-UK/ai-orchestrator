import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createDiagnosticsDomain } from './diagnostics.preload';
import { IPC_CHANNELS } from '../generated/channels';
describe('retrieved-context delivery subscription', () => {
  it('forwards only its dedicated event and removes the same listener on teardown', () => {
    const on = vi.fn(); const removeListener = vi.fn();
    const api = createDiagnosticsDomain({ on, removeListener } as unknown as IpcRenderer, IPC_CHANNELS);
    const callback = vi.fn(); const stop = api.onInputContextDelivered(callback);
    const [channel, listener] = on.mock.calls[0] as [string, (event: unknown, payload: unknown) => void];
    const delivery = { instanceId: 'session', messageId: 'user', deliveryId: 'delivery', tokens: null };
    expect(channel).toBe(IPC_CHANNELS.INSTANCE_INPUT_CONTEXT_DELIVERED);
    listener({}, delivery); expect(callback).toHaveBeenCalledWith(delivery);
    stop(); expect(removeListener).toHaveBeenCalledWith(channel, listener);
  });
});
