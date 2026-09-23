import { describe, expect, it } from 'vitest';
import {
  AcpSessionCostLedger,
  buildAcpMeasuredContextEvent,
  parseAcpUsageUpdate,
} from './acp-usage-update';
import { toAcpCliUsage } from './acp-usage-estimator';

describe('parseAcpUsageUpdate', () => {
  it('reads the shape OpenCode sends', () => {
    expect(parseAcpUsageUpdate({
      sessionUpdate: 'usage_update',
      used: 7813,
      size: 200000,
      cost: { amount: 0, currency: 'USD' },
    })).toEqual({ used: 7813, size: 200000, sessionCostUsd: 0 });
  });

  it('tolerates a missing cost and ignores non-USD or invalid values', () => {
    expect(parseAcpUsageUpdate({ used: 10, size: 100 })).toEqual({ used: 10, size: 100 });
    expect(parseAcpUsageUpdate({ used: 10, size: 100, cost: { amount: 1, currency: 'EUR' } })).toEqual({ used: 10, size: 100 });
    expect(parseAcpUsageUpdate({ used: -1, size: 0, cost: { amount: Number.NaN } })).toEqual({});
    expect(parseAcpUsageUpdate(null)).toEqual({});
  });
});

describe('buildAcpMeasuredContextEvent', () => {
  it('carries the measured occupancy, not an aggregate', () => {
    expect(buildAcpMeasuredContextEvent({ used: 50_000, size: 200_000 }, 123_456)).toEqual({
      used: 50_000,
      total: 200_000,
      percentage: 25,
      cumulativeTokens: 123_456,
    });
  });

  it('caps the percentage and needs both used and size', () => {
    expect(buildAcpMeasuredContextEvent({ used: 300, size: 200 }, 0)?.percentage).toBe(100);
    expect(buildAcpMeasuredContextEvent({ used: 10 }, 0)).toBeNull();
    expect(buildAcpMeasuredContextEvent({ size: 10 }, 0)).toBeNull();
  });
});

describe('AcpSessionCostLedger', () => {
  it('turns the running session total into per-turn costs for a new session', () => {
    const ledger = new AcpSessionCostLedger();
    ledger.reset(true);
    ledger.observe(0.01, true);
    ledger.observe(0.02, true);
    expect(ledger.settleTurn()).toBeCloseTo(0.02);
    ledger.observe(0.05, true);
    expect(ledger.settleTurn()).toBeCloseTo(0.03);
  });

  it('reports no cost for a turn that saw no usage_update cost', () => {
    const ledger = new AcpSessionCostLedger();
    ledger.reset(true);
    expect(ledger.settleTurn()).toBeUndefined();
  });

  it('does not bill a resumed session history to its first turn', () => {
    const ledger = new AcpSessionCostLedger();
    ledger.reset(false);
    ledger.observe(4.0, true);
    expect(ledger.settleTurn()).toBeUndefined();
    ledger.observe(4.5, true);
    expect(ledger.settleTurn()).toBeCloseTo(0.5);
  });

  it('uses a total reported outside a turn (history replay) as the baseline', () => {
    const ledger = new AcpSessionCostLedger();
    ledger.reset(false);
    ledger.observe(4.0, false);
    ledger.observe(4.25, true);
    expect(ledger.settleTurn()).toBeCloseTo(0.25);
  });
});

describe('toAcpCliUsage with ACP usage extension fields', () => {
  it('maps cached-read and thought tokens onto CliUsage', () => {
    expect(toAcpCliUsage(
      { inputTokens: 104, outputTokens: 4, totalTokens: 7927, thoughtTokens: 11, cachedReadTokens: 7808 },
      1000,
      'prompt',
      'answer',
      '',
    )).toEqual({
      inputTokens: 104,
      outputTokens: 4,
      totalTokens: 7927,
      cacheReadTokens: 7808,
      reasoningTokens: 11,
      cost: undefined,
      duration: 1000,
    });
  });
});
