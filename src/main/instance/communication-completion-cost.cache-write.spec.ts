import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheAnalyticsService } from '../context/cache-analytics-service';
import { recordCompletionCost } from './communication-completion-cost';
import { createInstance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';

const mocks = vi.hoisted(() => ({ record: vi.fn(() => ({ id: 'entry', cost: 0 })) }));
vi.mock('../core/system/copilot-credit-recorder', () => ({ getCopilotCreditRecorder: () => ({ bookAfterTurn: vi.fn() }) }));
vi.mock('../context/instance-cache-usage', () => ({ instanceCacheTtlMs: () => 300_000 }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: mocks.record }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: vi.fn() }));

describe('completed write-only prompt accounting', () => {
  beforeEach(() => { CacheAnalyticsService._resetForTesting(); vi.clearAllMocks(); });
  const instance = () => ({ ...createInstance({ workingDirectory: '/tmp/example', provider: 'copilot' }), currentModel: 'sonnet' });
  const response = (usage: CliResponse['usage']): CliResponse => ({ id: 'result', role: 'assistant', content: '', usage });

  it('records positive writes through the completion hook without changing billing input', () => {
    const session = instance();
    recordCompletionCost(session.id, session, response({ inputTokens: 0, cacheReadTokens: 100_000 }));
    recordCompletionCost(session.id, session, response({ inputTokens: 0, cacheWriteTokens: 100_000 }));
    const report = CacheAnalyticsService.getInstance().getReport(session.id);
    expect(report).toMatchObject({ rewriteTokens: 100_000, rewriteIsEstimated: true, lastBreak: { missedTokens: 100_000 } });
    expect(report.samples).toHaveLength(2);
    expect(report.samples[1]).toMatchObject({ input: 0, cacheRead: 0, cacheWrite: 100_000, ratio: 0 });
    expect(Number.isFinite(report.samples[1].ratio)).toBe(true);
    expect(mocks.record.mock.calls.at(-1)?.slice(3, 7)).toEqual([0, 0, 0, 100_000]);
  });

  it('uses the previous prompt and current writes as the bounds', () => {
    const service = CacheAnalyticsService.getInstance();
    service.recordTurn('i', { input: 0, cacheRead: 100_000, cacheWrite: 0, model: 'sonnet' });
    service.recordTurn('i', { input: 0, cacheRead: 0, cacheWrite: 30_000, model: 'sonnet' });
    service.recordTurn('i', { input: 0, cacheRead: 0, cacheWrite: 200_000, model: 'sonnet' });
    expect(service.getReport('i').rewriteTokens).toBe(60_000);
  });

  it('keeps a first write-only baseline and separates expected compaction rewrites', () => {
    const service = CacheAnalyticsService.getInstance();
    const turn = { input: 0, cacheRead: 0, cacheWrite: 100_000, model: 'sonnet' };
    service.recordTurn('i', turn);
    expect(service.getReport('i')).toMatchObject({ rewriteTokens: 0, samples: [{ ratio: 0 }] });
    service.resetBaseline('i'); service.recordTurn('i', turn);
    expect(service.getReport('i')).toMatchObject({ rewriteTokens: 0, expectedRewriteTokens: 100_000,
      lastBreak: { cause: 'after compaction' } });
  });

  it('ignores genuinely empty usage and estimated or Claude completions', () => {
    const session = instance();
    for (const usage of [{ inputTokens: 0, outputTokens: 10 }, { cacheWriteTokens: 100_000, isEstimated: true }]) {
      recordCompletionCost(session.id, session, response(usage));
    }
    recordCompletionCost(session.id, { ...session, provider: 'claude' }, response({ cacheWriteTokens: 100_000 }));
    expect(CacheAnalyticsService.getInstance().getReport(session.id).samples).toEqual([]);
  });

  it('normalizes negative parts and ignores all-zero turns', () => {
    const service = CacheAnalyticsService.getInstance();
    service.recordTurn('i', { input: -1, cacheRead: -2, cacheWrite: -3 });
    expect(service.getReport('i').samples).toEqual([]);
    service.recordTurn('i', { input: -1, cacheRead: -2, cacheWrite: 5_000 });
    expect(service.getReport('i').samples).toMatchObject([{ input: 0, cacheRead: 0, cacheWrite: 5_000, ratio: 0 }]);
  });
});
