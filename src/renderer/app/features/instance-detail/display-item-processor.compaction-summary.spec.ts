import { describe, expect, it } from 'vitest';
import { DisplayItemProcessor } from './display-item-processor.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';

describe('DisplayItemProcessor compaction summary items', () => {
  it('projects compaction summaries as top-level items', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'm1',
        type: 'system',
        content: 'context compacted',
        timestamp: 20,
        metadata: {
          kind: 'compaction-summary',
          reason: 'context-budget',
          beforeCount: 120,
          afterCount: 35,
          fallbackMode: 'in-place',
          at: 20,
        },
      },
    ];

    const items = processor.process(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'compaction-summary',
      compactionSummary: {
        reason: 'context-budget',
        beforeCount: 120,
        afterCount: 35,
        fallbackMode: 'in-place',
        at: 20,
      },
    });
  });
});
