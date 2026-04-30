import { describe, expect, it } from 'vitest';
import { MessageFormatService } from './message-format.service';

describe('MessageFormatService', () => {
  const service = new MessageFormatService();

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
