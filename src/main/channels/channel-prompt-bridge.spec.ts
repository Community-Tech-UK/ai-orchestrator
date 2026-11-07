import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChannelPromptBridge } from './channel-prompt-bridge';
import type { ChannelManager } from './channel-manager';

function setup(watched = true) {
  const im = Object.assign(new EventEmitter(), {
    resumeAfterDeferredPermission: vi.fn(async (): Promise<void> => undefined), clearPendingInputRequiredPermission: vi.fn(),
    getOrchestrationHandler: () => Object.assign(new EventEmitter(), { respondToUserAction: vi.fn() }),
  });
  const adapter = { sendMessage: vi.fn(async () => ({ messageId: 'message-placeholder' })), editMessage: vi.fn(async () => undefined) };
  const cm = { getAdapter: () => adapter } as unknown as ChannelManager;
  const bridge = new ChannelPromptBridge({ getInstanceManager: () => im, getChannelManager: () => cm,
    getWatchingChats: () => watched ? [{ platform: 'discord', chatId: 'chat-placeholder', isDM: true }] : [] });
  bridge.start();
  const ask = (requestId: string) => im.emit('instance:input-required', { instanceId: 'instance-placeholder', requestId, prompt: 'Allow?', metadata: { type: 'deferred_permission', live: true } });
  return { bridge, im, ask, watch: () => { watched = true; bridge.onInstanceWatched('instance-placeholder'); } };
}
describe('channel live permission correlation', () => {
  it('forwards the exact card id and deny note with multiple asks outstanding', async () => {
    const { bridge, im, ask } = setup(); ask('one'); ask('two');
    expect(await bridge.resolveByRequestId('instance-placeholder', 'two', false, 'Use local files.')).toBe(true);
    expect(im.resumeAfterDeferredPermission).toHaveBeenCalledWith('instance-placeholder', false, undefined, { requestId: 'two', denyNote: 'Use local files.' });
    expect(bridge.hasPendingPrompt('instance-placeholder', 'one')).toBe(true); expect(bridge.hasPendingPrompt('instance-placeholder', 'two')).toBe(false);
    bridge.stop();
  });
  it('keeps failed dispatches retryable and refuses a duplicate decision in flight', async () => {
    const { bridge, im, ask } = setup(); ask('one');
    im.resumeAfterDeferredPermission.mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await bridge.resolveByRequestId('instance-placeholder', 'one', true)).toBe(false);
    expect(bridge.hasPendingPrompt('instance-placeholder', 'one')).toBe(true);
    let complete!: () => void;
    im.resumeAfterDeferredPermission.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const first = bridge.resolveByRequestId('instance-placeholder', 'one', true);
    expect(await bridge.resolveByRequestId('instance-placeholder', 'one', false)).toBe(false);
    complete(); expect(await first).toBe(true);
    bridge.stop();
  });
  it('removes only the cancelled or externally answered card while other asks remain waiting', async () => {
    const { bridge, im, ask } = setup(); ask('one'); ask('two');
    im.emit('instance:input-required-resolved', { instanceId: 'instance-placeholder', requestId: 'one', reason: 'cancelled' });
    expect(await bridge.resolveByRequestId('instance-placeholder', 'one', true)).toBe(false);
    expect(bridge.hasPendingPrompt('instance-placeholder', 'two')).toBe(true); bridge.stop();
  });
  it('does not deliver a buffered card after it was cancelled', () => {
    const { bridge, im, ask, watch } = setup(false); ask('one');
    im.emit('instance:input-required-resolved', { instanceId: 'instance-placeholder', requestId: 'one', reason: 'exited' });
    watch(); expect(bridge.hasPendingPrompt('instance-placeholder', 'one')).toBe(false); bridge.stop();
  });
});
