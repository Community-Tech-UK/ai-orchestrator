import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { latestTurnShares } from '../../../core/system/session-policy-log';
import { CodexTurnCeilingController, CODEX_TURN_WRAP_UP_TEXT, COMMAND_MODE_NOTICE, type CodexMeasureMode } from './codex-turn-ceiling-controller';

const M = 1_000_000;

interface Deferred { resolve(value: boolean): void; reject(error: Error): void }

function setup(kind: SessionKind = 'plan-queue') {
  let cumulative = 0;
  /** The root thread the host reports; a replacement changes it. */
  const thread = { id: 'thread-1' };
  const shares: SessionTurnShareRecord[] = [];
  const notices: { content: string; metadata: Record<string, unknown> }[] = [];
  const wrapUps: Deferred[] = [];
  let stops = 0;
  const controller = new CodexTurnCeilingController({
    sessionKind: () => kind,
    trial: () => ({ arm: 'cheaper', key: 'trial-key' }),
    threadId: () => thread.id,
    instanceId: () => 'instance-1',
    cumulativeTokens: () => cumulative,
    deliverWrapUp: () => new Promise<boolean>((resolve, reject) => { wrapUps.push({ resolve, reject }); }),
    requestStop: () => { stops += 1; },
    emitSystem: (content, metadata) => { notices.push({ content, metadata }); },
    publishShare: (record) => { shares.push(record); },
    readSettings: () => undefined,
  });
  /** Books `tokens` the way a usage-accounting call would, then lets the controller see them. */
  const book = (tokens: number, options: { helper?: boolean; mode?: CodexMeasureMode; turnId?: string } = {}) =>
    controller.measure(options.helper ?? false, () => { cumulative += tokens; }, options.mode ?? 'live', options.turnId);
  return { controller, book, shares, notices, wrapUps, thread, stops: () => stops };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('wrap-up requests are bound to their round (review points 1 and 2)', () => {
  it('ignores a late answer from an earlier round and lets the new round ask for its own', async () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(150 * M);
    expect(h.wrapUps).toHaveLength(1);

    h.controller.beginTurn('turn-b');
    h.book(150 * M);
    expect(h.wrapUps).toHaveLength(2);

    h.wrapUps[0]!.resolve(true); // the old round's request finally succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(h.notices).toHaveLength(0);

    h.wrapUps[1]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.metadata).toMatchObject({ stage: 'wrap-up', thresholdTokens: 150 * M });
    h.book(1);
    expect(h.wrapUps).toHaveLength(2);
  });

  it('runs one request at a time and still retries after it fails', async () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(150 * M);
    for (let sample = 0; sample < 6; sample += 1) h.book(1);
    expect(h.wrapUps).toHaveLength(1);

    h.wrapUps[0]!.reject(new Error('transport hiccup'));
    await vi.advanceTimersByTimeAsync(0);
    h.book(1);
    expect(h.wrapUps).toHaveLength(2);
    h.wrapUps[1]!.resolve(false); // no live turn to steer
    await vi.advanceTimersByTimeAsync(0);
    h.book(1);
    expect(h.wrapUps).toHaveLength(3);
    h.wrapUps[2]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.notices).toHaveLength(1);
    h.book(1);
    expect(h.wrapUps).toHaveLength(3);
  });

  it('sends the wrap-up as an automated note that names the instruction and not the user', () => {
    expect(CODEX_TURN_WRAP_UP_TEXT).toContain('Wrap up now: report what is done and what is left.');
    expect(CODEX_TURN_WRAP_UP_TEXT).toContain('not a message from the user');
  });
});

