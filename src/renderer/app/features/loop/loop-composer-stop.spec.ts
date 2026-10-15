import { describe, expect, it, vi } from 'vitest';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { ChatDetailComponent } from '../chats/chat-detail.component';

describe('composer loop stop routes', () => {
  it('asks before stopping from the instance composer', async () => {
    const cancel = vi.fn(); const request = vi.fn();
    const context = { store: { selectedInstance: () => ({ id: 'chat' }) }, loopStore: { activeForChat: () => () => ({ id: 'loop', chatId: 'chat', config: { isolateLoopWorkspaces: true } }), cancel }, loopStopConfirm: { request } };
    await InstanceDetailComponent.prototype.onLoopStopRequested.call(context as unknown as InstanceDetailComponent);
    expect(cancel).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledWith('loop', true, { chatId: 'chat' });
  });
  it('asks before stopping from the chat composer', async () => {
    const cancel = vi.fn(); const request = vi.fn();
    const context = { detail: () => ({ chat: { id: 'chat' } }), loopStore: { activeForChat: () => () => ({ id: 'loop', chatId: 'chat', config: { isolateLoopWorkspaces: false } }), cancel }, loopStopConfirm: { request } };
    await ChatDetailComponent.prototype.onLoopStopRequested.call(context as unknown as ChatDetailComponent);
    expect(cancel).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledWith('loop', false, { chatId: 'chat' });
  });
});
