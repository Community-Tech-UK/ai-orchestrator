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

  // U10: this used to assert the notice was hidden because of its exact wording.
  // Wording no longer decides anything: the emit site flags the notice routine and
  // the processor folds it into an "N system events" row (see
  // display-item-processor.routine-notices.spec.ts); an unflagged copy is shown.
  it('no longer hides an interruption wait notice by its wording', () => {
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

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'message', message: { content: 'Interrupted — waiting for input' } });
  });

  it('folds the same notice, rather than hiding it, once its emit site flags it routine', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'm1',
        type: 'system',
        content: 'Interrupted — waiting for input',
        timestamp: 10,
        metadata: {
          audience: 'routine',
          interruptStatus: 'interrupted',
        },
      },
    ];

    const items = processor.process(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'system-event-group', groupLabel: '1 system event' });
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
