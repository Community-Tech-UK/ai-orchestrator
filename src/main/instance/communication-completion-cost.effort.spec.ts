import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import type { Instance } from '../../shared/types/instance.types';
import { getCostTracker } from '../core/system/cost-tracker';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { captureCompletionCostIdentity, recordCompletionCost } from './communication-completion-cost';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';

vi.mock('../context/cache-analytics-service', () => ({
  getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }),
}));

function instanceWith(overrides: Partial<Instance> = {}): Instance {
  return {
    sessionId: 'claude-session-1',
    provider: 'claude',
    currentModel: CLAUDE_MODELS.OPUS,
    agentId: 'build',
    parentId: null,
    metadata: {},
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    ...overrides,
  } as unknown as Instance;
}

const response = {
  id: 'r1',
  content: 'done',
  role: 'assistant',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5_000, cacheWriteTokens: 300 },
} as unknown as CliResponse;

describe('turn records carry the session and effort setting', () => {
  const rows: CostAttributionRecord[] = [];
  let stop: () => void;

  beforeEach(() => {
    getCostTracker().clearEntries();
    rows.length = 0;
    stop = subscribeCostAttribution((row) => rows.push(row));
  });
  afterEach(() => stop());

  it('records the Claude session id and the effort the turn ran at', () => {
    recordCompletionCost('inst-1', instanceWith({ reasoningEffort: 'max' }), response);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: 'inst-1', sessionId: 'claude-session-1', reasoningEffort: 'max' });
  });

  it('leaves the effort out when the session never chose one', () => {
    recordCompletionCost('inst-1', instanceWith({ reasoningEffort: undefined }), response);
    expect(rows[0]).not.toHaveProperty('reasoningEffort');
    expect(rows[0]).toMatchObject({ sessionId: 'claude-session-1' });
  });

  it('uses the captured completion effort, not a later change', () => {
    const instance = instanceWith({ reasoningEffort: 'high' });
    const identity = captureCompletionCostIdentity(instance);
    instance.reasoningEffort = 'max';
    recordCompletionCost('inst-1', instance, response, undefined, identity);
    expect(rows[0]).toMatchObject({ reasoningEffort: 'high' });
  });

  it.each([false, true])('keeps completion identity through deferred usage (explicit capture: %s)', (explicit) => {
    const metadata = { spendPurpose: 'automation' };
    const instance = instanceWith({ reasoningEffort: 'high', metadata });
    const pendingResponse: CliResponse = { id: 'deferred', content: '', role: 'assistant' };
    const settle = deferResponseUsage(pendingResponse);
    const settled = vi.fn();
    const identity = explicit ? captureCompletionCostIdentity(instance) : undefined;
    recordCompletionCost('inst-1', instance, pendingResponse, settled, identity);
    expect(rows).toHaveLength(0);
    expect(getCostTracker().getEntries()).toHaveLength(0);

    // A later session/setting change must not relabel the completed turn's eventual usage.
    instance.sessionId = 'later-session';
    instance.provider = 'codex';
    instance.currentModel = 'later-model';
    instance.reasoningEffort = 'max';
    instance.parentId = 'later-parent';
    instance.agentId = 'later-agent';
    metadata.spendPurpose = 'channel';
    pendingResponse.usage = { inputTokens: 100, outputTokens: 20, cost: 0.01 };
    settle();
    settle();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: 'inst-1', sessionId: 'claude-session-1', provider: 'claude',
      model: CLAUDE_MODELS.OPUS, reasoningEffort: 'high', parentId: null,
      agentId: 'build', purpose: 'automation', taskType: 'automation:build',
      usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
    });
    expect(getCostTracker().getEntries()).toMatchObject([
      { instanceId: 'inst-1', sessionId: 'claude-session-1', model: CLAUDE_MODELS.OPUS, cost: 0.01 },
    ]);
    expect(settled).toHaveBeenCalledExactlyOnceWith();
  });
});
