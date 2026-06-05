import { describe, it, expect, vi } from 'vitest';
import { BaseChannelAdapter } from './channel-adapter';
import type {
  ChannelPlatform,
  InboundChannelMessage,
  SentMessage,
} from '../../shared/types/channels';

/**
 * Minimal concrete adapter exposing the protected intake gate so we can test
 * idempotent inbound delivery + watermark (B6) without a live channel.
 */
class TestAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';

  connect = vi.fn(async (): Promise<void> => undefined);
  disconnect = vi.fn(async (): Promise<void> => undefined);
  sendMessage = vi.fn(
    async (chatId: string): Promise<SentMessage> => ({ messageId: 'm', chatId, timestamp: 0 }),
  );
  sendFile = vi.fn(
    async (chatId: string): Promise<SentMessage> => ({ messageId: 'f', chatId, timestamp: 0 }),
  );
  editMessage = vi.fn(async (): Promise<void> => undefined);
  addReaction = vi.fn(async (): Promise<void> => undefined);

  /** Public passthrough to the protected gate. */
  intake(msg: InboundChannelMessage): boolean {
    return this.emitInboundMessage(msg);
  }

  reset(chatId?: string): void {
    this.resetInboundWatermark(chatId);
  }
}

function makeMsg(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: 'internal-id',
    platform: 'discord',
    chatId: 'chat-1',
    messageId: 'mid-1',
    senderId: 'sender-1',
    senderName: 'Sender',
    content: 'hello',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: 1000,
    ...overrides,
  };
}

describe('BaseChannelAdapter — idempotent inbound intake (B6)', () => {
  it('emits a new message and reports acceptance', () => {
    const adapter = new TestAdapter();
    const listener = vi.fn();
    adapter.on('message', listener);

    const accepted = adapter.intake(makeMsg());

    expect(accepted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'mid-1' }));
  });

  it('suppresses a duplicate (same messageId) on the same chat — no second emit', () => {
    const adapter = new TestAdapter();
    const listener = vi.fn();
    adapter.on('message', listener);

    expect(adapter.intake(makeMsg({ messageId: 'dup' }))).toBe(true);
    expect(adapter.intake(makeMsg({ messageId: 'dup', id: 'different-internal-id' }))).toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats the same messageId on different chats as distinct (per-chat offsets)', () => {
    const adapter = new TestAdapter();
    const listener = vi.fn();
    adapter.on('message', listener);

    expect(adapter.intake(makeMsg({ chatId: 'a', messageId: 'shared' }))).toBe(true);
    expect(adapter.intake(makeMsg({ chatId: 'b', messageId: 'shared' }))).toBe(true);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('falls back to the internal id when messageId is empty', () => {
    const adapter = new TestAdapter();
    const listener = vi.fn();
    adapter.on('message', listener);

    expect(adapter.intake(makeMsg({ messageId: '', id: 'only-internal' }))).toBe(true);
    expect(adapter.intake(makeMsg({ messageId: '', id: 'only-internal' }))).toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('advances the watermark to the highest accepted timestamp', () => {
    const adapter = new TestAdapter();

    adapter.intake(makeMsg({ messageId: 'm1', timestamp: 1000 }));
    adapter.intake(makeMsg({ messageId: 'm2', timestamp: 3000 }));
    adapter.intake(makeMsg({ messageId: 'm3', timestamp: 2000 })); // out of order, still accepted

    const wm = adapter.getInboundWatermark('chat-1');
    expect(wm?.processedCount).toBe(3);
    expect(wm?.lastTimestamp).toBe(3000);
    expect(wm?.lastMessageId).toBe('m2');
    expect(wm?.recentIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns undefined watermark for an unseen chat and a defensive copy otherwise', () => {
    const adapter = new TestAdapter();
    expect(adapter.getInboundWatermark('never')).toBeUndefined();

    adapter.intake(makeMsg({ messageId: 'm1' }));
    const wm = adapter.getInboundWatermark('chat-1');
    wm?.recentIds.push('tampered');
    // Mutating the returned copy must not corrupt internal state.
    expect(adapter.getInboundWatermark('chat-1')?.recentIds).toEqual(['m1']);
  });

  it('bounds the per-chat dedup set (FIFO eviction) without unbounded growth', () => {
    const adapter = new TestAdapter();
    const total = 300; // > INBOUND_DEDUP_PER_CHAT (256)
    for (let i = 0; i < total; i++) {
      expect(adapter.intake(makeMsg({ messageId: `m${i}`, timestamp: 1000 + i }))).toBe(true);
    }
    const wm = adapter.getInboundWatermark('chat-1');
    expect(wm?.recentIds.length).toBe(256);
    expect(wm?.processedCount).toBe(total);
    // The oldest id was evicted, so a replay of it is NO LONGER deduped (accepted again).
    expect(adapter.intake(makeMsg({ messageId: 'm0', timestamp: 1000 }))).toBe(true);
    // A recent id is still deduped.
    expect(adapter.intake(makeMsg({ messageId: 'm299', timestamp: 1299 }))).toBe(false);
  });

  it('resets intake state on demand so a deliberate replay is re-accepted', () => {
    const adapter = new TestAdapter();
    expect(adapter.intake(makeMsg({ messageId: 'm1' }))).toBe(true);
    expect(adapter.intake(makeMsg({ messageId: 'm1' }))).toBe(false);

    adapter.reset('chat-1');
    expect(adapter.intake(makeMsg({ messageId: 'm1' }))).toBe(true);
    expect(adapter.getInboundWatermark('chat-1')?.processedCount).toBe(1);
  });
});