describe('late bookkeeping only counts (review point 3)', () => {
  it('does not enforce again after the latest round finished, even if a caller labels its receipt live', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(10 * M);
    h.controller.finishTurn('turn-a');
    h.book(310 * M, { helper: true, mode: 'live', turnId: 'turn-a' });
    h.controller.flush();
    expect(h.stops()).toBe(0);
    expect(h.wrapUps).toHaveLength(0);
    expect(h.shares.at(-1)).toMatchObject({ turnId: 'turn-a', helperTokens: 310 * M, stopRequested: false });
  });

  it('never stops or steers a round, and the record does not claim a stop', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(10 * M);
    h.book(400 * M, { mode: 'late' });
    expect(h.stops()).toBe(0);
    expect(h.wrapUps).toHaveLength(0);
    h.controller.finishTurn('turn-a');
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ rootTokens: 410 * M, stopRequested: false, wrapUpDelivered: false });
  });

  it('records a stop only when a live sample actually asked for one', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(310 * M);
    expect(h.stops()).toBe(1);
    expect(h.controller.consumeStop()?.message).toBe('Stopped by Harness: this turn passed 300M tokens.');
    h.controller.finishTurn('turn-a');
    expect(h.shares[0]).toMatchObject({ stopRequested: true });
  });
});

describe('late receipts correct the round they belong to (review point 7)', () => {
  it('writes the share once the round finishes, then corrects it once when a child receipt arrives late', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(100 * M);
    h.controller.finishTurn('turn-a');
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({
      event: 'turn-share', threadId: 'thread-1', turnId: 'turn-a', revision: 0, instanceId: 'instance-1',
      sessionKind: 'plan-queue', rootTokens: 100 * M, helperTokens: 0, helperShare: 0, armKey: 'trial-key',
    });

    h.book(50 * M, { helper: true, mode: 'late', turnId: 'turn-a' });
    h.book(10 * M, { helper: true, mode: 'late', turnId: 'turn-a' });
    expect(h.shares).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(h.shares).toHaveLength(2);
    expect(h.shares[1]).toMatchObject({ revision: 1, rootTokens: 100 * M, helperTokens: 60 * M, totalTokens: 160 * M });
    expect(h.shares[1]!.helperShare).toBeCloseTo(60 / 160, 5);

    // Nothing changed since: no further writes, however often the round is finished again.
    h.controller.finishTurn('turn-a');
    vi.advanceTimersByTime(10_000);
    expect(h.shares).toHaveLength(2);
  });

  it('attributes a receipt that arrives after the next round began to the round it belongs to', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(100 * M);
    h.controller.finishTurn('turn-a');
    h.controller.beginTurn('turn-b');
    h.book(20 * M);

    h.book(30 * M, { helper: true, mode: 'late', turnId: 'turn-a' });
    vi.advanceTimersByTime(3_000);
    h.controller.finishTurn('turn-b');

    const byTurn = latestTurnShares(h.shares.map((record, index) => ({ ...record, at: index })));
    expect(byTurn.find((record) => record.turnId === 'turn-a')).toMatchObject({ revision: 1, rootTokens: 100 * M, helperTokens: 30 * M });
    expect(byTurn.find((record) => record.turnId === 'turn-b')).toMatchObject({ revision: 0, rootTokens: 20 * M, helperTokens: 0 });
  });

  it('does not restart a round when its start is announced twice', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(70 * M);
    h.controller.beginTurn('turn-a');
    h.book(5 * M);
    expect(h.shares).toHaveLength(0);
    h.controller.finishTurn('turn-a');
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ turnId: 'turn-a', revision: 0, rootTokens: 75 * M });
  });

  it('writes a round the next round replaced before it was finished', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(70 * M);
    h.controller.beginTurn('turn-b');
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ turnId: 'turn-a', revision: 0, rootTokens: 70 * M });
    h.controller.finishTurn('turn-a'); // the late reconciliation for turn-a changes nothing
    expect(h.shares).toHaveLength(1);
  });

  it('bounds the corrections for one round', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(10 * M);
    h.controller.finishTurn('turn-a');
    for (let correction = 0; correction < 8; correction += 1) {
      h.book(M, { mode: 'late', turnId: 'turn-a' });
      vi.advanceTimersByTime(3_000);
    }
    expect(h.shares.map((record) => record.revision)).toEqual([0, 1, 2, 3]);
  });

  it('writes pending corrections at shutdown instead of losing them', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(10 * M);
    h.controller.finishTurn('turn-a');
    h.book(5 * M, { helper: true, mode: 'late', turnId: 'turn-a' });
    h.controller.beginTurn('turn-b');
    h.book(7 * M);
    h.controller.flush();
    expect(h.shares.map((record) => [record.turnId, record.revision, record.totalTokens])).toEqual([
      ['turn-a', 0, 10 * M], ['turn-a', 1, 15 * M], ['turn-b', 0, 7 * M],
    ]);
  });

  it('writes a round under the thread it ran on even when the thread was replaced before the write', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(10 * M);
    h.controller.finishTurn('turn-a');
    h.thread.id = 'thread-2';
    // A late receipt for the first round, after its root thread was replaced.
    h.book(5 * M, { helper: true, mode: 'late', turnId: 'turn-a' });
    h.controller.beginTurn('turn-b');
    h.book(7 * M);
    h.controller.finishTurn('turn-b');
    expect(h.shares.map((record) => [record.threadId, record.turnId, record.revision, record.totalTokens])).toEqual([
      ['thread-1', 'turn-a', 0, 10 * M], ['thread-1', 'turn-a', 1, 15 * M], ['thread-2', 'turn-b', 0, 7 * M],
    ]);
  });

  it('writes a round the replacement overtook before it was finished under its own thread', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.book(70 * M);
    h.thread.id = 'thread-2';
    h.controller.beginTurn('turn-b');
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ threadId: 'thread-1', turnId: 'turn-a', rootTokens: 70 * M });
  });

  it('writes nothing for a round that spent nothing', () => {
    const h = setup();
    h.controller.beginTurn('turn-a');
    h.controller.finishTurn('turn-a');
    h.controller.flush();
    expect(h.shares).toHaveLength(0);
  });
});

