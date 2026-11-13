import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostPurposeSummaryService, getCostPurposeSummary } from './cost-purpose-summary';
import { _resetCostAttributionForTesting, recordCostAttribution } from './cost-attribution';

const time = Date.parse('2026-10-10T12:00:00Z');
let directory: string;

function write(rows: object[]): void {
  fs.writeFileSync(join(directory, 'cost-attribution-2026-10-10.jsonl'),
    rows.map(row => JSON.stringify({ ts: time, ...row })).join('\n') + '\npartial');
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'cost-purpose-'));
  vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory);
  vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
  _resetCostAttributionForTesting();
  CostPurposeSummaryService._resetForTesting();
});

afterEach(() => {
  CostPurposeSummaryService._resetForTesting();
  _resetCostAttributionForTesting();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('CostPurposeSummaryService', () => {
  it('groups stable purposes and providers while separating priced, free, unknown, and legacy resident costs', () => {
    write([
      { source: 'one-shot', taskType: 'review-orchestration', provider: 'claude',
        usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40, cost: 1 }, costKnown: true },
      { source: 'one-shot', taskType: 'child:build', purpose: 'plan-queue', provider: 'claude',
        costSource: 'priced', usage: { cost: 2 } },
      { source: 'one-shot', taskType: 'repo-job', purpose: 'repo-job', provider: 'claude',
        costSource: 'unknown', outcome: 'error', usage: { inputTokens: 50 } },
      { source: 'one-shot', taskType: 'remote-node', purpose: 'remote-node', provider: 'ollama',
        costSource: 'free', usage: { cost: 0 } },
      { source: 'one-shot', taskType: 'quick-ask', purpose: 'quick-ask', provider: 'claude', costSource: 'unknown' },
      { source: 'instance-turn', taskType: 'chat:build', provider: 'claude',
        usage: { cost: 9, inputTokens: 100 }, costKnown: true },
      { source: 'instance-turn', taskType: 'chat:build', provider: 'claude',
        costSource: 'provider', usage: { cost: 0.25, inputTokens: 5 } },
      { source: 'auxiliary', taskType: 'aux:compression', provider: 'claude', auxiliarySpendReservationUsd: 1 },
      { source: 'one-shot', taskType: 'review', provider: 'claude', reviewLifecycle: 'verdict' },
      { source: 'one-shot', taskType: 'review', provider: 'claude', subagentUsage: true },
      { source: 'auxiliary', taskType: 'aux:compression', provider: 'local-fallback' },
      { source: 'auxiliary', taskType: 'aux:compression', provider: 'claude', auxRoutedTo: 'fallback' },
    ]);

    const summary = getCostPurposeSummary().getSummary({ startTime: time - 1, endTime: time + 1 });
    expect(summary.enabled).toBe(true);
    expect(summary.totals).toMatchObject({ calls: 7, inputTokens: 165, cacheReadTokens: 20,
      cacheWriteTokens: 30, outputTokens: 40, cost: 3.25, estimatedCost: 2,
      estimatedShare: 2 / 3.25, unknownCostCalls: 3, historicalCostUnknownCalls: 1, freeCalls: 1 });
    expect(summary.byPurpose.find(row => row.key === 'plan-queue')).toMatchObject({ calls: 1, cost: 2 });
    expect(summary.byPurpose.find(row => row.key === 'repo-job')).toMatchObject({ calls: 1, unknownCostCalls: 1 });
    expect(summary.byPurpose.find(row => row.key === 'remote-node')).toMatchObject({ calls: 1, freeCalls: 1 });
    expect(summary.byPurpose.find(row => row.key === 'quick-ask')).toMatchObject({ calls: 1, cost: 0, unknownCostCalls: 1 });
    expect(summary.byPurpose.find(row => row.key === 'chat')).toMatchObject({ calls: 2, cost: 0.25,
      historicalCostUnknownCalls: 1 });
    expect(summary.byProvider.find(row => row.key === 'claude')?.calls).toBe(6);
  });

  it('uses exact range filtering and refreshes its cache after a day file changes', () => {
    write([{ taskType: 'chat', usage: { cost: 1 } }]);
    const summary = getCostPurposeSummary();
    expect(summary.getSummary({ startTime: time - 1, endTime: time + 1 }).totals.cost).toBe(1);
    expect(summary.getSummary({ startTime: time + 1, endTime: time + 2 }).totals.calls).toBe(0);
    write([{ taskType: 'chat', usage: { cost: 1 } }, { taskType: 'child', usage: { cost: 2 } }]);
    expect(summary.getSummary({ startTime: time - 1, endTime: time + 1 }).totals.cost).toBe(3);
  });

  it('refreshes after live append and respects the opt-out', () => {
    const summary = getCostPurposeSummary();
    expect(summary.getSummary().totals.calls).toBe(0);
    recordCostAttribution({ source: 'one-shot', taskType: 'verify', provider: 'claude',
      costSource: 'provider', usage: { cost: 0.5 } });
    expect(summary.getSummary().totals.cost).toBe(0.5);
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    expect(summary.getSummary().enabled).toBe(false);
  });

  it('shows helper spend in the breakdown without adding it to totals', () => {
    write([
      { source: 'instance-turn', taskType: 'chat:main', provider: 'claude', purpose: 'chat',
        costSource: 'provider', usage: { cost: 1 } },
      { source: 'instance-turn', taskType: 'claude-subagent-final', provider: 'claude', purpose: 'subagent',
        costSource: 'unknown', costKnown: false, subagentUsage: true, includedInParentTurn: true,
        toolUseId: 'toolu_1', helperTranscriptCost: 0.5,
        helperTranscriptUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, cacheWrite5mTokens: 1, cacheWrite1hTokens: 1 } },
      { source: 'instance-turn', taskType: 'claude-subagent-final', provider: 'claude', purpose: 'subagent',
        costSource: 'unknown', costKnown: false, subagentUsage: true, includedInParentTurn: true,
        toolUseId: 'toolu_2', helperTranscriptCost: 0.25 },
    ]);
    const summary = getCostPurposeSummary().getSummary({ startTime: time - 1, endTime: time + 1 });
    expect(summary.totalHelperCost).toBe(0.75);
    expect(summary.totals.helperCost).toBe(0.75);
    expect(summary.totals.cost).toBe(1);
    expect(summary.totals.calls).toBe(1);
    const helperRow = summary.byPurpose.find(row => row.key === 'subagent');
    expect(helperRow?.helperCost).toBe(0.75);
    expect(helperRow?.cost).toBe(0);
    expect(helperRow?.calls).toBe(0);
    const chatRow = summary.byPurpose.find(row => row.key === 'chat');
    expect(chatRow?.cost).toBe(1);
    expect(chatRow?.helperCost).toBe(0);
    expect(summary.byProvider.find(row => row.key === 'claude')?.helperCost).toBe(0.75);
    expect(summary.byProvider.find(row => row.key === 'claude')?.cost).toBe(1);
  });

  it('still counts a helper row that books its cost through usage', () => {
    write([
      { source: 'instance-turn', taskType: 'claude-subagent-final', provider: 'claude', purpose: 'subagent',
        costSource: 'unknown', costKnown: false, subagentUsage: true, includedInParentTurn: true,
        toolUseId: 'toolu_3', usage: { cost: 0.4 } },
    ]);
    const summary = getCostPurposeSummary().getSummary({ startTime: time - 1, endTime: time + 1 });
    expect(summary.totalHelperCost).toBe(0.4);
    expect(summary.totals.cost).toBe(0);
  });
});
