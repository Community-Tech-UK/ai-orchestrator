import { describe, expect, it } from 'vitest';
import { DisplayItemProcessor } from './display-item-processor.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';

describe('DisplayItemProcessor interrupt noise', () => {
  it('suppresses interrupt boundary markers from the transcript', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'm1',
        type: 'system',
        content: 'interrupt requested',
        timestamp: 10,
        metadata: {
          kind: 'interrupt-boundary',
          phase: 'requested',
          requestId: 'req-1',
          outcome: 'unresolved',
          at: 10,
        },
      },
    ];

    const items = processor.process(messages);

    expect(items).toEqual([]);
  });

  it('suppresses interruption wait notices from the transcript', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'm1',
        type: 'system',
        content: 'Interrupted — waiting for input',
        timestamp: 10,
        metadata: {
          interruptStatus: 'interrupted',
        },
      },
    ];

    const items = processor.process(messages);

    expect(items).toEqual([]);
  });

  it('hides Codex recovery boundary notices while keeping compaction and pause messages', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'boundary',
        type: 'system',
        content: 'Codex reached a shared context-policy boundary.',
        timestamp: 10,
        metadata: { contextCostRecovery: true, action: 'controlled-recovery' },
      },
      {
        id: 'compaction',
        type: 'system',
        content: 'Codex compacted the conversation to free context space.',
        timestamp: 20,
        metadata: { threadCompacted: true },
      },
      {
        id: 'paused',
        type: 'system',
        content: 'Codex context recovery paused.',
        timestamp: 30,
        metadata: { contextCostRecoveryPaused: true },
      },
    ];

    const items = processor.process(messages);

    expect(items.map((item) => item.message?.id)).toEqual(['compaction', 'paused']);
    expect(items.map((item) => item.bufferIndex)).toEqual([1, 2]);
  });

  it('still displays unrelated system messages', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'm1',
        type: 'system',
        content: 'Memory saved.',
        timestamp: 10,
      },
    ];

    const items = processor.process(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'message',
      message: {
        content: 'Memory saved.',
      },
    });
  });
});