describe('session-policy readers keep the latest receipt per thread and turn', () => {
  it('prefers the higher revision and, on a tie, the later write', () => {
    const base = { threadId: 't', turnId: 'x' } as const;
    const rows = [
      { ...base, revision: 1, at: 5, tag: 'rev1' },
      { ...base, revision: 0, at: 9, tag: 'rev0-late' },
      { ...base, turnId: 'y', revision: 0, at: 1, tag: 'other' },
      { ...base, revision: 1, at: 6, tag: 'rev1-again' },
    ];
    expect(latestTurnShares(rows).map((row) => row.tag).sort()).toEqual(['other', 'rev1-again']);
  });
});

describe('saying that command mode cannot honour the ceiling', () => {
  const controllerWith = (emitSystem: (content: string) => void, kind: SessionKind = 'plan-queue') => new CodexTurnCeilingController({
    sessionKind: () => kind, trial: () => ({}), threadId: () => 'thread-1', cumulativeTokens: () => 0,
    deliverWrapUp: async () => false, requestStop: () => undefined, emitSystem, publishShare: () => undefined, readSettings: () => undefined,
  });

  it('never lets a failing notice break the send it comes before, and says it only once', () => {
    const emitted: string[] = [];
    const controller = controllerWith((content) => { emitted.push(content); throw new Error('a listener bug'); });
    expect(() => controller.noteCommandMode(true)).not.toThrow();
    expect(() => controller.noteCommandMode(true)).not.toThrow();
    expect(emitted).toEqual([COMMAND_MODE_NOTICE]);
  });

  it('stays quiet in the transcript for a chat, which is never stopped', () => {
    const emitted: string[] = [];
    controllerWith((content) => { emitted.push(content); }, 'chat').noteCommandMode(false);
    expect(emitted).toEqual([]);
  });
});
