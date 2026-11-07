import { describe, expect, it } from 'vitest';
import { CostTracker } from './cost-tracker';
describe('cost summaries with helper models and credits', () => {
  it('uses child models once while retaining parent main-thread totals and session identity', () => {
    const tracker = new CostTracker();
    tracker.recordUsage('live', 'session', 'main', 10, 5, 0, 0, 0.5, 0, false, { byModel: [
      { model: 'main', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
      { model: 'helper', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3 },
    ] });
    const summary = tracker.getSummary();
    expect(summary.byModel['helper'].cost).toBe(0.3);
    expect(summary.byModel['main'].cost).toBe(0.2);
    expect(summary.bySession['session']).toMatchObject({ instanceId: 'live', cost: 0.5, requests: 1 });
    expect(summary.totalInputTokens).toBe(10);
  });
  it('keeps legacy rows and sums credits per model and session', () => {
    const tracker = new CostTracker();
    const entry = tracker.recordUsage('i', 's', 'gpt', 10, 5, 0, 0, 0);
    tracker.attachProviderCredits(entry.id, { creditsNano: 2e9, premiumRequests: 1, checkpointEventId: 'checkpoint', checkpointTotalNano: 5e9 });
    expect(tracker.getSummary()).toMatchObject({ totalAiCreditsNano: 2e9,
      byModel: { gpt: { aiCreditsNano: 2e9, inputTokens: 10 } }, bySession: { s: { aiCreditsNano: 2e9 } } });
  });
  it('retains known dollars when another call of the same model has no price', () => {
    const tracker = new CostTracker();
    tracker.recordUsage('i', 's', 'main', 10, 5, 0, 0, 0.5, 0, false, { byModel: [
      { model: 'helper', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
    ] });
    tracker.recordUsage('i', 's', 'main', 10, 5, 0, 0, 0, 0, false, { byModel: [
      { model: 'helper', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ] });
    expect(tracker.getSummary().byModel['helper']).toMatchObject({ cost: 0.5, hasUnknownCost: true, requests: 2 });
  });
});
