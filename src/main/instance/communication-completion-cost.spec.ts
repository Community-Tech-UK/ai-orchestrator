import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCompletionCost } from './communication-completion-cost';
import { getCostTracker } from '../core/system/cost-tracker';
import { CostPurposeSummaryService, getCostPurposeSummary } from '../core/system/cost-purpose-summary';
import {
  _resetCostAttributionForTesting,
  recordCostAttribution,
  subscribeCostAttribution,
  type CostAttributionRecord,
} from '../core/system/cost-attribution';
import type { Instance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { CacheAnalyticsService, getCacheAnalyticsService } from '../context/cache-analytics-service';

function chatInstance(): Instance {
  return {
    sessionId: 'completion-cost-fixture', provider: 'claude',
    currentModel: 'claude-opus-5', agentId: 'build', parentId: null,
    metadata: {}, contextUsage: { used: 0, total: 200000, percentage: 0 },
  } as unknown as Instance;
}

function machineInstance(): Instance {
  return {
    sessionId: 'completion-cost-fixture', provider: 'claude',
    currentModel: 'claude-opus-5', agentId: 'build', parentId: null,
    metadata: { planQueueRunId: 'run-1' }, contextUsage: { used: 0, total: 200000, percentage: 0 },
  } as unknown as Instance;
}

describe('recordCompletionCost per-turn booking', () => {
  let dir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup['AIO_COST_ATTRIBUTION'] = process.env['AIO_COST_ATTRIBUTION'];
    envBackup['AIO_COST_ATTRIBUTION_DIR'] = process.env['AIO_COST_ATTRIBUTION_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'completion-cost-'));
    process.env['AIO_COST_ATTRIBUTION_DIR'] = dir;
    delete process.env['AIO_COST_ATTRIBUTION'];
    _resetCostAttributionForTesting();
    CostPurposeSummaryService._resetForTesting();
    getCostTracker().clearEntries();
    CacheAnalyticsService._resetForTesting();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCostAttributionForTesting();
    CostPurposeSummaryService._resetForTesting();
    getCostTracker().clearEntries();
    rmSync(dir, { recursive: true, force: true });
  });

  function capture(fn: () => void): { rows: CostAttributionRecord[]; stop: () => void } {
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    fn();
    stop();
    return { rows, stop };
  }

  it('books a zero-cost turn record when a turn reports no usage at all (A#158)', () => {
    const instance = chatInstance();
    const response = { content: 'no usage reported' } as unknown as CliResponse;
    const { rows } = capture(() => recordCompletionCost('zero-usage-instance', instance, response));

    const entries = getCostTracker().getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cost).toBe(0);
    expect(entries[0]!.inputTokens).toBe(0);
    expect(entries[0]!.outputTokens).toBe(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('instance-turn');
    expect(rows[0]!.costKnown).toBe(false);
    expect(rows[0]!.costSource).toBe('unknown');
    expect(rows[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  });

  it('books a zero-cost turn record when usage is all zeros with no cost (A#158)', () => {
    const instance = chatInstance();
    const response = { content: 'quiet turn', usage: { input: 0, output: 0 } } as unknown as CliResponse;
    const { rows } = capture(() => recordCompletionCost('zero-tokens-instance', instance, response));

    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costKnown).toBe(false);
    expect(rows[0]!.costSource).toBe('unknown');
  });

  it('keeps a provider-reported zero cost known when booking the turn (A#158)', () => {
    const instance = chatInstance();
    const response = { content: 'free turn', usage: { input: 0, output: 0, cost: 0 } } as unknown as CliResponse;
    const { rows } = capture(() => recordCompletionCost('free-turn-instance', instance, response));

    const entries = getCostTracker().getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cost).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costKnown).toBe(true);
    expect(rows[0]!.costSource).toBe('provider');
    // The supplied $0 is preserved on the attribution row so the summary can
    // tell a known $0 call from an unknown-cost one.
    expect(rows[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 });
  });

  it('does not count a provider-reported zero-cost turn as an unknown-cost call in the summary', () => {
    const instance = chatInstance();
    const response = { content: 'free turn', usage: { input: 0, output: 0, cost: 0 } } as unknown as CliResponse;
    recordCompletionCost('free-turn-instance', instance, response);

    const summary = getCostPurposeSummary().getSummary();
    expect(summary.totals.calls).toBe(1);
    expect(summary.totals.cost).toBe(0);
    expect(summary.totals.unknownCostCalls).toBe(0);
    expect(summary.totals.freeCalls).toBe(0);
  });

  it('still counts a turn with no reported cost as an unknown-cost call in the summary', () => {
    const instance = chatInstance();
    const response = { content: 'no usage reported' } as unknown as CliResponse;
    recordCompletionCost('zero-usage-instance', instance, response);

    const summary = getCostPurposeSummary().getSummary();
    expect(summary.totals.calls).toBe(1);
    expect(summary.totals.unknownCostCalls).toBe(1);
    expect(summary.totals.cost).toBe(0);
  });

  it('keeps booking a measured turn with its cost and never books the cost twice', () => {
    const instance = chatInstance();
    const response = { content: 'priced turn', usage: { input: 100, output: 10, cost: 0.5 } } as unknown as CliResponse;
    const { rows } = capture(() => recordCompletionCost('paid-instance', instance, response));

    const entries = getCostTracker().getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cost).toBe(0.5);
    expect(entries[0]!.inputTokens).toBe(100);
    expect(instance.contextUsage.costEstimate).toBe(0.5);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.costKnown).toBe(true);
    expect(rows[0]!.costSource).toBe('provider');
    expect(rows[0]!.usage).toEqual(expect.objectContaining({ inputTokens: 100, outputTokens: 10, cost: 0.5 }));
  });

  it('tags the turn origin as user or machine on both per-turn records (A#185)', () => {
    const userResponse = { content: 'mine', usage: { input: 1, output: 1 } } as unknown as CliResponse;
    const machineResponse = { content: 'theirs', usage: { input: 1, output: 1 } } as unknown as CliResponse;
    const { rows } = capture(() => {
      recordCompletionCost('user-turn', chatInstance(), userResponse);
      recordCompletionCost('machine-turn', machineInstance(), machineResponse);
    });

    expect(rows.map((row) => row.origin)).toEqual(['user', 'machine']);
    const entries = getCostTracker().getEntries();
    expect(entries.find((entry) => entry.instanceId === 'user-turn')?.origin).toBe('user');
    expect(entries.find((entry) => entry.instanceId === 'machine-turn')?.origin).toBe('machine');
  });

  it('keeps the origin out of rows recorded without one', () => {
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution((row) => rows.push(row));
    recordCostAttribution({ source: 'instance-turn', purpose: 'chat', taskType: 'chat:build', usage: {}, costKnown: false });
    stop();
    expect(rows[0]!.origin).toBeUndefined();
  });

  it.each([undefined, 0, 0.25])('waits for deferred usage and books once under the captured identity (settled cost: %s)', (cost) => {
    const instance = machineInstance();
    const response: CliResponse = { id: 'deferred', role: 'assistant', content: '' };
    const settle = deferResponseUsage(response);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    let settledCalls = 0;
    try {
      recordCompletionCost('deferred-instance', instance, response, () => { settledCalls++; });
      expect(getCostTracker().getEntries()).toEqual([]);
      expect(rows).toEqual([]);
      instance.sessionId = 'later-session'; instance.provider = 'copilot'; instance.currentModel = 'later-model';
      instance.metadata = {}; instance.parentId = 'later-parent'; instance.agentId = 'later-agent';
      instance.contextUsage = { used: 0, total: 1000, percentage: 0, costEstimate: 1 };
      if (cost !== undefined) response.usage = { cost };
      settle(); settle();
      expect(getCostTracker().getEntries()).toHaveLength(1);
      expect(getCostTracker().getEntries()[0]).toMatchObject({ sessionId: 'completion-cost-fixture', model: 'claude-opus-5', cost: cost ?? 0, origin: 'machine' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: 'plan-queue', origin: 'machine', provider: 'claude', model: 'claude-opus-5', parentId: null, agentId: 'build',
        costKnown: cost !== undefined, costSource: cost === undefined ? 'unknown' : 'provider' });
      expect(settledCalls).toBe(1);
      expect(instance.contextUsage.costEstimate).toBe(1 + (cost ?? 0));
    } finally { stop(); }
  });

  it('retains measured cache samples across turns with no usage', () => {
    const instance = chatInstance();
    recordCompletionCost('cache-instance', instance, { id: 'measured', role: 'assistant', content: '', usage: { inputTokens: 10, cacheReadTokens: 90 } });
    recordCompletionCost('cache-instance', instance, { id: 'unmeasured', role: 'assistant', content: '' });
    expect(getCostTracker().getEntries()).toHaveLength(2);
    expect(getCacheAnalyticsService().getReport('cache-instance').samples).toHaveLength(1);
    expect(getCacheAnalyticsService().getReport('cache-instance').samples[0]).toMatchObject({ input: 10, cacheRead: 90, ratio: 0.9 });
  });
});
