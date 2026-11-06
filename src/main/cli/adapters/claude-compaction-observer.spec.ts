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
  it('notifies subscribers after recording the boundary and allows explicit removal', () => {
    const observer = new ClaudeCompactionObserver();
    const snapshots: unknown[] = [];
    const unsubscribe = observer.onCompactionObserved(() => snapshots.push(observer.getTurnCompaction()));
    observer.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 47076, post_tokens: 10236 } });
    expect(snapshots).toEqual([{ count: 1, preTokens: 47076, postTokens: 10236 }]);
    unsubscribe();
    observer.observe({ type: 'system', subtype: 'compact_boundary' });
    expect(snapshots).toHaveLength(1);
  });
  it.each([NaN, Infinity, -1])('keeps invalid post-compaction occupancy unknown (%s)', post_tokens => {
    const observer = new ClaudeCompactionObserver();
    observer.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens } });
    expect(observer.getTurnCompaction()).toEqual({ count: 1 });
  });
});
