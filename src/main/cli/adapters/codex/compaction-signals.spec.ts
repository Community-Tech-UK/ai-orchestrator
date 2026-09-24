import { describe, expect, it } from 'vitest';

import { CodexCompactionSignalTracker } from './compaction-signals';

const item = { type: 'contextCompaction', id: 'compaction-item' };

describe('CodexCompactionSignalTracker', () => {
  // Captured live from codex-cli 0.156.1 after `thread/compact/start`.
  it('reads the contextCompaction item lifecycle current Codex builds send', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn', item };

    expect(tracker.accept({ method: 'item/started', params }, 'thread-1')).toBe('started');
    expect(tracker.accept({ method: 'item/completed', params }, 'thread-1')).toBe('completed');
  });

  it('still accepts the legacy thread/compacted notification', () => {
    const tracker = new CodexCompactionSignalTracker();

    expect(tracker.accept({ method: 'thread/compacted', params: { threadId: 'thread-1' } }, 'thread-1'))
      .toBe('completed');
  });

  it('counts one compaction once when a build sends both completion forms', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn' };

    expect(tracker.accept({ method: 'item/completed', params: { ...params, item } }, 'thread-1')).toBe('completed');
    expect(tracker.accept({ method: 'thread/compacted', params }, 'thread-1')).toBeNull();
    expect(tracker.accept({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'next-compact-turn', item },
    }, 'thread-1')).toBe('completed');
  });

  it('ignores other threads, other items, and an unbound adapter', () => {
    const tracker = new CodexCompactionSignalTracker();

    expect(tracker.accept({
      method: 'item/completed',
      params: { threadId: 'child-thread', turnId: 't', item },
    }, 'thread-1')).toBeNull();
    expect(tracker.accept({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 't', item: { type: 'agentMessage', id: 'a' } },
    }, 'thread-1')).toBeNull();
    expect(tracker.accept({ method: 'turn/completed', params: { threadId: 'thread-1' } }, 'thread-1')).toBeNull();
    expect(tracker.accept({ method: 'thread/compacted', params: { threadId: 'thread-1' } }, null)).toBeNull();
  });

  it('reports a compaction whose turn ended without completing it as aborted', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn', item };

    expect(tracker.accept({ method: 'item/started', params }, 'thread-1')).toBe('started');
    expect(tracker.runningTurnId).toBe('compact-turn');
    // Another turn ending on the thread says nothing about this compaction.
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'other-turn', status: 'completed' } },
    }, 'thread-1')).toBeNull();
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'failed' } },
    }, 'thread-1')).toBe('aborted');
    expect(tracker.runningTurnId).toBeNull();
  });

  it('does not report aborted for the turn that completed its compaction', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn', item };

    tracker.accept({ method: 'item/started', params }, 'thread-1');
    expect(tracker.accept({ method: 'item/completed', params }, 'thread-1')).toBe('completed');
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } },
    }, 'thread-1')).toBeNull();
  });

  it('forgets a running compaction on reset', () => {
    const tracker = new CodexCompactionSignalTracker();
    tracker.accept({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'compact-turn', item } }, 'thread-1');

    tracker.reset();

    expect(tracker.runningTurnId).toBeNull();
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'interrupted' } },
    }, 'thread-1')).toBeNull();
  });
});
