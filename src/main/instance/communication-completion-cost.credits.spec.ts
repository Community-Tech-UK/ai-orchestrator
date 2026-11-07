import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCompletionCost } from './communication-completion-cost';
import type { Instance } from '../../shared/types/instance.types';
const mocks = vi.hoisted(() => ({ book: vi.fn(), record: vi.fn(() => ({ id: 'entry', cost: 0 })) }));
vi.mock('../core/system/copilot-credit-recorder', () => ({ getCopilotCreditRecorder: () => ({ bookAfterTurn: mocks.book }) }));
vi.mock('../context/instance-cache-usage', () => ({ instanceCacheTtlMs: () => undefined }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: mocks.record }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: vi.fn() }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
describe('completion credit accounting hook', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([undefined, { inputTokens: 0, outputTokens: 0 }, { inputTokens: 10, outputTokens: 2 }])('records Copilot once for usage %j', usage => {
    const instance = { id: 'i', sessionId: 's', provider: 'copilot', metadata: {}, contextUsage: {} } as Instance;
    recordCompletionCost('i', instance, { id: 'r', role: 'assistant', content: '', usage });
    expect(mocks.book).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'copilot', sessionId: 's' }), 'entry');
  });
  it('does not attempt to record Copilot credits for Claude completions', () => {
    recordCompletionCost('i', { id: 'i', sessionId: 's', provider: 'claude', metadata: {}, contextUsage: {} } as Instance,
      { id: 'r', role: 'assistant', content: '', usage: { inputTokens: 10, outputTokens: 2 } });
    expect(mocks.book).not.toHaveBeenCalled();
  });
});
