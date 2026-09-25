import { describe, expect, it } from 'vitest';

import { CodexCompactionSignalTracker } from './compaction-signals';

const item = { type: 'contextCompaction', id: 'compaction-item' };

describe('CodexCompactionSignalTracker', () => {
  // Captured live from codex-cli 0.156.1 after `thread/compact/start`.
  it('reads the contextCompaction item lifecycle current Codex builds send', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn', item };

    expect(tracker.accept({ method: 'item/started', params }, 'thread-1')).toBe('started');
    expect(tracker.accept({ method: 'item/completed', params }, 'thread-1')).toBe('observed-running');
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } },
    }, 'thread-1')).toBe('settled');
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

  it('deduplicates a legacy completion without a turn id after an item completion', () => {
    const tracker = new CodexCompactionSignalTracker();

    expect(tracker.accept({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'compact-turn', item },
    }, 'thread-1')).toBe('completed');
    expect(tracker.accept({
      method: 'thread/compacted',
      params: { threadId: 'thread-1' },
    }, 'thread-1')).toBeNull();
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
    expect(tracker.accept({ method: 'item/completed', params }, 'thread-1')).toBe('observed-running');
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } },
    }, 'thread-1')).toBe('settled');
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

  it('tracks a provider compaction inferred from a rejected send until its turn settles', () => {
    const tracker = new CodexCompactionSignalTracker();

    tracker.markRunningFromRejection('compact-turn');

    expect(tracker.isRunning).toBe(true);
    expect(tracker.runningTurnId).toBe('compact-turn');
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } },
    }, 'thread-1')).toBe('settled');
    expect(tracker.isRunning).toBe(false);
  });

  it('settles an inferred compaction without a known turn id on the next completed turn', () => {
    const tracker = new CodexCompactionSignalTracker();

    tracker.markRunningFromRejection(null);

    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'provider-compact-turn', status: 'completed' } },
    }, 'thread-1')).toBe('settled');
    expect(tracker.isRunning).toBe(false);
  });

  it('keeps an inferred compaction gated through item completion until its turn completes', () => {
    const tracker = new CodexCompactionSignalTracker();
    const params = { threadId: 'thread-1', turnId: 'compact-turn', item };

    tracker.markRunningFromRejection(null);

    expect(tracker.accept({ method: 'item/started', params }, 'thread-1')).toBeNull();
    expect(tracker.runningTurnId).toBe('compact-turn');
    expect(tracker.accept({ method: 'item/completed', params }, 'thread-1')).toBe('observed-running');
    expect(tracker.isRunning).toBe(true);
    expect(tracker.accept({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } },
    }, 'thread-1')).toBe('settled');
    expect(tracker.isRunning).toBe(false);
  });
});
