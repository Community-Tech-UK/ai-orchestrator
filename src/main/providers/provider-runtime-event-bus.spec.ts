import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderRuntimeEventBus,
  type PendingEnvelope,
} from './provider-runtime-event-bus';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

function makePending(
  kind: PendingEnvelope['event']['kind'],
  instanceId: string,
  extra: Record<string, unknown> = {},
): PendingEnvelope {
  const base: PendingEnvelope = {
    timestamp: Date.now(),
    provider: 'claude',
    instanceId,
    sessionId: 'session-1',
    event: { kind, content: 'text' } as PendingEnvelope['event'],
  };
  if (kind === 'context') {
    base.event = { kind: 'context', used: 1000, total: 200_000, percentage: 0.5, ...extra } as PendingEnvelope['event'];
  } else if (kind === 'status') {
    base.event = { kind: 'status', status: (extra['status'] as string) ?? 'busy' } as PendingEnvelope['event'];
  } else if (kind === 'output') {
    base.event = { kind: 'output', content: (extra['content'] as string) ?? 'hello' } as PendingEnvelope['event'];
  }
  return base;
}

describe('ProviderRuntimeEventBus', () => {
  let emitted: ProviderRuntimeEventEnvelope[];
  let bus: ProviderRuntimeEventBus;

  beforeEach(() => {
    emitted = [];
    bus = new ProviderRuntimeEventBus(
      (env) => emitted.push(env),
      { contextFlushIntervalMs: 100, statusDedupeIntervalMs: 200 },
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Critical events ──────────────────────────────────────────────────────

  it('emits output events immediately with contiguous seq', () => {
    bus.enqueue(makePending('output', 'inst-1', { content: 'a' }));
    bus.enqueue(makePending('output', 'inst-1', { content: 'b' }));
    bus.enqueue(makePending('output', 'inst-1', { content: 'c' }));

    expect(emitted).toHaveLength(3);
    expect(emitted.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(emitted.map((e) => (e.event as { content: string }).content)).toEqual(['a', 'b', 'c']);
  });

  it('output events from separate instances have independent seqs', () => {
    bus.enqueue(makePending('output', 'inst-A', { content: 'a1' }));
    bus.enqueue(makePending('output', 'inst-B', { content: 'b1' }));
    bus.enqueue(makePending('output', 'inst-A', { content: 'a2' }));

    const a = emitted.filter((e) => e.instanceId === 'inst-A');
    const b = emitted.filter((e) => e.instanceId === 'inst-B');
    expect(a.map((e) => e.seq)).toEqual([0, 1]);
    expect(b.map((e) => e.seq)).toEqual([0]);
  });

  it('never drops critical event kinds', () => {
    const criticalKinds = ['output', 'tool_use', 'tool_result', 'error', 'exit', 'spawned', 'complete'] as const;
    for (const kind of criticalKinds) {
      const b2 = new ProviderRuntimeEventBus((env) => emitted.push(env));
      const p = makePending('output', 'inst-1');
      (p.event as { kind: string }).kind = kind;
      b2.enqueue(p);
      expect(emitted.at(-1)?.event.kind).toBe(kind);
    }
  });

  // ── Context coalescing ───────────────────────────────────────────────────

  it('context events are not emitted immediately', () => {
    bus.enqueue(makePending('context', 'inst-1'));
    expect(emitted).toHaveLength(0);
  });

  it('context events are emitted after flush interval', () => {
    bus.enqueue(makePending('context', 'inst-1'));
    vi.advanceTimersByTime(101);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event.kind).toBe('context');
  });

  it('multiple context events for same instance are coalesced — only the last is emitted', () => {
    bus.enqueue(makePending('context', 'inst-1', { used: 100, total: 200_000, percentage: 0.05 }));
    bus.enqueue(makePending('context', 'inst-1', { used: 200, total: 200_000, percentage: 0.1 }));
    bus.enqueue(makePending('context', 'inst-1', { used: 300, total: 200_000, percentage: 0.15 }));
    vi.advanceTimersByTime(101);

    expect(emitted).toHaveLength(1);
    expect((emitted[0].event as { used: number }).used).toBe(300);
    expect(bus.metrics().coalescedContext).toBe(2);
  });

  it('coalesced context events do not create sequence gaps', () => {
    // Emit an output (seq 0), then coalesce 3 context events (only 1 emitted = seq 1)
    bus.enqueue(makePending('output', 'inst-1', { content: 'x' }));
    bus.enqueue(makePending('context', 'inst-1'));
    bus.enqueue(makePending('context', 'inst-1'));
    bus.enqueue(makePending('context', 'inst-1'));
    bus.enqueue(makePending('output', 'inst-1', { content: 'y' }));

    // output 'x' → seq 0 (immediate)
    // context (coalesced) → seq 1 (after flush)
    // output 'y' → seq 2 (immediate, before context flush fires)
    vi.advanceTimersByTime(101);

    const seqs = emitted.map((e) => e.seq);
    // The three events emitted: seq 0 (output x), seq 2 (output y), seq 1 (context — order may vary)
    // What matters: no gaps. The set of seqs should be {0, 1, 2}.
    expect(new Set(seqs)).toEqual(new Set([0, 1, 2]));
  });

  it('context events from different instances flush independently', () => {
    bus.enqueue(makePending('context', 'inst-A', { used: 10 }));
    bus.enqueue(makePending('context', 'inst-B', { used: 20 }));
    vi.advanceTimersByTime(101);

    expect(emitted).toHaveLength(2);
    expect(emitted.find((e) => e.instanceId === 'inst-A')?.event.kind).toBe('context');
    expect(emitted.find((e) => e.instanceId === 'inst-B')?.event.kind).toBe('context');
  });

  // ── Status deduplication ─────────────────────────────────────────────────

  it('status event is emitted on first occurrence', () => {
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    expect(emitted).toHaveLength(1);
    expect((emitted[0].event as { status: string }).status).toBe('busy');
  });

  it('duplicate status within dedupe interval is suppressed', () => {
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    vi.advanceTimersByTime(50); // within 200 ms interval
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    expect(emitted).toHaveLength(1);
    expect(bus.metrics().droppedStatus).toBe(1);
  });

  it('same status after interval is emitted again', () => {
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    vi.advanceTimersByTime(201);
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    expect(emitted).toHaveLength(2);
  });

  it('different status string is always emitted', () => {
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    bus.enqueue(makePending('status', 'inst-1', { status: 'idle' }));
    expect(emitted).toHaveLength(2);
    expect(bus.metrics().droppedStatus).toBe(0);
  });

  it('suppressed status events do not consume sequence numbers', () => {
    bus.enqueue(makePending('output', 'inst-1', { content: 'a' }));
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' })); // suppressed
    bus.enqueue(makePending('output', 'inst-1', { content: 'b' }));

    expect(emitted.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  // ── removeInstance ───────────────────────────────────────────────────────

  it('removeInstance flushes pending context and clears state', () => {
    bus.enqueue(makePending('context', 'inst-1', { used: 500 }));
    expect(emitted).toHaveLength(0);

    bus.removeInstance('inst-1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event.kind).toBe('context');

    // Seq is reset for instance after removal
    bus.enqueue(makePending('output', 'inst-1', { content: 'after' }));
    expect(emitted[1].seq).toBe(0);
  });

  // ── Metrics ──────────────────────────────────────────────────────────────

  it('metrics reflect emitted, coalesced, and dropped counts', () => {
    bus.enqueue(makePending('output', 'inst-1'));
    bus.enqueue(makePending('context', 'inst-1'));
    bus.enqueue(makePending('context', 'inst-1')); // coalesced
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' }));
    bus.enqueue(makePending('status', 'inst-1', { status: 'busy' })); // dropped

    vi.advanceTimersByTime(101);

    const m = bus.metrics();
    expect(m.emitted).toBe(3); // output + 1 context + 1 status
    expect(m.coalescedContext).toBe(1);
    expect(m.droppedStatus).toBe(1);
    expect(m.pendingContext).toBe(0);
  });

  // ── Envelope shape ───────────────────────────────────────────────────────

  it('each emitted envelope has a unique eventId', () => {
    bus.enqueue(makePending('output', 'inst-1', { content: 'a' }));
    bus.enqueue(makePending('output', 'inst-1', { content: 'b' }));
    const ids = emitted.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it('envelope preserves provider, instanceId, sessionId, and event', () => {
    const pending = makePending('output', 'inst-1', { content: 'hello' });
    bus.enqueue(pending);
    expect(emitted[0]).toMatchObject({
      provider: 'claude',
      instanceId: 'inst-1',
      sessionId: 'session-1',
      event: { kind: 'output' },
    });
  });
});
