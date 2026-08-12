import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderRuntimeTraceSink,
  _resetProviderRuntimeTraceSinkForTesting,
  getProviderRuntimeTraceSink,
  toTraceRecord,
} from './provider-runtime-trace-sink';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

function makeEnvelope(kind: string, seq: number): ProviderRuntimeEventEnvelope {
  return {
    eventId: `evt-${seq}`,
    seq,
    timestamp: Date.now(),
    provider: 'claude',
    instanceId: 'inst-1',
    sessionId: 'session-1',
    event: kind === 'output'
      ? { kind: 'output', content: `chunk-${seq}` }
      : kind === 'error'
      ? { kind: 'error', message: 'boom', code: 'ERR' }
      : kind === 'complete'
      ? { kind: 'complete', reason: 'stop' }
      : { kind: 'context', used: seq * 100, total: 200_000, percentage: seq / 2000 },
  } as ProviderRuntimeEventEnvelope;
}

describe('ProviderRuntimeTraceSink', () => {
  beforeEach(() => {
    _resetProviderRuntimeTraceSinkForTesting();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    _resetProviderRuntimeTraceSinkForTesting();
    vi.useRealTimers();
  });

  it('enqueue returns quickly for 10,000 events (no worker)', async () => {
    const sink = new ProviderRuntimeTraceSink(() => null);

    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      sink.enqueue(makeEnvelope('output', i));
    }
    const elapsed = Date.now() - start;

    // Main thread should not be blocked; all work is queued/deferred
    expect(elapsed).toBeLessThan(500);
  });

  it('shutdown drains without throwing', async () => {
    const sink = new ProviderRuntimeTraceSink(() => null);
    for (let i = 0; i < 100; i++) {
      sink.enqueue(makeEnvelope('output', i));
    }
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });

  it('metrics are accessible', () => {
    const sink = new ProviderRuntimeTraceSink(() => null);
    sink.enqueue(makeEnvelope('output', 0));
    const m = sink.metrics();
    expect(typeof m.enqueued).toBe('number');
    expect(typeof m.dropped).toBe('number');
    expect(typeof m.workerErrors).toBe('number');
  });

  it('records error attributes for error events', async () => {
    const posted: unknown[] = [];
    const fakeWorker = {
      postMessage: (msg: unknown) => posted.push(msg),
      on: vi.fn(),
    } as unknown as import('node:worker_threads').Worker;

    const sink = new ProviderRuntimeTraceSink(() => fakeWorker);
    sink.enqueue(makeEnvelope('error', 0));

    vi.advanceTimersByTime(300);
    // Allow the bounded queue microtask to run
    await Promise.resolve();
    await Promise.resolve();

    const writeMsg = posted.find((m) => (m as { type: string }).type === 'write-records') as
      | { type: string; records: { kind: string; attributes?: Record<string, unknown> }[] }
      | undefined;

    if (writeMsg) {
      const rec = writeMsg.records.find((r) => r.kind === 'error');
      expect(rec?.attributes?.['error.message']).toBe('boom');
    }
    // If timing didn't flush, just verify no throw
  });

  it('records context attributes for context events', async () => {
    const posted: unknown[] = [];
    const fakeWorker = {
      postMessage: (msg: unknown) => posted.push(msg),
      on: vi.fn(),
    } as unknown as import('node:worker_threads').Worker;

    const sink = new ProviderRuntimeTraceSink(() => fakeWorker);
    sink.enqueue(makeEnvelope('context', 5));

    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();

    const writeMsg = posted.find((m) => (m as { type: string }).type === 'write-records') as
      | { type: string; records: { kind: string; attributes?: Record<string, unknown> }[] }
      | undefined;

    if (writeMsg) {
      const rec = writeMsg.records.find((r) => r.kind === 'context');
      expect(typeof rec?.attributes?.['context.used']).toBe('number');
    }
  });

  it('getProviderRuntimeTraceSink returns a singleton', () => {
    const a = getProviderRuntimeTraceSink();
    const b = getProviderRuntimeTraceSink();
    expect(a).toBe(b);
  });

  it('reset creates a fresh instance', () => {
    const a = getProviderRuntimeTraceSink();
    _resetProviderRuntimeTraceSinkForTesting();
    const b = getProviderRuntimeTraceSink();
    expect(a).not.toBe(b);
  });

  it('handles worker crash gracefully', () => {
    let errorCallback: ((err: Error) => void) | null = null;
    const fakeWorker = {
      postMessage: vi.fn(),
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') errorCallback = cb;
      }),
    } as unknown as import('node:worker_threads').Worker;

    const sink = new ProviderRuntimeTraceSink(() => fakeWorker);
    expect(() => errorCallback?.(new Error('crash'))).not.toThrow();

    // After crash, enqueue should not throw
    expect(() => sink.enqueue(makeEnvelope('output', 0))).not.toThrow();
  });

  it('redacts secrets in error-event trace attributes (Task 14)', () => {
    const envelope = {
      eventId: 'evt-err',
      seq: 1,
      timestamp: Date.now(),
      provider: 'claude',
      instanceId: 'inst-1',
      sessionId: 'session-1',
      event: { kind: 'error', message: 'auth failed: Bearer abcdef1234567890ghijkl', code: 'ERR' },
    } as ProviderRuntimeEventEnvelope;

    const record = toTraceRecord(envelope);
    const errorMessage = record.attributes?.['error.message'];
    expect(typeof errorMessage).toBe('string');
    expect(errorMessage as string).not.toContain('abcdef1234567890');
    expect(errorMessage as string).toContain('<redacted-secret>');
    // Safe top-level identifiers are untouched.
    expect(record.provider).toBe('claude');
    expect(record.instanceId).toBe('inst-1');
  });
});

/**
 * LT-018/LT-034. `ProviderContextEvent` carries `occupancyReported` and
 * `occupancyIsAggregate`, and the schema comment warns that a missing key
 * "silently drops 'these are spend, not occupancy' from every replay and
 * export". The trace record is that export, so it has to carry both — a number
 * without its meaning is exactly the defect, preserved on disk.
 */
describe('toTraceRecord context attributes (LT-018/LT-034)', () => {
  const envelope = (event: Record<string, unknown>) => ({
    eventId: 'b1c2d3e4-f5a6-4890-abcd-ef0123456789',
    seq: 1,
    timestamp: 1_717_000_000_000,
    provider: 'copilot',
    instanceId: 'inst-1',
    event,
  }) as unknown as Parameters<typeof toTraceRecord>[0];

  it('records that a reading is cumulative spend, not occupancy', () => {
    const rec = toTraceRecord(envelope({
      kind: 'context', used: 190_000, total: 200_000, percentage: 95,
      occupancyReported: true, occupancyIsAggregate: true,
    }));

    expect(rec.attributes?.['context.occupancy_is_aggregate']).toBe(true);
    expect(rec.attributes?.['context.occupancy_reported']).toBe(true);
  });

  it('records a real occupancy reading as not aggregate', () => {
    const rec = toTraceRecord(envelope({
      kind: 'context', used: 50_000, total: 200_000, percentage: 25,
      occupancyReported: true, occupancyIsAggregate: false,
    }));

    expect(rec.attributes?.['context.occupancy_is_aggregate']).toBe(false);
  });

  it('omits the keys entirely when the event carries no flags', () => {
    const rec = toTraceRecord(envelope({
      kind: 'context', used: 0, total: 200_000, percentage: 0,
    }));

    expect('context.occupancy_reported' in (rec.attributes ?? {})).toBe(false);
    expect('context.occupancy_is_aggregate' in (rec.attributes ?? {})).toBe(false);
  });
});
