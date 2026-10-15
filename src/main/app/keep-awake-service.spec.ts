import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepAwakeService, getKeepAwakeService } from './keep-awake-service';
import { sessionKeepAwakeReasons } from './keep-awake-probes';
import type { KeepAwakeState } from '@contracts/schemas/observability';

vi.mock('electron', () => ({ powerSaveBlocker: {} }));

describe('KeepAwakeService', () => {
  let mode: KeepAwakeState['mode'];
  let work: ('loop' | 'plan-queue' | 'automation' | 'session')[];
  let held: Set<number>;
  let nextId: number;
  let starts: string[];
  let updates: KeepAwakeState[];
  const start = (type: string) => { starts.push(type); held.add(nextId); return nextId++; };
  const stop = (id: number) => held.delete(id);
  const initialize = (probes = [() => work]) => {
    const service = getKeepAwakeService();
    service.initialize({ getMode: () => mode, probes, blocker: { start, stop },
      broadcast: state => updates.push(state), now: () => Date.now() });
    return service;
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    mode = 'while-working'; work = []; held = new Set(); nextId = 0; starts = []; updates = [];
    KeepAwakeService._resetForTesting();
  });
  afterEach(() => { KeepAwakeService._resetForTesting(); vi.useRealTimers(); });
  it('while-working with no work starts nothing', () => {
    expect(initialize().getState()).toEqual({ mode, active: false, reason: null, since: null });
    expect(held.size).toBe(0);
  });
  it('work appearing starts one system assertion and reports loop', () => {
    const service = initialize(); work = ['loop']; vi.advanceTimersByTime(30000); service.reconcile();
    expect(starts).toEqual(['prevent-app-suspension']); expect(held.size).toBe(1);
    expect(service.getState()).toEqual({ mode, active: true, reason: 'loop', since: 31000 });
  });
  it('work ending releases the assertion by id', () => {
    work = ['session']; const service = initialize(); work = []; service.reconcile();
    expect(held.size).toBe(0); expect(service.getState().since).toBeNull();
  });
  it('always starts with no work and off releases immediately', () => {
    mode = 'always'; const service = initialize();
    expect(service.getState().reason).toBe('always'); expect(held.size).toBe(1);
    mode = 'off'; service.reconcile(); expect(held.size).toBe(0); expect(service.getState().active).toBe(false);
  });
  it('prioritizes loop, queue, automation then session without restarting the assertion', () => {
    work = ['session', 'automation', 'plan-queue', 'loop']; const service = initialize();
    for (const reason of ['loop', 'plan-queue', 'automation', 'session']) {
      expect(service.getState().reason).toBe(reason); work.pop(); service.reconcile();
    }
    expect(starts).toEqual(['prevent-app-suspension']);
  });
  it('broadcasts only active/reason changes and preserves activation time', () => {
    work = ['session']; const service = initialize(); vi.advanceTimersByTime(30000);
    mode = 'always'; service.reconcile(); expect(updates).toHaveLength(1);
    work = ['loop']; service.reconcile();
    expect(updates).toHaveLength(2); expect(service.getState().since).toBe(1000);
  });
  it('ignores a throwing probe and still uses healthy probes', () => {
    work = ['automation']; const service = initialize([() => { throw new Error('offline'); }, () => work]);
    expect(() => service.reconcile()).not.toThrow(); expect(service.getState().reason).toBe('automation');
  });
  it('keeps polling when a renderer broadcast throws', () => {
    const service = getKeepAwakeService();
    work = ['session'];
    expect(() => service.initialize({ getMode: () => mode, probes: [() => work], blocker: { start, stop },
      broadcast: () => { throw new Error('renderer closed'); },
    })).not.toThrow();
    work = []; expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(held.size).toBe(0);
  });
  it('shutdown releases assertion and prevents later ticks', () => {
    mode = 'always'; const service = initialize(); service.shutdown(); vi.advanceTimersByTime(60000);
    expect(held.size).toBe(0); expect(service.getState().active).toBe(false); expect(starts).toHaveLength(1);
  });
  it('reinitialization releases the previous assertion', () => {
    mode = 'always'; const service = initialize(); initialize();
    expect(held.size).toBe(1); service.shutdown(); expect(held.size).toBe(0);
  });
});

describe('sessionKeepAwakeReasons', () => {
  it('ignores nonworking and two-hour silent sessions and classifies recent remote work', () => {
    const now = 10_000_000;
    expect(sessionKeepAwakeReasons([
      { status: 'busy', lastActivity: now - 7_200_000, metadata: {} },
      { status: 'waiting_for_input', lastActivity: now, metadata: {} },
      { status: 'busy', lastActivity: now - 1, metadata: { planQueueRunId: 'q' } },
      { status: 'processing', lastActivity: now, metadata: { automationRunId: 'a' } },
      { status: 'thinking_deeply', lastActivity: now, metadata: {} },
    ], now)).toEqual(['plan-queue', 'automation', 'session']);
  });
});
