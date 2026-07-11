import { describe, expect, it } from 'vitest';
import { MessageFormatService } from './message-format.service';
import type { DisplayItem } from './display-item-processor.service';

describe('MessageFormatService', () => {
  const service = new MessageFormatService();

  describe('summarizeCycle', () => {
    it('counts thinking blocks, not thought-groups', () => {
      const cycle: DisplayItem = {
        id: 'cycle-1',
        type: 'work-cycle',
        children: [
          {
            id: 'thought-t1',
            type: 'thought-group',
            thinking: [
              { id: 'a', content: 'one', format: 'structured' },
              { id: 'b', content: 'two', format: 'structured' },
              { id: 'c', content: 'three', format: 'structured' },
            ],
            thoughts: ['one', 'two', 'three'],
          },
        ],
      };
      expect(service.summarizeCycle(cycle)).toBe('3 thoughts');
    });

    it('uses singular for a single thinking block', () => {
      const cycle: DisplayItem = {
        id: 'cycle-1',
        type: 'work-cycle',
        children: [
          {
            id: 'thought-t1',
            type: 'thought-group',
            thinking: [{ id: 'a', content: 'one', format: 'structured' }],
            thoughts: ['one'],
          },
        ],
      };
      expect(service.summarizeCycle(cycle)).toBe('1 thought');
    });
  });

  it('formats compaction reasons for transcript cards', () => {
    expect(service.formatCompactionReason('hard_limit')).toBe('history threshold');
    expect(service.formatCompactionReason('background_threshold')).toBe('context budget');
    expect(service.formatCompactionReason('context-budget')).toBe('context budget');
    expect(service.formatCompactionReason('manual_reason')).toBe('manual reason');
  });

  it('formats compaction fallback modes for transcript cards', () => {
    expect(service.formatCompactionFallbackMode('in-place')).toBe('in place');
    expect(service.formatCompactionFallbackMode('native-resume')).toBe('native resume');
  });
});
