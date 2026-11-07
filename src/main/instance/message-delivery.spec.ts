import { describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { withMessageDelivery, claimMessageDelivery, findMessageDeliveryTarget } from './message-delivery';
import { createInstanceInputReceipt } from './instance-adapter-input-dispatch';
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({
  recordUserSend: () => ({ admissionId: 'fixture-admission' }), markDelivered: vi.fn(), markFailed: vi.fn(),
}) }));

describe('message delivery receipts', () => {
  it('finds only the exact original user id, including a prompt retained during compaction', () => {
    const original: OutputMessage = { id: 'original-send', timestamp: 1, type: 'user', content: 'same request' };
    const other: OutputMessage = { ...original, id: 'other-send' };
    const instance = { outputBuffer: [other], retainedPrompts: [original] };
    expect(findMessageDeliveryTarget(instance, original.id)).toBe(original);
    expect(findMessageDeliveryTarget(instance, other.id)).toBe(other);
    expect(findMessageDeliveryTarget(instance, 'missing-send')).toBeUndefined();
    expect(findMessageDeliveryTarget(instance)).toBeUndefined();
  });

  it('uses the native admission receipt rather than treating a resolved send as proof', async () => {
    const message: OutputMessage = { id: 'native', timestamp: 1, type: 'user', content: 'fixture' };
    await withMessageDelivery('session', null, message, vi.fn(), async () => {
      const receipt = createInstanceInputReceipt('session', () => ({ message: 'fixture' }));
      receipt.record(); receipt.delivered();
    });
    expect(message.metadata?.['deliveryState']).toBe('accepted');
    const held: OutputMessage = { ...message, id: 'held', metadata: undefined };
    await withMessageDelivery('session', null, held, vi.fn(), async () => undefined);
    expect(held.metadata?.['deliveryState']).toBe('not-accepted');
  });
  it('binds concurrent identical messages by identity and keeps failures uncertain', async () => {
    const first: OutputMessage = { id: 'first', timestamp: 1, type: 'user', content: 'same text' };
    const second: OutputMessage = { ...first, id: 'second' };
    const publish = vi.fn();
    await Promise.allSettled([
      withMessageDelivery('first-session', null, first, publish, async () => { const receipt = claimMessageDelivery('first-session'); await Promise.resolve(); receipt?.('accepted'); }),
      withMessageDelivery('second-session', null, second, publish, async () => { claimMessageDelivery('second-session')?.('uncertain'); throw new Error('disconnected'); }),
    ]);
    expect(first.metadata?.['deliveryState']).toBe('accepted');
    expect(second.metadata?.['deliveryState']).toBe('uncertain');
  });
  it('marks an abandoned wait uncertain and accepts a later native receipt without replaying', async () => {
    vi.useFakeTimers();
    try {
      const message: OutputMessage = { id: 'slow', timestamp: 1, type: 'user', content: 'fixture' };
      let finish!: () => void;
      const sending = withMessageDelivery('session', 60000, message, vi.fn(), async () => {
        expect(claimMessageDelivery('other-session')).toBeUndefined();
        const notify = claimMessageDelivery('session');
        expect(claimMessageDelivery('session')).toBeUndefined();
        await new Promise<void>(resolve => { finish = resolve; });
        notify?.('accepted');
      });
      await vi.advanceTimersByTimeAsync(60000);
      expect(message.metadata?.['deliveryState']).toBe('uncertain');
      finish(); await sending;
      expect(message.metadata?.['deliveryState']).toBe('accepted');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
