import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';
import { deliverRunSummaryToChannel } from './automation-runner-helpers';

const delivery = vi.hoisted(() => ({ sent: [] as string[], sequence: [] as string[] }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({
  getAdapter: () => ({ sendMessage: async (_chatId: string, content: string) => {
    delivery.sequence.push('send'); delivery.sent.push(content); return { messageId: 'example' };
  } }), emitResponseSent: () => undefined,
}) }));
beforeEach(() => { delivery.sent.length = 0; delivery.sequence.length = 0; });
function run(notify: boolean): AutomationRun {
  return { id: 'example', status: 'succeeded', automationId: 'example-job', deliveryMode: 'notify',
    outputSummary: 'A completed check', triggerSource: { channel: 'discord:example' },
    result: { outcome: 'no_change', notify },
  } as unknown as AutomationRun;
}
describe('scheduled result delivery', () => {
  it('keeps a semantic quiet result local', async () => {
    const claim = vi.fn(() => true);
    await deliverRunSummaryToChannel(run(false), claim);
    expect(delivery.sent).toEqual([]);
    expect(claim).not.toHaveBeenCalled();
  });
  it('records delivery intent before sending and prevents a second delivery', async () => {
    let claimed = false;
    const claim = (): boolean => {
      if (claimed) return false;
      claimed = true; delivery.sequence.push('claim'); return true;
    };
    await deliverRunSummaryToChannel(run(true), claim);
    await deliverRunSummaryToChannel(run(true), claim);
    expect(delivery.sequence).toEqual(['claim', 'send']);
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0]).toContain('A completed check');
  });
});
