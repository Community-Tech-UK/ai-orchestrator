import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';

const recordUsage = vi.hoisted(() => vi.fn(() => ({ cost: 0.01 })));
const attribution = vi.hoisted(() => vi.fn());
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 1, enableDiskStorage: false }) }),
}));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({ triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: attribution }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));
import { InstanceCommunicationManager } from './instance-communication';

describe('completion identity at the actual adapter event boundary', () => {
  it('captures effort and session before evidence drain and keeps them until deferred usage settles', async () => {
    recordUsage.mockClear();
    attribution.mockClear();
    const metadata = { spendPurpose: 'automation' };
    const instance = {
      id: 'identity-instance', displayName: 'Fixture', createdAt: 1, historyThreadId: 'fixture-history',
      parentId: null, childrenIds: [], supervisorNodeId: '', depth: 0,
      terminationPolicy: 'terminate-children', launchMode: 'orchestrated', executionLocation: { type: 'local' },
      contextInheritance: { inheritWorkingDirectory: true, inheritEnvironment: true, inheritYoloMode: false, inheritAgentSettings: true },
      agentId: 'build', agentMode: 'build', planMode: { enabled: false, state: 'off' },
      status: 'processing', contextUsage: { used: 0, total: 200_000, percentage: 0 },
      lastActivity: 1, processId: 1, sessionId: 'completed-session', providerSessionId: 'fixture-provider-session',
      activeTurnId: 'fixture-turn', workingDirectory: '/tmp', yoloMode: false, provider: 'claude',
      currentModel: CLAUDE_MODELS.OPUS, reasoningEffort: 'high', metadata,
      outputBuffer: [], outputBufferMaxSize: 1, communicationTokens: new Map(), subscribedTo: [],
      totalTokensUsed: 0, requestCount: 1, errorCount: 0, restartCount: 0, restartEpoch: 0,
    } as Instance;
    const adapter = Object.assign(new EventEmitter(), { getName: () => 'claude-cli' }) as CliAdapter;
    let releaseDrain!: () => void;
    const drainContextEvidence = vi.fn(() => new Promise<void>(resolve => { releaseDrain = resolve; }));
    const onToolStateChange = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(), deleteAdapter: () => false,
      queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), drainContextEvidence, onToolStateChange,
    });
    manager.setupAdapterEvents(instance.id, adapter);
    const response: CliResponse = { id: 'completed-response', content: '', role: 'assistant' };
    const settle = deferResponseUsage(response);
    adapter.emit('complete', response);
    expect(drainContextEvidence).toHaveBeenCalledWith(instance.id);
    expect(recordUsage).not.toHaveBeenCalled();

    instance.sessionId = 'next-session';
    instance.currentModel = CLAUDE_MODELS.SONNET;
    instance.reasoningEffort = 'max';
    metadata.spendPurpose = 'channel';
    releaseDrain();
    // The session goes idle only once the provider's usage has settled, so wait for the drain to finish, not for idle.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(recordUsage).not.toHaveBeenCalled();

    response.usage = { inputTokens: 100, outputTokens: 20, cost: 0.01 };
    settle();
    settle();
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith(
      instance.id, 'completed-session', CLAUDE_MODELS.OPUS, 100, 20, 0, 0, 0.01, 0, false,
      { provider: 'claude', byModel: undefined, origin: 'machine' },
    );
    expect(attribution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'completed-session', model: CLAUDE_MODELS.OPUS, reasoningEffort: 'high', purpose: 'automation',
    }));
    await vi.waitFor(() => expect(onToolStateChange).toHaveBeenCalledWith(instance.id, 'idle'));
  });
});
