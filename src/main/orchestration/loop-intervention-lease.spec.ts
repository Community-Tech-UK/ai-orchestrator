import { describe, expect, it } from 'vitest';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import {
  ackLeasedInterventions,
  boundInterventionQueue,
  leaseInterventionsForIteration,
  LEASE_STALE_MS,
  MAX_MERGED_STEERING_CHARS,
  releaseStaleLeases,
  renderSealNote,
  type LeasedLoopPendingInput,
} from './loop-intervention-lease';

const hint = (message: string) => createLoopPendingInput(message, { kind: 'queue' });
const followUp = (message: string) => createLoopPendingInput(message, { kind: 'follow-up' });

describe('leaseInterventionsForIteration (L8)', () => {
  it('leases eligible payloads and keeps them on the queue until acked', () => {
    const pending = [hint('fix the spec'), followUp('later')];
    const result = leaseInterventionsForIteration({ pending, seq: 3, now: 1_000 });

    expect(result.leased.map((i) => i.message)).toEqual(['fix the spec']);
    expect(result.queue).toHaveLength(2);
    expect(result.queue[0]).toMatchObject({ leaseSeq: 3, leasedAt: 1_000 });
    expect(result.queue[1]?.leaseSeq).toBeUndefined();
  });

  it('seals the batch at the merged steering budget and keeps the rest queued', () => {
    const big = 'x'.repeat(MAX_MERGED_STEERING_CHARS - 50);
    const pending = [hint(big), hint('second'), hint('third')];
    const result = leaseInterventionsForIteration({ pending, seq: 1 });

    expect(result.leased).toHaveLength(1);
    expect(result.sealed.map((i) => i.message)).toEqual(['second', 'third']);
    expect(result.queue).toHaveLength(3);
    expect(result.sealed.every((i) => i.leaseSeq === undefined)).toBe(true);
  });

  it('always delivers the first payload even when it alone exceeds the budget', () => {
    const enormous = 'y'.repeat(MAX_MERGED_STEERING_CHARS * 2);
    const result = leaseInterventionsForIteration({ pending: [hint(enormous)], seq: 1 });

    expect(result.leased).toHaveLength(1);
    expect(result.sealed).toHaveLength(0);
  });

  it('never carries a stale lease on a held follow-up', () => {
    const stale: LeasedLoopPendingInput = { ...followUp('later'), leaseSeq: 1, leasedAt: 5 };
    const result = leaseInterventionsForIteration({ pending: [stale], seq: 2 });

    expect(result.queue[0]?.leaseSeq).toBeUndefined();
  });

  it('reports the seal in copy the child can act on', () => {
    expect(renderSealNote(0)).toBe('');
    expect(renderSealNote(1)).toContain('1 further queued message');
    expect(renderSealNote(3)).toContain('3 further queued messages');
    expect(renderSealNote(2)).toContain('do not treat this list as complete');
  });
});

describe('ackLeasedInterventions (L8)', () => {
  it('drops only the payloads leased to that iteration', () => {
    const queue: LeasedLoopPendingInput[] = [
      { ...hint('delivered'), leaseSeq: 4, leasedAt: 1 },
      { ...hint('queued during the turn') },
      { ...hint('other turn'), leaseSeq: 5, leasedAt: 1 },
    ];

    const after = ackLeasedInterventions(queue, 4);

    expect(after.map((i) => i.message)).toEqual(['queued during the turn', 'other turn']);
  });
});

describe('releaseStaleLeases (L8)', () => {
  it('re-queues a lease held by an earlier iteration that never acked', () => {
    const queue: LeasedLoopPendingInput[] = [{ ...hint('lost steer'), leaseSeq: 2, leasedAt: 10 }];
    const { queue: after, released } = releaseStaleLeases(queue, { beforeSeq: 3, now: 20 });

    expect(released).toBe(1);
    expect(after[0]?.leaseSeq).toBeUndefined();
    expect(after[0]?.message).toBe('lost steer');
  });

  it('leaves the current iteration lease alone', () => {
    const queue: LeasedLoopPendingInput[] = [{ ...hint('in flight'), leaseSeq: 3, leasedAt: 10 }];
    const { queue: after, released } = releaseStaleLeases(queue, { beforeSeq: 3, now: 20 });

    expect(released).toBe(0);
    expect(after[0]?.leaseSeq).toBe(3);
  });

  // A restart resets the iteration counter, so an old lease can collide with a
  // fresh sequence number. Age is the backstop.
  it('re-queues a lease older than the stale window whatever its sequence', () => {
    const queue: LeasedLoopPendingInput[] = [{ ...hint('from a previous boot'), leaseSeq: 3, leasedAt: 0 }];
    const { released } = releaseStaleLeases(queue, { beforeSeq: 3, now: LEASE_STALE_MS + 1 });

    expect(released).toBe(1);
  });

  it('releases everything when no selector is given', () => {
    const queue: LeasedLoopPendingInput[] = [
      { ...hint('a'), leaseSeq: 1, leasedAt: 10 },
      { ...hint('b'), leaseSeq: 9, leasedAt: 10 },
    ];
    const { released } = releaseStaleLeases(queue, { now: 20 });

    expect(released).toBe(2);
  });
});

describe('boundInterventionQueue (L8)', () => {
  it('leaves a queue under the ceiling untouched', () => {
    const { queue, dropped } = boundInterventionQueue([hint('a'), hint('b')], 5);
    expect(queue).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('drops the oldest entries past the ceiling and reports them', () => {
    const pending = ['a', 'b', 'c', 'd'].map(hint);
    const { queue, dropped } = boundInterventionQueue(pending, 2);

    expect(queue.map((i) => i.message)).toEqual(['c', 'd']);
    expect(dropped.map((i) => i.message)).toEqual(['a', 'b']);
  });
});
