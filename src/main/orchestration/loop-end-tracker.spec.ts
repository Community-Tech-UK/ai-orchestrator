import { describe, expect, it } from 'vitest';
import { createLoopEndTracker } from './loop-end-tracker';

describe('createLoopEndTracker', () => {
  it('reports an end only to watches taken before it, and only for that loop', () => {
    const tracker = createLoopEndTracker();
    const before = tracker.watch('a');
    const other = tracker.watch('b');
    expect(before()).toBe(false);
    tracker.end('a');
    expect(before()).toBe(true);
    expect(other()).toBe(false);
    expect(tracker.watch('a')()).toBe(false);
  });
});
