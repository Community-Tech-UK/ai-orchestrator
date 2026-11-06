import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import type { Instance } from '../../shared/types/instance.types';
import { _resetCostAttributionForTesting, subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';

vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: () => ({ cost: 0 }) }) }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));

import { recordCompletionCost } from './communication-completion-cost';

const response = { usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 } } as unknown as CliResponse;
const instance = (overrides: Partial<Instance>): Instance => ({
  id: 'i-1', sessionId: 's-1', provider: 'codex', currentModel: 'gpt-6-astra', parentId: null, agentId: 'build', metadata: {}, contextUsage: {},
  ...overrides,
}) as unknown as Instance;

describe('per-turn cost rows carry the session kind (feeds "Biggest turns")', () => {
  let rows: CostAttributionRecord[];
  let stop: () => void;
  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    _resetCostAttributionForTesting();
    rows = [];
    stop = subscribeCostAttribution((record) => rows.push(record));
  });
  afterEach(() => { stop(); vi.unstubAllEnvs(); });

  it.each([
    ['your own chat', {}, 'chat'],
    ['an ordinary helper', { parentId: 'parent' }, 'child'],
    ['a plan queue job', { metadata: { planQueueRole: 'worker' } }, 'plan-queue'],
    ['a scheduled job', { metadata: { automationId: 'a-1' } }, 'automation'],
  ] as const)('files %s as %s', (_label, overrides, kind) => {
    const target = instance(overrides as Partial<Instance>);
    recordCompletionCost(target.id, target, response);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'instance-turn', instanceId: 'i-1', sessionKind: kind });
  });

  it('persists the response native turn identity even if the instance has moved to another session', () => {
    const target = instance({ sessionId: 'replacement-session' });
    recordCompletionCost(target.id, target, { ...response, metadata: { codexTurn: { threadId: 'original-thread', turnId: 'original-turn' } } });
    expect(rows[0]).toMatchObject({ codexTurn: { threadId: 'original-thread', turnId: 'original-turn' } });
  });

  it.each([undefined, {}, { threadId: 'thread' }, { threadId: '', turnId: '' }])('does not invent identity for legacy or command-mode response %j', codexTurn => {
    const target = instance({});
    recordCompletionCost(target.id, target, { ...response, metadata: { codexTurn } });
    expect(rows[0]).not.toHaveProperty('codexTurn');
  });
});
