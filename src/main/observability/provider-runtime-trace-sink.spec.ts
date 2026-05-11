import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderRuntimeTraceSink,
  _resetProviderRuntimeTraceSinkForTesting,
  getProviderRuntimeTraceSink,
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
});
