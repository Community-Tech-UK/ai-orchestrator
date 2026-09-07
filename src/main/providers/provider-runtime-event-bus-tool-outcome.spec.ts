/**
 * LT-196 round-3 regression: the `tool_outcome` record must never reach the
 * provider runtime event bus.
 *
 * Three review rounds each found a different live subscriber copying its raw
 * tool-failure text somewhere it did not belong — the mobile broadcast and the
 * persisted session-continuity document (round 2), then the observation
 * ingestor (which embeds into the vector store and renders on the Observations
 * page) and the plugin host, which hands untruncated content to arbitrary
 * third-party code (round 3). Guarding each subscriber was losing a race
 * against the next one, so the record is stopped at the single point every
 * subscriber is fed.
 *
 * The record still reaches the correction miner: it is archived via
 * `instance.outputBuffer`, which is populated independently of this bus.
 */

import { describe, expect, it, vi } from 'vitest';
import { ProviderRuntimeEventBus } from './provider-runtime-event-bus';

const ERROR_TEXT = 'grep: unrecognized option --bogus-flag, aborting run';

function outputEnvelope(messageType: string) {
  return {
    instanceId: 'inst-1',
    provider: 'claude',
    sessionId: 'sess-1',
    timestamp: Date.now(),
    event: {
      kind: 'output',
      messageId: `m-${messageType}`,
      messageType,
      content: ERROR_TEXT,
      metadata: { tool_use_id: 'toolu_1', is_error: true },
    },
  } as unknown as Parameters<ProviderRuntimeEventBus['enqueue']>[0];
}

describe('ProviderRuntimeEventBus — LT-196 tool_outcome is never broadcast', () => {
  it('drops a tool_outcome output event', () => {
    const emit = vi.fn();
    const bus = new ProviderRuntimeEventBus(emit);

    bus.enqueue(outputEnvelope('tool_outcome'));

    expect(emit).not.toHaveBeenCalled();
  });

  it('still broadcasts ordinary output events', () => {
    const emit = vi.fn();
    const bus = new ProviderRuntimeEventBus(emit);

    bus.enqueue(outputEnvelope('assistant'));
    bus.enqueue(outputEnvelope('tool_result'));

    expect(emit).toHaveBeenCalled();
    const broadcastTypes = emit.mock.calls.map(
      ([envelope]) => (envelope as { event: { messageType?: string } }).event.messageType,
    );
    expect(broadcastTypes).toContain('assistant');
    expect(broadcastTypes).toContain('tool_result');
    expect(broadcastTypes).not.toContain('tool_outcome');
  });
});
