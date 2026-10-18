import { describe, expect, it } from 'vitest';
import { ClaudeCompactionObserver } from './claude-compaction-observer';

describe('Claude compaction observer', () => {
  it('counts only provider boundary messages and returns an isolated snapshot', () => {
    const observer = new ClaudeCompactionObserver();
    observer.observe({ type: 'system', subtype: 'info', content: 'compact_boundary mentioned in prose' });
    expect(observer.getTurnCompaction()).toEqual({ count: 0 });
    observer.observe({ type: 'system', subtype: 'compact_boundary' });
    observer.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 123 } });
    const snapshot = observer.getTurnCompaction();
    expect(snapshot).toEqual({ count: 2, trigger: 'manual', preTokens: 123 });
    observer.reset();
    expect(snapshot.count).toBe(2);
    expect(observer.getTurnCompaction()).toEqual({ count: 0 });
  });
  it.each([NaN, Infinity, -1])('ignores invalid token metadata without losing compaction evidence (%s)', (pre_tokens) => {
    const observer = new ClaudeCompactionObserver();
    observer.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens } });
    expect(observer.getTurnCompaction()).toEqual({ count: 1 });
  });
});
