import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

const recordUsage = vi.hoisted(() => vi.fn());
const recordTurn = vi.hoisted(() => vi.fn());
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: vi.fn() }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn }) }));
import { InstanceCommunicationManager } from './instance-communication';

describe('partial adapter usage persistence', () => {
  it('records disjoint spend without changing lifecycle or producing a completion and fences stale events', () => {
    const adapter = new EventEmitter() as CliAdapter;
    let currentAdapter = adapter;
    const instance = {
      id: 'partial-instance', sessionId: 'partial-session', status: 'busy', provider: 'codex',
      currentModel: 'gpt-6-astra', restartEpoch: 0, parentId: null, agentId: 'build',
    } as Instance;
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
    adapter.emit('usage', usage);
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith('partial-instance', 'partial-session', 'gpt-6-astra', 20, 16, 80, 0, 0.00208, 4, false);
    expect(recordTurn).toHaveBeenCalledWith('partial-instance', { input: 20, cacheRead: 80, cacheWrite: 0 });
    expect(instance.status).toBe('busy');
    expect(queueUpdate).not.toHaveBeenCalled();
    expect(emitProviderRuntimeEvent).not.toHaveBeenCalled();
    currentAdapter = new EventEmitter() as CliAdapter;
    adapter.emit('usage', usage);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });
});
