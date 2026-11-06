import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCostReconcileStore } from './claude-cost-reconcile-store';
import {
  ClaudeCostReconcileService,
  RECONCILE_INTERVAL_MS,
  RECONCILE_RETRY_MS,
  RECONCILE_STARTUP_DELAY_MS,
  getClaudeCostReconcileService,
  type ClaudeCostReconcileServiceDeps,
} from './claude-cost-reconcile-service';
import type { ClaudeCostStateRead } from './claude-cost-state-reader';
import type { StoredClaudeSession } from './claude-cost-reconcile';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);

describe('ClaudeCostReconcileService', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let sessions: StoredClaudeSession[];
  let states: Record<string, ClaudeCostStateRead>;
  let loadCalls: number[];
  const deps = (over: Partial<ClaudeCostReconcileServiceDeps> = {}): ClaudeCostReconcileServiceDeps => ({
    statePath,
    now: () => clock,
    loadSessions: windowStart => { loadCalls.push(windowStart); return sessions; },
    bookingLiveAt: () => 1,
    transcriptRoots: () => ['/roots'],
    indexTranscripts: async () => new Map(Object.keys(states).map(id => [id, `/roots/${id}.jsonl`])),
    readState: async file => states[file.split('/').pop()!.replace('.jsonl', '')] ?? { kind: 'missing' },
    yieldTurn: async () => undefined,
    ...over,
  });
  const service = () => getClaudeCostReconcileService();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    ClaudeCostReconcileService._resetForTesting();
    dir = mkdtempSync(join(tmpdir(), 'aio-reconcile-'));
    statePath = join(dir, 'claude-cost-reconcile.json');
    clock = NOW;
    loadCalls = [];
    sessions = [{ sessionId: 'a', models: ['opus'], rows: 2, storedUsd: 10, firstAt: NOW - DAY, lastAt: NOW - 1000 }];
    states = { a: { kind: 'settled', totalCostUSD: 10, hasUnknownModelCost: false } };
  });
  afterEach(() => {
    ClaudeCostReconcileService._resetForTesting();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a lazy singleton that can be reset for tests', () => {
    expect(getClaudeCostReconcileService()).toBe(ClaudeCostReconcileService.getInstance());
    const first = getClaudeCostReconcileService();
    ClaudeCostReconcileService._resetForTesting();
    expect(getClaudeCostReconcileService()).not.toBe(first);
  });

  it('runs a check on demand, looks back three days, stores it and exposes it', async () => {
    service().configure(deps());
    const report = await service().runNow();
    expect(report).toMatchObject({ status: 'ok', coverage: { compared: 1 } });
    expect(loadCalls).toEqual([NOW - 3 * DAY]);
    const snapshot = service().getSnapshot();
    expect(snapshot).toMatchObject({ running: false, lastError: null, latest: { checkedAt: NOW }, history: [{ checkedAt: NOW }] });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).latest.checkedAt).toBe(NOW);
  });

  it('shares one run between callers that ask while a check is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    service().configure(deps({ readState: async () => { await gate; return { kind: 'missing' }; } }));
    const first = service().runNow();
    const second = service().runNow();
    expect(service().getSnapshot().running).toBe(true);
    release();
    expect(await first).toBe(await second);
    expect(loadCalls).toHaveLength(1);
  });

  it('records a failure without throwing, keeps the previous report and retries within the hour', async () => {
    sessions = [{ sessionId: 'a', models: ['opus'], rows: 1, storedUsd: 12, firstAt: NOW, lastAt: NOW }];
    states = { a: { kind: 'settled', totalCostUSD: 10, hasUnknownModelCost: false } };
    service().configure(deps());
    service().start();
    await vi.advanceTimersByTimeAsync(RECONCILE_STARTUP_DELAY_MS);
    const good = service().getSnapshot().latest;
    expect(good?.status).toBe('drift');
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS - RECONCILE_STARTUP_DELAY_MS);
    ClaudeCostReconcileService._resetForTesting();
    service().configure(deps({ loadSessions: () => { throw new Error('database is locked'); } }));
    expect(await service().runNow()).toBeNull();
    const failed = service().getSnapshot();
    expect(failed.lastError).toContain('database is locked');
    expect(failed.latest?.checkedAt).toBe(good?.checkedAt);
  });

  it('on start, waits out the startup delay before the first check when none is stored', async () => {
    service().configure(deps());
    service().start();
    await vi.advanceTimersByTimeAsync(RECONCILE_STARTUP_DELAY_MS - 1);
    expect(loadCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadCalls).toHaveLength(1);
  });

  it('on start, does not check again when a check is under a day old, and checks at the day mark', async () => {
    const store = new ClaudeCostReconcileStore(statePath);
    service().configure(deps());
    await service().runNow();
    ClaudeCostReconcileService._resetForTesting();
    loadCalls = [];
    clock = NOW + 3_600_000;
    vi.setSystemTime(clock);
    service().configure(deps());
    service().start();
    await vi.advanceTimersByTimeAsync(RECONCILE_STARTUP_DELAY_MS + 1000);
    expect(loadCalls).toHaveLength(0);
    expect(store.load().latest?.checkedAt).toBe(NOW);
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS - 3_600_000);
    expect(loadCalls).toHaveLength(1);
  });

  it('never waits longer than a day, even when the saved last-check time is in the future', async () => {
    new ClaudeCostReconcileStore(statePath).save({ latest: null, history: [], lastAttemptAt: NOW + 400 * DAY, lastError: null });
    service().configure(deps());
    service().start();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS - 1);
    expect(loadCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadCalls).toHaveLength(1);
  });

  it('after a failed check tries again in an hour rather than waiting a day', async () => {
    let failing = true;
    service().configure(deps({ loadSessions: windowStart => { loadCalls.push(windowStart); if (failing) throw new Error('boom'); return sessions; } }));
    service().start();
    await vi.advanceTimersByTimeAsync(RECONCILE_STARTUP_DELAY_MS);
    expect(loadCalls).toHaveLength(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(RECONCILE_RETRY_MS);
    expect(loadCalls).toHaveLength(2);
    expect(service().getSnapshot().lastError).toBeNull();
  });

  it('stop cancels the schedule, and start without configuration is a harmless no-op', async () => {
    service().start();
    service().configure(deps());
    service().start();
    service().stop();
    await vi.advanceTimersByTimeAsync(2 * RECONCILE_INTERVAL_MS);
    expect(loadCalls).toHaveLength(0);
  });

  describe('a check that is still running when the service is stopped, reconfigured or shut down', () => {
    let release!: () => void;
    let gate: Promise<void>;
    const gated = (over: Partial<ClaudeCostReconcileServiceDeps> = {}): ClaudeCostReconcileServiceDeps =>
      deps({ readState: async () => { await gate; return { kind: 'settled', totalCostUSD: 10, hasUnknownModelCost: false }; }, ...over });
    const otherPath = (): string => join(dir, 'other-state.json');
    beforeEach(() => { gate = new Promise<void>(resolve => { release = resolve; }); });

    it('cannot write its result into a service that was reconfigured meanwhile', async () => {
      service().configure(gated());
      const stale = service().runNow();
      service().configure(deps({ statePath: otherPath() }));
      release();
      expect(await stale).toBeNull();
      expect(service().getSnapshot()).toMatchObject({ latest: null, history: [], lastError: null, running: false });
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(otherPath())).toBe(false);
    });

    it('is discarded by stop, including its schedule', async () => {
      service().configure(gated());
      service().start();
      await vi.advanceTimersByTimeAsync(RECONCILE_STARTUP_DELAY_MS);
      service().stop();
      release();
      await vi.advanceTimersByTimeAsync(3 * RECONCILE_INTERVAL_MS);
      expect(service().getSnapshot().latest).toBeNull();
      expect(existsSync(statePath)).toBe(false);
      expect(loadCalls).toHaveLength(1);
    });

    it('is discarded by shutdown, and nothing can be started afterwards', async () => {
      service().configure(gated());
      const stale = service().runNow();
      service().shutdown();
      release();
      expect(await stale).toBeNull();
      expect(existsSync(statePath)).toBe(false);
      expect(await service().runNow()).toBeNull();
      service().start();
      await vi.advanceTimersByTimeAsync(2 * RECONCILE_INTERVAL_MS);
      expect(loadCalls).toHaveLength(1);
    });

    it('does not report its failure as the new configuration\'s error', async () => {
      let fail!: () => void;
      const broken = new Promise<void>((_, reject) => { fail = () => reject(new Error('stale boom')); });
      broken.catch(() => undefined);
      service().configure(deps({ readState: async () => { await broken; return { kind: 'missing' }; } }));
      const stale = service().runNow();
      service().configure(deps({ statePath: otherPath() }));
      fail();
      expect(await stale).toBeNull();
      expect(service().getSnapshot().lastError).toBeNull();
      expect(existsSync(statePath)).toBe(false);
    });

    it('does not clear the in-progress marker of the check that replaced it', async () => {
      service().configure(gated());
      const stale = service().runNow();
      let releaseNew!: () => void;
      const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
      service().configure(deps({ statePath: otherPath(), readState: async () => { await newGate; return { kind: 'settled', totalCostUSD: 10, hasUnknownModelCost: false }; } }));
      const fresh = service().runNow();
      release();
      await stale;
      expect(service().getSnapshot().running).toBe(true);
      releaseNew();
      expect(await fresh).toMatchObject({ status: 'ok' });
      expect(service().getSnapshot()).toMatchObject({ running: false, latest: { status: 'ok' } });
      expect(JSON.parse(readFileSync(otherPath(), 'utf8')).latest.status).toBe('ok');
    });
  });

  it('starts fresh when the stored file is damaged', async () => {
    writeFileSync(statePath, '{not json');
    service().configure(deps());
    expect(service().getSnapshot()).toMatchObject({ latest: null, history: [], lastError: null });
    expect(await service().runNow()).not.toBeNull();
  });
});
