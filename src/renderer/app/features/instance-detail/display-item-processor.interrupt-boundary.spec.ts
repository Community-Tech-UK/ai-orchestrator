import { describe, expect, it } from 'vitest';
import { DisplayItemProcessor } from './display-item-processor.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';

describe('DisplayItemProcessor interrupt boundary items', () => {
  it('projects interrupt boundary markers as top-level items', () => {
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

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'interrupt-boundary',
      interruptBoundary: {
        phase: 'requested',
        requestId: 'req-1',
        outcome: 'unresolved',
        at: 10,
      },
    });
  });
});
