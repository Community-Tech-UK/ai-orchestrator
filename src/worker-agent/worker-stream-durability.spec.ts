import { describe, expect, it } from 'vitest';
import { WorkerStreamDurability } from './worker-stream-durability';

describe('WorkerStreamDurability', () => {
  it('assigns per-instance monotonic seqs starting at 1', () => {
    const ring = new WorkerStreamDurability();
    expect(ring.record('a', 'instance.output', { n: 1 })).toBe(1);
    expect(ring.record('a', 'instance.output', { n: 2 })).toBe(2);
    expect(ring.record('b', 'instance.output', { n: 1 })).toBe(1);
  });

  it('replays only events after the cursor, in order', () => {
    const ring = new WorkerStreamDurability();
    for (let i = 1; i <= 5; i++) ring.record('a', 'instance.output', { n: i });
    const replay = ring.replayAfter('a', 2);
    expect(replay.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(replay.gapThroughSeq).toBeUndefined();
    expect(ring.replayAfter('missing', 0)).toEqual({ events: [] });
  });

  it('acks trim the ring so acked events are never replayed', () => {
    const ring = new WorkerStreamDurability();
    for (let i = 1; i <= 4; i++) ring.record('a', 'instance.output', { n: i });
    ring.ack('a', 3);
    expect(ring.replayAfter('a', 0).events.map((e) => e.seq)).toEqual([4]);
    expect(ring.stats().events).toBe(1);
  });

  it('evicts oldest beyond the count bound and reports the gap on replay', () => {
    const ring = new WorkerStreamDurability(3);
    for (let i = 1; i <= 5; i++) ring.record('a', 'instance.output', { n: i });
    const replay = ring.replayAfter('a', 0);
    expect(replay.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(replay.gapThroughSeq).toBe(2); // seqs 1–2 evicted, unacked
    // A cursor past the gap sees clean continuity.
    expect(ring.replayAfter('a', 3).gapThroughSeq).toBeUndefined();
  });

  it('evicts by byte budget as well as count', () => {
    const ring = new WorkerStreamDurability(100, 200);
    const big = 'x'.repeat(120);
    ring.record('a', 'instance.output', { big });
    ring.record('a', 'instance.output', { big });
    // First event evicted to stay under 200 bytes total.
    const replay = ring.replayAfter('a', 0);
    expect(replay.events.map((e) => e.seq)).toEqual([2]);
    expect(replay.gapThroughSeq).toBe(1);
  });

  it('bounds the number of tracked instances', () => {
    const ring = new WorkerStreamDurability();
    for (let i = 0; i < 201; i++) ring.record(`inst-${i}`, 'instance.output', {});
    expect(ring.instanceIds()).not.toContain('inst-0');
    expect(ring.instanceIds()).toContain('inst-200');
  });

  it('removeInstance frees the ring', () => {
    const ring = new WorkerStreamDurability();
    ring.record('a', 'instance.output', {});
    ring.removeInstance('a');
    expect(ring.stats()).toEqual({ instances: 0, events: 0, bytes: 0 });
  });
});
