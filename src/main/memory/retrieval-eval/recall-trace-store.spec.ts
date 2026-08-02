import { describe, expect, it } from 'vitest';
import { RecallTraceStore, hashQuery } from './recall-trace-store';

describe('RecallTraceStore', () => {
  it('records traces keyed by query hash, not raw text, with retained raw/sanitized', () => {
    const store = new RecallTraceStore();
    const trace = store.record({
      surface: 'codemem',
      query: 'find backoff',
      rawQuery: 'giant dump … find backoff',
      sanitizedQuery: 'find backoff',
      returned: [{ id: 'src/a.ts', score: 2 }],
      now: 100,
    });
    expect(trace.queryHash).toBe(hashQuery('find backoff'));
    expect(trace.rawQuery).toContain('giant dump');
    expect(trace.usedIds).toEqual([]);
    expect(store.bySurface('codemem')).toHaveLength(1);
  });

  it('markUsed credits the most recent trace that returned the id', () => {
    const store = new RecallTraceStore();
    store.record({ surface: 'lessons', query: 'q1', returned: [{ id: 'l1', score: 1 }], now: 1 });
    store.record({ surface: 'lessons', query: 'q2', returned: [{ id: 'l1', score: 1 }, { id: 'l2', score: 1 }], now: 2 });

    const credited = store.markUsed('lessons', ['l1', 'l2', 'missing']);
    expect(credited.sort()).toEqual(['l1', 'l2']);
    // Most-recent trace (q2) got both; the older q1 trace stays unused.
    const traces = store.bySurface('lessons');
    expect(traces[1].usedIds.sort()).toEqual(['l1', 'l2']);
    expect(traces[0].usedIds).toEqual([]);
  });

  it('does not double-credit the same id within one trace', () => {
    const store = new RecallTraceStore();
    store.record({ surface: 'rlm', query: 'q', returned: [{ id: 'a', score: 1 }], now: 1 });
    expect(store.markUsed('rlm', ['a'])).toEqual(['a']);
    expect(store.markUsed('rlm', ['a'])).toEqual([]); // already credited, no older trace
  });

  it('is bounded — oldest traces evicted past the cap', () => {
    const store = new RecallTraceStore(3);
    for (let i = 0; i < 5; i++) {
      store.record({ surface: 'codemem', query: `q${i}`, returned: [], now: i });
    }
    expect(store.all()).toHaveLength(3);
    expect(store.all().map((t) => t.queryHash)).toEqual([
      hashQuery('q2'), hashQuery('q3'), hashQuery('q4'),
    ]);
  });

  it('uses a deterministic id supplier when provided', () => {
    const store = new RecallTraceStore();
    const t = store.record({ surface: 'rlm', query: 'q', returned: [], idFor: (seq) => `fixed-${seq}` });
    expect(t.id).toBe('fixed-1');
  });
});

/**
 * WS16 observability. This store is in-memory with no IPC, preload, disk or
 * diagnostics surface — before these log lines a recall trace was unobservable
 * by anyone, which made three livetest checks unrunnable *by construction*
 * rather than merely unrun. The store's own contract is that traces "never leak
 * query text into telemetry", so the log carries the hash and lengths only.
 */
describe('RecallTraceStore observability (WS16 checks 4/5/6)', () => {
  it('retains the sanitizer strategy so it can be observed, not just that sanitizing happened', () => {
    const store = new RecallTraceStore();
    const trace = store.record({
      surface: 'codemem',
      query: 'where is the backoff helper?',
      rawQuery: 'an 8-frame stack trace … where is the backoff helper?',
      sanitizedQuery: 'where is the backoff helper?',
      strategy: 'last-question',
      returned: [{ id: 'src/a.ts', score: 2 }],
    });

    expect(trace.strategy).toBe('last-question');
  });

  it('omits strategy entirely when the caller did not supply one', () => {
    const store = new RecallTraceStore();
    const trace = store.record({
      surface: 'rlm',
      query: 'short query',
      returned: [],
    });

    expect(trace.strategy).toBeUndefined();
    expect('strategy' in trace).toBe(false);
  });

  it('never retains query text on the hash key, whatever the strategy', () => {
    const store = new RecallTraceStore();
    const secret = 'token sk-do-not-log-me please find the helper?';
    const trace = store.record({
      surface: 'codemem',
      query: 'please find the helper?',
      rawQuery: secret,
      sanitizedQuery: 'please find the helper?',
      strategy: 'last-question',
      returned: [],
    });

    // queryHash is the telemetry-safe key; raw text is retained locally only.
    expect(trace.queryHash).not.toContain('sk-do-not-log-me');
    expect(trace.queryHash).toBe(hashQuery('please find the helper?'));
  });
});
