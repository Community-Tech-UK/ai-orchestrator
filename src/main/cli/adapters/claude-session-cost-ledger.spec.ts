import { describe, it, expect } from 'vitest';
import { ClaudeSessionCostLedger } from './claude-session-cost-ledger';

describe('ClaudeSessionCostLedger', () => {
  it('differences rising totals and books a dropped counter from zero', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('fresh');
    expect(ledger.settle(0.5, 0.1)).toBe(0.5);
    expect(ledger.settle(1.25, 0.1)).toBe(0.75);
    expect(ledger.settle(0.2, 0.1)).toBe(0.2);
    expect(ledger.settle(0.2, 0)).toBe(0);
  });
  it.each(['fresh', 'fork'] as const)('%s books the first total despite a seed', mode => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn(mode, 10);
    expect(ledger.settle(11, 0.5)).toBe(11);
  });
  it('resumes a seeded running total and handles a reset below the seed', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('resume', 10);
    expect(ledger.settle(10.5, 0.5)).toBe(0.5);
    ledger.onSpawn('resume', 10);
    expect(ledger.settle(0.4, 0.4)).toBe(0.4);
  });
  it('detects a reset that rose above the seed but is too small to cover this turn', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('resume', 10);
    expect(ledger.settle(10.1, 0.5)).toBe(10.1);
  });
  it('omits an unseeded resumed first cost, then differences the next turn', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('resume');
    expect(ledger.settle(100, 0.5)).toBeUndefined();
    expect(ledger.settle(100.4, 0.4)).toBeCloseTo(0.4);
  });
  it.each([-1, NaN, Infinity])('ignores invalid total %s without changing the baseline', total => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('fresh');
    expect(ledger.settle(total, 0.1)).toBeUndefined();
    expect(ledger.settle(0.5, 0.1)).toBe(0.5);
  });
  it('differences cumulative model snapshots including side-model/subagent spend', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('resume', 10, { main: { inputTokens: 100, outputTokens: 20, costUSD: 8 },
      side: { inputTokens: 50, cacheReadInputTokens: 200, costUSD: 2 } });
    expect(ledger.settle(11, 0.5, { main: { inputTokens: 110, outputTokens: 25, costUSD: 8.5 },
      side: { inputTokens: 55, cacheReadInputTokens: 300, costUSD: 2.5 } })).toBe(1);
    expect(ledger.byModel).toEqual([
      { model: 'main', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
      { model: 'side', inputTokens: 5, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.5 },
    ]);
  });
  it('resets model differences with a session cost reset', () => {
    const ledger = new ClaudeSessionCostLedger();
    ledger.onSpawn('resume', 10, { main: { inputTokens: 100, costUSD: 10 } });
    ledger.settle(0.5, 0.5, { main: { inputTokens: 10, costUSD: 0.5 } });
    expect(ledger.byModel?.[0].inputTokens).toBe(10);
    expect(ledger.byModel?.[0].costUsd).toBe(0.5);
  });

});

describe('Claude cumulative dollar settlement', () => {
  it('books resident differences and handles falling counters', () => {
    const ledger = new ClaudeSessionCostLedger(); ledger.onSpawn('fresh');
    expect(ledger.settle(0.5, 0.1)).toBe(0.5); expect(ledger.settle(1.25, 0.1)).toBe(0.75); expect(ledger.settle(0.2, 0.1)).toBe(0.2);
  });
  it('does not book unknown resumed history; later turns still settle', () => {
    const ledger = new ClaudeSessionCostLedger(); ledger.onSpawn('resume');
    expect(ledger.settle(25, 0.1)).toBeUndefined(); expect(ledger.settle(25.2, 0.1)).toBeCloseTo(0.2);
  });
  it('uses a seeded resume unless the counter reset', () => {
    const ledger = new ClaudeSessionCostLedger(); ledger.onSpawn('resume', 3);
    expect(ledger.settle(3.4, 0.1)).toBeCloseTo(0.4);
    ledger.onSpawn('resume', 3); expect(ledger.settle(0.1, 0.1)).toBe(0.1);
    ledger.onSpawn('resume', 3); expect(ledger.settle(3.01, 0.1)).toBe(3.01);
  });
  it('ignores invalid totals without corrupting the baseline', () => {
    const ledger = new ClaudeSessionCostLedger(); ledger.onSpawn('fresh'); ledger.settle(0.5, 0);
    expect(ledger.settle(NaN, 0)).toBeUndefined(); expect(ledger.settle(-1, 0)).toBeUndefined(); expect(ledger.settle(0.6, 0)).toBeCloseTo(0.1);
  });
});
