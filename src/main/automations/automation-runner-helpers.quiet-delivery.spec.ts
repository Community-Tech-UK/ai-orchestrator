/**
 * 8c — a quiet run ("nothing to report") must not post to the chat channel
 * that triggered it. Guards the `outcome === 'quiet'` early return in
 * `deliverRunSummaryToChannel`. The control case proves the same run with a
 * different outcome does deliver, so the quiet assertion cannot pass vacuously.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
}));

const channel = vi.hoisted(() => {
  const sendMessage = vi.fn(async (_chatId: string, _content: string, _options?: unknown) => ({ messageId: 'sent-1' }));
  const getAdapter = vi.fn(() => ({ sendMessage }));
  const emitResponseSent = vi.fn();
  return { sendMessage, getAdapter, emitResponseSent };
});

vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({
    getAdapter: channel.getAdapter,
    emitResponseSent: channel.emitResponseSent,
  }),
}));

import { deliverRunSummaryToChannel } from './automation-runner-helpers';

function channelRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-R6N3',
    automationId: 'auto-R6N3',
    status: 'succeeded',
    deliveryMode: 'notify',
    outputSummary: 'Nothing new.',
    instanceId: null,
    triggerSource: { type: 'channel', channel: 'discord:chat-42' },
    configSnapshot: { name: 'Inbox watcher' },
    ...overrides,
  } as unknown as AutomationRun;
}

describe('deliverRunSummaryToChannel quiet runs (R6N3)', () => {
  beforeEach(() => {
    channel.sendMessage.mockClear();
    channel.getAdapter.mockClear();
    channel.emitResponseSent.mockClear();
  });

  it('control: a non-quiet run is delivered to the triggering channel', async () => {
    await deliverRunSummaryToChannel(channelRun({ outcome: 'changed' }), () => true);

    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage.mock.calls[0]?.[0]).toBe('chat-42');
    expect(channel.emitResponseSent).toHaveBeenCalledTimes(1);
  });

  it('a quiet run is not delivered and does not even look up the adapter', async () => {
    await deliverRunSummaryToChannel(channelRun({ outcome: 'quiet' }), () => true);

    expect(channel.getAdapter).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.emitResponseSent).not.toHaveBeenCalled();
  });
});
