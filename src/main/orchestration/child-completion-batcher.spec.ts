import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHILD_BATCH_MAX_HOLD_MS,
  CHILD_BATCH_SPAWN_WINDOW_MS,
  ChildCompletionBatcher,
  type ChildCompletionResultData,
} from './child-completion-batcher';

const result: ChildCompletionResultData = {
  name: 'Helper',
  summary: 'Done.',
  success: true,
  conclusions: [],
};

describe('ChildCompletionBatcher', () => {
  let released: Array<{ parentId: string; childId: string; resultData?: ChildCompletionResultData }>;
  let batcher: ChildCompletionBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    released = [];
    batcher = new ChildCompletionBatcher((parentId, childId, resultData) => {
      released.push({ parentId, childId, resultData });
    });
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  describe('spawn window', () => {
    it('joins children spawned within the window into one burst', () => {
      const now = 1_000;
      batcher.noteSpawn('p', 'a', now);
      batcher.noteSpawn('p', 'b', now + 1_000);
      batcher.noteSpawn('p', 'c', now + 1_000 + CHILD_BATCH_SPAWN_WINDOW_MS + 1);

      // a and b share a burst: finishing a waits for b.
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      // c opened a new burst and is its only member: today's behaviour.
      expect(batcher.decide('p', 'c', { success: true })).toBe('send-now');
      expect(batcher.decide('p', 'b', { success: true })).toBe('final');
    });

    it('children spawned 5 minutes apart are in different bursts', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 5 * 60_000);

      expect(batcher.decide('p', 'a', { success: true })).toBe('send-now');
      expect(batcher.decide('p', 'b', { success: true })).toBe('send-now');
    });
  });

  describe('decisions', () => {
    it('holds a success while another burst-mate is running and ends with final', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);

      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      expect(batcher.decide('p', 'b', { success: true })).toBe('final');
    });

    it('sends a failure at once and releases held burst-mates', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);

      expect(batcher.decide('p', 'b', { success: false })).toBe('send-now');
      expect(released).toEqual([{ parentId: 'p', childId: 'a', resultData: result }]);
    });

    it('decides from burst membership, not from any remaining-children count', () => {
      // Older unrelated child x still running; burst y+z finishes anyway.
      batcher.noteSpawn('p', 'x', 0);
      batcher.noteSpawn('p', 'y', 10 * 60_000);
      batcher.noteSpawn('p', 'z', 10 * 60_000 + 1_000);

      expect(batcher.decide('p', 'y', { success: true })).toBe('hold');
      expect(batcher.decide('p', 'z', { success: true })).toBe('final');
    });

    it('a child outside any burst is sent now', () => {
      expect(batcher.decide('p', 'unknown-child', { success: true })).toBe('send-now');
    });
  });

  describe('hold timer', () => {
    it('releases held results one by one after the maximum hold', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);
      batcher.noteSpawn('p', 'c', 200);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);
      expect(batcher.decide('p', 'b', { success: true })).toBe('hold');
      batcher.hold('p', 'b', { ...result, name: 'Second' });
      // c hangs: a and b stay held until the maximum hold.

      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS - 1);
      expect(released).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(released.map((r) => r.childId)).toEqual(['a', 'b']);
    });

    it('clears the timer when the batch completes', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);
      expect(batcher.decide('p', 'b', { success: true })).toBe('final');

      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      expect(released).toHaveLength(0);
    });

    it('dispose() clears pending timers', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);

      batcher.dispose();
      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      expect(released).toHaveLength(0);
    });
  });

  describe('reported bookkeeping', () => {
    it('takeUnreported returns only unseen children and marks them', () => {
      expect(batcher.takeUnreported('p', ['a', 'b'])).toEqual(['a', 'b']);
      expect(batcher.takeUnreported('p', ['a', 'b', 'c'])).toEqual(['c']);
    });

    it('markReported drops a held copy so the timer never re-delivers it', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'b', 100);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);
      batcher.markReported('p', 'a');

      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      expect(released).toHaveLength(0);
    });
  });

  describe('lifecycle cleanup', () => {
    it('expires burst membership after delivering timed-out results, preserving live-parent dedup', () => {
      batcher.noteSpawn('p', 'a', 0);
      batcher.noteSpawn('p', 'hung', 1);
      expect(batcher.decide('p', 'a', { success: true })).toBe('hold');
      batcher.hold('p', 'a', result);
      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      expect(released.map((entry) => entry.childId)).toEqual(['a']);
      batcher.markReported('p', 'a');
      // Expired membership cannot keep a late completion in the old burst.
      expect(batcher.decide('p', 'hung', { success: true })).toBe('send-now');
      batcher.noteSpawn('p', 'new', CHILD_BATCH_MAX_HOLD_MS + 1);
      expect(batcher.takeUnreported('p', ['a', 'hung', 'new'])).toEqual(['hung', 'new']);
      const state = Reflect.get(batcher, 'parents').get('p');
      expect(state.bursts.size).toBe(1);
      expect(state.openBurst.members).toEqual(new Set(['new']));
    });

    it('releases each removed parent and cancels its pending wake without dropping another parent', () => {
      batcher.noteSpawn('other', 'running', 0);
      for (let index = 0; index < 100; index++) {
        const parent = `parent-${index}`;
        batcher.noteSpawn(parent, 'a', 0);
        batcher.hold(parent, 'a', result);
        batcher.takeUnreported(parent, ['finished']);
        batcher.removeParent(parent);
      }
      expect(Reflect.get(batcher, 'parents').size).toBe(1);
      vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      expect(released).toEqual([]);
      expect(batcher.decide('other', 'running', { success: true })).toBe('send-now');
    });

    it('retains reported IDs while a live parent starts its next wave', () => {
      batcher.noteSpawn('p', 'first', 0);
      expect(batcher.takeUnreported('p', ['first'])).toEqual(['first']);
      batcher.noteParentSettled('p');
      batcher.noteSpawn('p', 'second', 60_000);
      expect(batcher.takeUnreported('p', ['first', 'second'])).toEqual(['second']);
    });

    it('cannot recreate state through any allocating entry after disposal', () => {
      batcher.dispose();
      batcher.noteSpawn('p', 'a');
      batcher.hold('p', 'a', result);
      expect(batcher.takeUnreported('p', ['a'])).toEqual([]);
      expect(Reflect.get(batcher, 'parents').size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['timeout', 'failure'] as const)('stops a %s release list if a delivery removes its parent', (trigger) => {
      const delivered: string[] = [];
      const reentrant = new ChildCompletionBatcher((parent, child) => {
        delivered.push(child);
        reentrant.removeParent(parent);
      });
      reentrant.noteSpawn('p', 'a', 0);
      reentrant.noteSpawn('p', 'b', 1);
      reentrant.noteSpawn('p', 'c', 2);
      reentrant.hold('p', 'a', result);
      reentrant.hold('p', 'b', result);
      if (trigger === 'timeout') vi.advanceTimersByTime(CHILD_BATCH_MAX_HOLD_MS);
      else reentrant.decide('p', 'c', { success: false });
      expect(delivered).toEqual(['a']);
      expect(Reflect.get(reentrant, 'parents').size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      reentrant.dispose();
    });
  });

});
