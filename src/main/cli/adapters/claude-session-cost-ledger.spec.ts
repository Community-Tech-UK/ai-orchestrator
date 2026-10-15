import { describe, expect, it } from 'vitest';
import { ClaudeSessionCostLedger } from './claude-session-cost-ledger';
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
