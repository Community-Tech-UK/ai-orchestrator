import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { createInstance, type Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';

const recordUsage = vi.hoisted(() => vi.fn());
const recordTurn = vi.hoisted(() => vi.fn());
const recordAttribution = vi.hoisted(() => vi.fn());
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: recordAttribution }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn }) }));
import { InstanceCommunicationManager } from './instance-communication';

describe('partial adapter usage persistence', () => {
  it('records disjoint spend without changing lifecycle or producing a completion and fences stale events', () => {
    recordUsage.mockReturnValue({ cost: 0.00208 });
    const adapter = new EventEmitter() as CliAdapter;
    let currentAdapter = adapter;
    const instance: Instance = {
      ...createInstance({ workingDirectory: '/fixture', provider: 'codex' }),
      id: 'partial-instance', sessionId: 'partial-session', status: 'busy', provider: 'codex',
      currentModel: 'gpt-6-astra', restartEpoch: 0, parentId: null, agentId: 'build',
      contextUsage: { used: 0, total: 200_000, percentage: 0 },
    };
    const emitProviderRuntimeEvent = vi.fn();
    const queueUpdate = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => currentAdapter,
      setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate,
      processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), emitProviderRuntimeEvent,
    });
    manager.setupAdapterEvents(instance.id, adapter);
    const usage = { inputTokens: 20, cacheReadTokens: 80, outputTokens: 16, reasoningTokens: 4, totalTokens: 120, cost: 0.00208 };
    recordUsage.mockReturnValue({ cost: usage.cost });
    adapter.emit('usage', usage);
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith('partial-instance', 'partial-session', 'gpt-6-astra', 20, 16, 80, 0, 0.00208, 4, false, { provider: 'codex', byModel: undefined, origin: 'user' });
    expect(recordTurn).toHaveBeenCalledWith('partial-instance', {
      input: 20, cacheRead: 80, cacheWrite: 0,
      model: 'gpt-6-astra', promptTokens: 100, provider: 'codex', ttlMs: undefined,
    });
    expect(instance.contextUsage.costEstimate).toBe(0.00208);
    expect(instance.status).toBe('busy');
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'busy', expect.objectContaining({ costEstimate: usage.cost }));
    expect(emitProviderRuntimeEvent).not.toHaveBeenCalled();
    currentAdapter = new EventEmitter() as CliAdapter;
    adapter.emit('usage', usage);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('retains billing identity across the completion drain and publishes a deferred cost update', async () => {
    recordUsage.mockClear().mockReturnValue({ cost: 0.25 });
    recordAttribution.mockClear();
    const adapter = new EventEmitter() as CliAdapter;
    const instance: Instance = {
      ...createInstance({ workingDirectory: '/fixture', provider: 'claude' }),
      id: 'complete-instance', sessionId: 'original-session', status: 'busy', provider: 'claude',
      currentModel: 'claude-sonnet-4-6-20260401', restartEpoch: 0, parentId: 'parent-original',
      agentId: 'build', metadata: { planQueueRole: 'verifier', rtkArm: 'on' }, reasoningEffort: 'high',
      contextUsage: { used: 0, total: 200_000, percentage: 0 },
    };
    let releaseDrain!: () => void;
    const drainContextEvidence = vi.fn(() => new Promise<void>(resolve => { releaseDrain = resolve; }));
    const queueUpdate = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => adapter,
      setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate,
      processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), drainContextEvidence,
    });
    manager.setupAdapterEvents(instance.id, adapter);
    const response: CliResponse = { id: 'complete-response', content: 'done', role: 'assistant',
      usage: { inputTokens: 100, outputTokens: 10 } };
    const settleUsage = deferResponseUsage(response);
    adapter.emit('complete', response);
    expect(drainContextEvidence).toHaveBeenCalledWith(instance.id);

    instance.sessionId = 'new-session';
    instance.currentModel = 'claude-opus-5';
    instance.parentId = null;
    instance.metadata = { rtkArm: 'off' };
    instance.reasoningEffort = 'low';
    releaseDrain();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(recordUsage).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();

    response.usage = { inputTokens: 100, outputTokens: 10, cost: 0.25 };
    settleUsage();
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith(
      instance.id, 'original-session', 'claude-sonnet-4-6-20260401', 100, 10, 0, 0, 0.25, 0, false,
      { provider: 'claude', byModel: undefined, origin: 'machine' },
    );
    expect(recordAttribution).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'original-session', parentId: 'parent-original', rtkArm: 'on',
      purpose: 'plan-queue', purposeDetail: 'verifier', reasoningEffort: 'high',
    }));
    expect(queueUpdate).toHaveBeenCalledExactlyOnceWith(instance.id, 'busy', instance.contextUsage);
    expect(instance.contextUsage.costEstimate).toBe(0.25);
  });
});
