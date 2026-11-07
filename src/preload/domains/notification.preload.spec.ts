import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../generated/channels';
import { createNotificationDomain } from './notification.preload';

describe('notification preload domain', () => {
  it('sends only the count to the typed badge channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    const api = createNotificationDomain({ invoke } as unknown as IpcRenderer, IPC_CHANNELS);
    await expect(api.setAttentionBadge(3)).resolves.toEqual({ success: true });
    expect(invoke).toHaveBeenCalledWith('notification:set-badge', { count: 3 });
  });
  it('uses the typed mark-seen channel and owns the open-target listener cleanup', () => {
    let listener: (_event: IpcRendererEvent, target: { instanceId: string }) => void;
    const renderer = { invoke: vi.fn(), on: vi.fn((_channel: string, callback: typeof listener) => { listener = callback; }), removeListener: vi.fn() };
    const api = createNotificationDomain(renderer as unknown as IpcRenderer, IPC_CHANNELS);
    api.notificationMarkSeen({ ids: ['n'] });
    expect(renderer.invoke).toHaveBeenCalledWith('notification:mark-seen', { ids: ['n'] });
    const open = vi.fn(); const unsubscribe = api.onNotificationOpenTarget(open);
    listener!({} as IpcRendererEvent, { instanceId: 'a' });
    expect(open).toHaveBeenCalledWith({ instanceId: 'a' });
    unsubscribe(); expect(renderer.removeListener).toHaveBeenCalledWith('notification:open-target', listener!);
  });
});
