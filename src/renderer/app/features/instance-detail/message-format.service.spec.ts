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

  it('renders a legacy Compact-turn rejection as a compaction notice instead of an error card', () => {
    const message = {
      id: 'legacy-compact-error',
      type: 'error' as const,
      timestamp: 1,
      content: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
    };

    expect(service.isCompactionBoundary(message)).toBe(true);
    expect(service.getCompactionLabel(message)).toBe('Codex is compacting its context…');
  });

  it('labels a self-managed boundary truthfully while fresh usage is pending', () => {
    const message = {
      id: 'self-managed',
      type: 'system' as const,
      timestamp: 1,
      content: 'Codex compacted the conversation.',
      metadata: { threadCompacted: true, method: 'self-managed' },
    };

    expect(service.getCompactionLabel(message)).toBe(
      'Codex compacted its own context (awaiting updated usage)',
    );
  });
});
