import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { CodexTurnCeilingController } from './codex-turn-ceiling-controller';
import { CodexTurnUsageOwner } from './codex-turn-usage-owner';
import { CodexUsageAccounting } from './usage-accounting';

function setup() {
  const accounting = new CodexUsageAccounting();
  const shares: SessionTurnShareRecord[] = [];
  const requestStop = vi.fn();
  const deliverWrapUp = vi.fn(async () => true);
  const emitSystem = vi.fn();
  const controller = new CodexTurnCeilingController({
    sessionKind: () => 'plan-queue', trial: () => ({}), threadId: () => 'root',
    cumulativeTokens: () => accounting.cumulativeTokens,
    requestStop, deliverWrapUp, emitSystem, publishShare: row => shares.push(row),
    readSettings: () => ({ codexTurnCeilingHarnessWorkWrapUpTokens: 150, codexTurnCeilingHarnessWorkStopTokens: 300 }),
  });
  const owner = new CodexTurnUsageOwner(controller, () => 'root', () => accounting.cumulativeTokens);
  const totals = new Map<string, number>();
  const book = (threadId: string, delta: number, turnId: string) => {
    const total = (totals.get(threadId) ?? 0) + delta;
    totals.set(threadId, total);
    owner.measure(threadId, () => accounting.observe(threadId, { inputTokens: total, outputTokens: 0, totalTokens: total }), 'live', turnId);
  };
  const collab = (threadId: string, turnId: string, child: string, tool = 'spawnAgent') => owner.trackItemChildren(null, {
    threadId, turnId, item: { type: 'collabAgentToolCall', tool, receiverThreadIds: [child] },
  }, accounting);
  const activity = (threadId: string, turnId: string | undefined, child: string, kind = 'started') => owner.trackItemChildren(null, {
    threadId, turnId, item: { type: 'subAgentActivity', id: `activity-${child}`, kind, agentThreadId: child, agentPath: `/root/${child}`, model: null, reasoningEffort: null },
  }, accounting);
  owner.beginRoot('root-1');
  return { owner, controller, accounting, shares, requestStop, deliverWrapUp, emitSystem, book, collab, activity };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('delayed authoritative helper ownership', () => {
  it('stops immediately on confirmation alone and books provider spend only once', () => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 310, 'child-1');
    expect(h.accounting.cumulativeTokens).toBe(310);
    expect(h.requestStop).not.toHaveBeenCalled();
    h.collab('root', 'root-1', 'child');
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    h.collab('root', 'root-1', 'child');
    h.controller.finishTurn('root-1');
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    expect(h.accounting.cumulativeTokens).toBe(310);
    expect(h.shares.at(-1)).toMatchObject({ turnId: 'root-1', helperTokens: 310, stopRequested: true });
  });

  it('attributes all buffered descendants before evaluating once, without an intermediate wrap-up', () => {
    const h = setup();
    const evaluate = vi.spyOn(h.controller, 'evaluateLiveTurn');
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.owner.discoverHelper('nested', 'child', 'child-1');
    h.owner.beginHelperTurn('nested', 'nested-1');
    h.book('child', 160, 'child-1');
    h.book('nested', 160, 'nested-1');
    h.collab('root', 'root-1', 'child');
    expect(evaluate).toHaveBeenCalledExactlyOnceWith('root-1');
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    expect(h.deliverWrapUp).not.toHaveBeenCalled();
    expect(h.emitSystem).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ stoppedByHarness: expect.objectContaining({ tokens: 320 }) }));
    h.controller.finishTurn('root-1');
    expect(h.shares.at(-1)).toMatchObject({ helperTokens: 320, stopRequested: true });
  });

  it('wraps up once when confirmation alone crosses only the wrap-up threshold', async () => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 160, 'child-1');
    h.collab('root', 'root-1', 'child');
    expect(h.deliverWrapUp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    h.collab('root', 'root-1', 'child');
    expect(h.deliverWrapUp).toHaveBeenCalledTimes(1);
    expect(h.requestStop).not.toHaveBeenCalled();
  });

  it.each([false, true])('only corrects a retired owner after a newer root starts (newer root finished: %s)', finished => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 310, 'child-1');
    h.controller.finishTurn('root-1');
    h.owner.beginRoot('root-2');
    h.book('root', 10, 'root-2');
    if (finished) h.controller.finishTurn('root-2');
    h.collab('root', 'root-1', 'child');
    h.controller.flush();
    expect(h.requestStop).not.toHaveBeenCalled();
    expect(h.deliverWrapUp).not.toHaveBeenCalled();
    expect(h.shares.filter(row => row.turnId === 'root-1').at(-1)).toMatchObject({ helperTokens: 310, stopRequested: false });
    expect(h.shares.filter(row => row.turnId === 'root-2').at(-1)).toMatchObject({ rootTokens: 10, helperTokens: 0 });
  });

  it('only corrects the latest root after it finishes, even though the owner remembers its id', () => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 310, 'child-1');
    h.controller.finishTurn('root-1');
    h.collab('root', 'root-1', 'child');
    h.controller.flush();
    expect(h.requestStop).not.toHaveBeenCalled();
    expect(h.deliverWrapUp).not.toHaveBeenCalled();
    expect(h.shares.at(-1)).toMatchObject({ helperTokens: 310, stopRequested: false });
  });
});

