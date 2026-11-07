import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChannelPromptBridge, type PromptBridgeInstanceManager } from './channel-prompt-bridge';
import type { ChannelManager } from './channel-manager';
import type { BaseChannelAdapter } from './channel-adapter';
import type { InboundChannelMessage } from '../../shared/types/channels';

function setup(initiallyWatched: boolean) {
  const watched = new Set(initiallyWatched ? ['A', 'B'] : []);
  const im = Object.assign(new EventEmitter(), {
    resumeAfterDeferredPermission: vi.fn<PromptBridgeInstanceManager['resumeAfterDeferredPermission']>(async () => undefined),
    clearPendingInputRequiredPermission: vi.fn(),
    getOrchestrationHandler: () => Object.assign(new EventEmitter(), { respondToUserAction: vi.fn() }),
  });
  const adapter = { sendMessage: vi.fn(async () => ({ messageId: 'placeholder' })), editMessage: vi.fn(async () => undefined) };
  const bridge = new ChannelPromptBridge({ getInstanceManager: () => im,
    getChannelManager: () => ({ getAdapter: () => adapter }) as unknown as ChannelManager,
    getWatchingChats: id => watched.has(id) ? [{ platform: 'discord', chatId: id, isDM: true }] : [],
  });
  bridge.start();
  const ask = (id: string) => im.emit('instance:input-required', {
    instanceId: id, requestId: 'acp_permission:1', prompt: 'Allow ' + id + '?',
    metadata: { type: 'deferred_permission', live: true },
  });
  const reply = (id: string) => bridge.tryResolveTextReply({ platform: 'discord', chatId: id, content: 'yes' } as InboundChannelMessage, adapter as unknown as BaseChannelAdapter);
  return { bridge, im, adapter, ask, reply, watch: (id: string) => { watched.add(id); bridge.onInstanceWatched(id); } };
}

describe('channel prompt session ownership', () => {
  it.each(['cancelled', 'decided', 'exited'])('keeps B buffered when A is %s with the same RPC id', (reason) => {
    const { bridge, im, adapter, ask, watch } = setup(false);
    try {
      ask('A'); ask('B');
      im.emit('instance:input-required-resolved', { instanceId: 'A', requestId: 'acp_permission:1', reason });
      watch('B');
      expect(adapter.sendMessage).toHaveBeenCalledExactlyOnceWith('B', expect.stringContaining('Allow B?'), expect.anything());
    } finally { bridge.stop(); }
  });
  it('delivers and answers both sessions independently on the real event subscription', async () => {
    const { bridge, im, adapter, ask, reply } = setup(true);
    try {
      ask('A'); ask('B');
      expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
      expect(await reply('A')).toBe(true);
      expect(await reply('B')).toBe(true);
      expect(im.resumeAfterDeferredPermission.mock.calls.map(call => call[0])).toEqual(['A', 'B']);
      expect(im.clearPendingInputRequiredPermission.mock.calls).toEqual([['A', 'acp_permission:1'], ['B', 'acp_permission:1']]);
    } finally { bridge.stop(); }
  });
  it('keeps B dispatchable when A exits', async () => {
    const { bridge, im, ask, reply } = setup(true);
    try {
      ask('A'); ask('B');
      im.emit('instance:state-update', { instanceId: 'A', status: 'terminated' });
      expect(await reply('B')).toBe(true);
      expect(im.resumeAfterDeferredPermission).toHaveBeenCalledWith('B', true, undefined, { requestId: 'acp_permission:1', denyNote: undefined });
    } finally { bridge.stop(); }
  });
  it('keeps B answerable while A with the same RPC number is still dispatching', async () => {
    const { bridge, im, ask } = setup(true);
    let finish!: () => void;
    try {
      ask('A'); ask('B');
      im.resumeAfterDeferredPermission.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const a = bridge.resolveByRequestId('A', 'acp_permission:1', true);
      expect(await bridge.resolveByRequestId('B', 'acp_permission:1', false)).toBe(true);
      expect(bridge.hasPendingPrompt('A', 'acp_permission:1')).toBe(true);
      expect(bridge.hasPendingPrompt('B', 'acp_permission:1')).toBe(false);
      finish(); expect(await a).toBe(true);
    } finally { bridge.stop(); }
  });

});
