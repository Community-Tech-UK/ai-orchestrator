import { describe, expect, it } from 'vitest';
import { drainFollowUpsForCompletion, partitionPendingByDrainTiming } from './loop-coordinator-block-utils';
import { createLoopPendingInput } from '../../shared/types/loop.types';

const followUp = (message: string, drainMode?: 'all' | 'one-at-a-time') =>
  createLoopPendingInput(message, { kind: 'follow-up', source: 'human', ...(drainMode ? { drainMode } : {}) });

describe('drainFollowUpsForCompletion (Task 18 drainMode)', () => {
  it('returns null when there are no follow-ups', () => {
    expect(drainFollowUpsForCompletion([createLoopPendingInput('hi', { kind: 'queue' })])).toBeNull();
  });

  it('drains the whole batch at once with the default (all) mode', () => {
    const result = drainFollowUpsForCompletion([followUp('a'), followUp('b')])!;
    expect(result.followUpCount).toBe(2);
    expect(result.remainingFollowUps).toBe(0);
    // Both re-queued as next-iteration hints, none left as follow-up.
    expect(result.requeued.map((i) => i.kind)).toEqual(['queue', 'queue']);
  });

  it('drains a single message per seam when the first follow-up is one-at-a-time', () => {
    const result = drainFollowUpsForCompletion([followUp('first', 'one-at-a-time'), followUp('second'), followUp('third')])!;
    expect(result.followUpCount).toBe(1);
    expect(result.remainingFollowUps).toBe(2);
    // The drained one becomes a queue hint; the rest stay as follow-ups.
    const kinds = result.requeued.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'queue')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'follow-up')).toHaveLength(2);
    expect(result.requeued.find((i) => i.kind === 'queue')?.message).toBe('first');
  });

  it('drains preceding all-mode messages up to and including the first one-at-a-time', () => {
    const result = drainFollowUpsForCompletion([followUp('a'), followUp('b', 'one-at-a-time'), followUp('c')])!;
    expect(result.followUpCount).toBe(2); // a + b
    expect(result.remainingFollowUps).toBe(1); // c deferred
  });

  it('preserves non-follow-up interventions in place', () => {
    const result = drainFollowUpsForCompletion([
      createLoopPendingInput('steer-hint', { kind: 'queue' }),
      followUp('later'),
    ])!;
    expect(result.requeued[0].message).toBe('steer-hint');
    expect(result.requeued[0].kind).toBe('queue');
  });
});

describe('partitionPendingByDrainTiming', () => {
  it('holds back follow-ups from prompt-build and drains queue/steer now', () => {
    const { drainNow, deferredFollowUps } = partitionPendingByDrainTiming([
      createLoopPendingInput('now', { kind: 'queue' }),
      followUp('later'),
    ]);
    expect(drainNow.map((i) => i.message)).toEqual(['now']);
    expect(deferredFollowUps.map((i) => i.message)).toEqual(['later']);
  });
});