describe('authoritative started activity without a collaboration receipt', () => {
  it('confirms already buffered spend and preserves the native helper turn binding', () => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 310, 'child-1');
    h.activity('root', 'root-1', 'child');
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    h.controller.finishTurn('root-1');
    h.owner.beginRoot('root-2');
    h.collab('root', 'root-2', 'child', 'sendInput');
    h.owner.beginHelperTurn('child', 'child-2');
    h.book('child', 10, 'child-1');
    h.controller.flush();
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    expect(h.shares.filter(row => row.turnId === 'root-1').at(-1)).toMatchObject({ helperTokens: 320 });
  });

  it('resolves a nested helper when its parent ownership is discovered later', () => {
    const h = setup();
    h.owner.trackHelper('child');
    h.accounting.trackThread('child');
    h.owner.beginHelperTurn('child', 'child-1');
    h.activity('child', 'child-1', 'nested');
    h.owner.beginHelperTurn('nested', 'nested-1');
    h.book('nested', 310, 'nested-1');
    expect(h.requestStop).not.toHaveBeenCalled();
    h.activity('root', 'root-1', 'child');
    expect(h.requestStop).toHaveBeenCalledTimes(1);
    h.controller.finishTurn('root-1');
    expect(h.shares.at(-1)).toMatchObject({ helperTokens: 310 });
  });

  it.each(['child-1', 'child-2'])('uses native parent turn %s when a reused helper confirms a nested spawn', parentTurnId => {
    const h = setup();
    h.activity('root', 'root-1', 'child');
    h.owner.beginHelperTurn('child', 'child-1');
    h.controller.finishTurn('root-1');
    h.owner.beginRoot('root-2');
    h.collab('root', 'root-2', 'child', 'sendInput');
    h.owner.beginHelperTurn('child', 'child-2');
    h.owner.discoverHelper('nested', 'child');
    h.owner.beginHelperTurn('nested', 'nested-1');
    h.book('nested', 310, 'nested-1');
    h.activity('child', parentTurnId, 'nested');
    h.controller.flush();
    expect(h.requestStop).toHaveBeenCalledTimes(parentTurnId === 'child-2' ? 1 : 0);
    expect(h.deliverWrapUp).not.toHaveBeenCalled();
    const rootTurnId = parentTurnId === 'child-2' ? 'root-2' : 'root-1';
    expect(h.shares.filter(row => row.turnId === rootTurnId).at(-1)).toMatchObject({ helperTokens: 310 });
  });

  it.each(['interacted', 'interrupted', 'completed', 'wait'])('does not transfer old work on %s activity in a newer root', kind => {
    const h = setup();
    h.collab('root', 'root-1', 'child');
    h.owner.beginHelperTurn('child', 'child-1');
    h.controller.finishTurn('root-1');
    h.owner.beginRoot('root-2');
    if (kind === 'wait') h.collab('root', 'root-2', 'child', 'wait');
    else h.activity('root', 'root-2', 'child', kind);
    h.book('child', 310, 'child-1');
    h.controller.flush();
    expect(h.requestStop).not.toHaveBeenCalled();
    expect(h.deliverWrapUp).not.toHaveBeenCalled();
    expect(h.shares.at(-1)).toMatchObject({ turnId: 'root-1', helperTokens: 310 });
  });

  it('leaves parent-thread-only and started activity without a parent turn ambiguous', () => {
    const h = setup();
    h.owner.discoverHelper('child', 'root');
    h.activity('root', undefined, 'child');
    h.owner.beginHelperTurn('child', 'child-1');
    h.book('child', 310, 'child-1');
    h.controller.finishTurn('root-1');
    expect(h.requestStop).not.toHaveBeenCalled();
    expect(h.shares).toEqual([]);
    expect(h.accounting.cumulativeTokens).toBe(310);
  });
});
