/**
 * Durable self-wakeup tally store — save-failure contract (October follow-ups
 * A#185). A failed or partial save must never destroy the last valid tally:
 * the store replaces the file atomically, so history survives ENOSPC mid-write.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fsActual = vi.hoisted(() => ({
  writeFileSync: undefined as unknown as typeof import('fs').writeFileSync,
  renameSync: undefined as unknown as typeof import('fs').renameSync,
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  fsActual.writeFileSync = actual.writeFileSync;
  fsActual.renameSync = actual.renameSync;
  // `default` must be the merged mock too: transitive importers resolve named
  // bindings through it, so a spread `default` of the real module would bypass
  // the spies inside the store while the spec's own imports saw them.
  const mocked = { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
  return { ...mocked, default: mocked };
});
import { createSelfWakeupTallyStore } from './self-wakeup-tally-store';
import { SelfWakeupTracker } from './self-wakeup-tracker';

const TALLY = 'self-wakeup-tally.json';

describe('self wakeup tally store save failures (A#185)', () => {
  it('keeps counts across tracker restarts, retains failed increments and recovers on the next save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-wakeup-tally-'));
    const store = createSelfWakeupTallyStore(() => dir);
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const observe = (tracker: SelfWakeupTracker, id: string, at = now) => tracker.observe('session', {
      kind: 'requested', toolUseId: id, requestedAt: at, delaySeconds: 90, dueAt: at + 90_000, reason: '',
    });
    let tracker = new SelfWakeupTracker(store);
    try {
      observe(tracker, 'first');
      vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('Injected replacement failure'); });
      observe(tracker, 'second');
      expect(tracker.tally(day)).toBe(2);
      expect(store.load()).toEqual({ [day]: 1 });
      observe(tracker, 'third');
      expect(store.load()).toEqual({ [day]: 3 });
      tracker.dispose();
      tracker = new SelfWakeupTracker(createSelfWakeupTallyStore(() => dir));
      expect(tracker.tally(day)).toBe(3);
      const nextDay = now + 24 * 60 * 60_000;
      observe(tracker, 'fourth', nextDay);
      expect(store.load()).toEqual({ [day]: 3, [new Date(nextDay).toISOString().slice(0, 10)]: 1 });
    } finally { tracker.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('stays in memory when no user-data directory resolves', () => {
    const tracker = new SelfWakeupTracker(createSelfWakeupTallyStore(() => null));
    const now = Date.now();
    try {
      tracker.observe('session', { kind: 'requested', toolUseId: 'request', requestedAt: now, dueAt: now + 90_000, delaySeconds: 90, reason: '' });
      expect(tracker.tally(new Date(now).toISOString().slice(0, 10))).toBe(1);
    } finally { tracker.dispose(); }
  });

  it('recovers from corrupt history and ignores invalid counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-wakeup-tally-'));
    try {
      writeFileSync(join(dir, TALLY), 'not JSON');
      const store = createSelfWakeupTallyStore(() => dir);
      expect(store.load()).toEqual({});
      store.save({ '2026-10-10': 1 });
      expect(store.load()).toEqual({ '2026-10-10': 1 });
      writeFileSync(join(dir, TALLY), JSON.stringify({ '2026-10-10': 2, '2026-10-11': -1, '2026-10-12': 1.5, '2026-10-13': '3', invalid: 4 }));
      expect(store.load()).toEqual({ '2026-10-10': 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('round-trips a tally through the real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-wakeup-tally-'));
    try {
      const store = createSelfWakeupTallyStore(() => dir);
      store.save({ '2026-10-20': 8, '2026-10-21': 3 });
      expect(store.load()).toEqual({ '2026-10-20': 8, '2026-10-21': 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the last valid tally when a save dies mid-write (partial write + ENOSPC)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-wakeup-tally-'));
    try {
      const store = createSelfWakeupTallyStore(() => dir);
      store.save({ '2026-10-20': 8, '2026-10-21': 3 });
      const saved = readFileSync(join(dir, TALLY), 'utf8');

      // Fault: a truncated write that then runs out of space — the exact
      // failure that used to land on the tally file itself and wipe history.
      vi.mocked(writeFileSync).mockImplementationOnce(((file: string, data: string, options: unknown) => {
        fsActual.writeFileSync(file, String(data).slice(0, 5), options as never);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }) as typeof import('fs').writeFileSync);

      expect(() => store.save({ '2026-10-20': 8, '2026-10-21': 3, '2026-10-22': 9 })).not.toThrow();

      expect(store.load()).toEqual({ '2026-10-20': 8, '2026-10-21': 3 });
      expect(readFileSync(join(dir, TALLY), 'utf8')).toBe(saved);
      expect(readdirSync(dir)).toEqual([TALLY]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the last valid tally when the atomic replace fails, and saves normally afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-wakeup-tally-'));
    try {
      const store = createSelfWakeupTallyStore(() => dir);
      store.save({ '2026-10-20': 8, '2026-10-21': 3 });

      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });
      expect(() => store.save({ '2026-10-20': 8, '2026-10-21': 3, '2026-10-22': 9 })).not.toThrow();

      expect(store.load()).toEqual({ '2026-10-20': 8, '2026-10-21': 3 });
      expect(readdirSync(dir)).toEqual([TALLY]);

      store.save({ '2026-10-22': 9 });
      expect(store.load()).toEqual({ '2026-10-22': 9 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
