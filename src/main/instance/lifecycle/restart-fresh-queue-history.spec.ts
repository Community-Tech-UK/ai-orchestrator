import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { SessionContinuityManager } from '../../session/session-continuity';
import { getMocks, makeHarness } from '../__tests__/instance-lifecycle-source-diagnostics.fixture';

// Reuse the lifecycle fixture's inert account/process environment. Persistence,
// forwarding, restart, communication and event ingress below remain real.
vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({ resolveRouteForSpawn: async () => ({
    ok: true, route: { profileId: 'fixture-profile', source: 'default' },
  }) }),
}));
vi.mock('../../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'text' }) }));
vi.mock('../../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 0 }) }));
vi.mock('../../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../instance-provider-limit-handler', () => ({ getInstanceProviderLimitHandler: () => ({ release: vi.fn() }) }));
vi.mock('../instance-auth-repair-handler', () => ({ getInstanceAuthRepairHandler: () => ({ forget: vi.fn() }) }));
vi.mock('../../context/context-manifest-store', () => ({ recordContextManifest: vi.fn() }));
vi.mock('../../context/context-engine', () => ({ getContextEngine: () => ({ cleanupInstance: vi.fn() }) }));
vi.mock('../../observability/provider-runtime-trace-sink', () => ({ getProviderRuntimeTraceSink: () => ({ enqueue: vi.fn() }) }));
vi.mock('../../observability/otel-spans', () => ({ recordProviderRuntimeEventSpan: vi.fn() }));
vi.mock('../../orchestration/cross-model-review-service', () => ({ getCrossModelReviewService: () => ({
  bufferMessage: vi.fn(), onInstanceIdle: async () => undefined, cancelPendingReviews: vi.fn(),
  abortSupersededReviews: vi.fn(), on: vi.fn(),
}) }));
vi.mock('../../orchestration/debate-coordinator', () => ({ getDebateCoordinator: () => ({}) }));
vi.mock('../../orchestration/doom-loop-detector', () => ({ getDoomLoopDetector: () => ({ on: vi.fn(), cleanupInstance: vi.fn() }) }));
vi.mock('../../orchestration/orchestration-activity-bridge', () => ({ getOrchestrationActivityBridge: () => ({ initialize: vi.fn() }) }));
vi.mock('../../orchestration/multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: () => ({}) }));
vi.mock('../../remote/observer-server', () => ({ getRemoteObserverServer: () => ({ publishInstanceState: vi.fn(), publishInstanceOutput: vi.fn() }) }));
vi.mock('../../repo-jobs', () => ({ getRepoJobService: () => ({ on: vi.fn() }) }));
vi.mock('../../process/load-balancer', () => ({ getLoadBalancer: () => ({ removeMetrics: vi.fn(), updateMetrics: vi.fn() }) }));
vi.mock('../../workflows/workflow-manager', () => ({ getWorkflowManager: () => ({ cleanupInstance: vi.fn() }) }));
vi.mock('../../state', () => ({ getAppStore: vi.fn(), setGlobalState: vi.fn() }));
vi.mock('../../app/compaction-runtime', () => ({ recordProviderThreadCompactionMarker: vi.fn() }));

const managers: SessionContinuityManager[] = [];
const cleanups: (() => void)[] = [];
let tempRoot = '';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const manager of managers.splice(0)) manager.shutdown();
  const { _resetSessionPersistenceQueueForTesting } = await import('../../session/session-persistence-queue');
  _resetSessionPersistenceQueueForTesting();
  vi.doUnmock('../../session/session-continuity');
  vi.doUnmock('../../session/session-mutex');
  vi.restoreAllMocks();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('queue Copilot recycle durable child history', () => {
  it('retains old and new conversation generations through real forwarding, removal and disk rehydration', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'step11-queue-history-'));
    const { app } = await import('electron');
    vi.spyOn(app, 'getPath').mockImplementation(() => tempRoot);
    const actualMutex = await vi.importActual<typeof import('../../session/session-mutex')>('../../session/session-mutex');
    vi.doMock('../../session/session-mutex', () => actualMutex);
    const actualContinuity = await vi.importActual<typeof import('../../session/session-continuity')>('../../session/session-continuity');
    const continuity = new actualContinuity.SessionContinuityManager({ autoSaveEnabled: false });
    managers.push(continuity);
    await continuity.waitForRecoveryDiscoveryReady();
    // The fixture imports lifecycle with an inert continuity getter. The app
    // forwarding and communication modules are loaded after binding the real
    // manager, so their executing persistence path is not a mock.
    vi.doMock('../../session/session-continuity', () => ({
      ...actualContinuity,
      getSessionContinuityManager: () => continuity,
      getSessionContinuityManagerIfInitialized: () => continuity,
    }));
    const { setupInstanceEventForwarding } = await import('../../app/instance-event-forwarding');
    const { InstanceCommunicationManager } = await import('../instance-communication');
    const { ProviderRuntimeEventBus } = await import('../../providers/provider-runtime-event-bus');
    const { buildProviderRuntimeEventIngress } = await import('../instance-provider-event-ingress');
    const { toProviderOutputEvent } = await import('../../providers/provider-output-event');
    const { recycleQueueCopilotSession } = await import('../../plan-queue/plan-queue-session-recycle');
    const { continuityEntryToOutputMessage } = await import('../../session/continuity-message-projection');
    const h = makeHarness();
    cleanups.push(() => h.manager.destroy());
    const mocks = getMocks();
    mocks.archiveInstance.mockClear();
    // Keep the visible buffer small enough to evict the old generation. The
    // durable assertion must succeed independently of that transient buffer.
    Object.assign(mocks.settings, { outputBufferSize: 2, enableDiskStorage: false });
    const originalPrompt: OutputMessage = { id: 'old-user', timestamp: 1, type: 'user', content: 'Original queue task' };
    const worker: Instance = {
      id: 'queue-child', parentId: 'queue-owner', childrenIds: [], depth: 1,
      displayName: 'Queue worker', createdAt: 1, historyThreadId: 'old-history',
      providerSessionId: 'old-provider', sessionId: 'old-provider', restartEpoch: 0,
      status: 'idle', processId: 10, workingDirectory: path.join(tempRoot, 'workfolder'),
      provider: 'copilot', currentModel: 'fixture-model', launchMode: 'orchestrated',
      executionLocation: { type: 'remote', nodeId: 'fixture-worker' },
      supervisorNodeId: 'queue-owner', terminationPolicy: 'terminate-children',
      contextInheritance: {} as Instance['contextInheritance'], agentId: 'build', agentMode: 'build',
      planMode: { enabled: false, state: 'off' }, yoloMode: false, lastActivity: 1,
      outputBuffer: [originalPrompt], outputBufferMaxSize: 2, subscribedTo: [], communicationTokens: new Map(),
      contextUsage: { used: 901, total: 1000, percentage: 90.1,
        copilotUsage: { compactions: 2, postCompactionTokens: 901, tokenLimit: 1000 } },
      totalTokensUsed: 901, requestCount: 1, restartCount: 0, errorCount: 0,
      metadata: { planQueueRunId: 'queue-run', planQueueItemId: 'queue-item', repoJobId: 'queue-job' },
    };
    h.instances.set(worker.id, worker);
    const facade = Object.assign(new EventEmitter(), {
      getInstance: h.deps.getInstance, getOrchestrationHandler: () => new EventEmitter(),
    });
    h.manager.on('removed', id => facade.emit('instance:removed', id));
    const bus = new ProviderRuntimeEventBus(envelope => facade.emit('provider:normalized-event', envelope));
    cleanups.push(() => bus.removeInstance(worker.id));
    const publish: NonNullable<import('../instance-communication.types').CommunicationDependencies['emitProviderRuntimeEvent']> = (instanceId, event, options) => {
      const ingress = buildProviderRuntimeEventIngress({ getInstance: h.deps.getInstance, instanceId, event, options });
      if (ingress) bus.enqueue(ingress);
    };
    const communication = new InstanceCommunicationManager({
      getInstance: h.deps.getInstance, getAdapter: h.deps.getAdapter,
      setAdapter: h.deps.setAdapter, deleteAdapter: h.deps.deleteAdapter,
      queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(),
      ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), emitProviderRuntimeEvent: publish,
    });
    cleanups.push(() => communication.cleanupCircuitBreaker(worker.id));
    communication.on('output', ({ instanceId, message }) => publish(instanceId, toProviderOutputEvent(message)));
    h.setupAdapterEvents.mockImplementation((id, adapter) => communication.setupAdapterEvents(id, adapter));
    h.deps.addToOutputBuffer = (instance, message) => communication.addToOutputBuffer(instance, message);
    setupInstanceEventForwarding({
      instanceManager: facade as unknown as import('../instance-manager').InstanceManager,
      windowManager: { sendToRenderer: vi.fn() } as unknown as import('../../window-manager').WindowManager,
      isStatelessExecProvider: () => false, getNodeLatencyForInstance: () => undefined,
    });
    continuity.setInstanceManager({ getAdapter: h.deps.getAdapter, getInstance: h.deps.getInstance });
    facade.emit('instance:created', worker);
    await vi.waitFor(() => expect(continuity.getSessionState(worker.id)?.parentId).toBe('queue-owner'));

    const adapterFor = (sessionId: string) => Object.assign(new EventEmitter(), {
      getName: () => 'copilot-acp', getSessionId: () => sessionId,
      spawn: vi.fn(async () => 20), terminate: vi.fn(async () => undefined),
    }) as unknown as CliAdapter;
    const oldAdapter = adapterFor(worker.sessionId);
    h.adapters.set(worker.id, oldAdapter);
    communication.setupAdapterEvents(worker.id, oldAdapter);
    oldAdapter.emit('output', { id: 'old-assistant', timestamp: 2, type: 'assistant', content: 'Prior generation answer' });
    await vi.waitFor(() => expect(continuity.getSessionState(worker.id)?.conversationHistory.map(entry => entry.id)).toEqual(['old-user', 'old-assistant']));
    mocks.createAdapter.mockImplementation(({ options }) => adapterFor(options.sessionId));
    const metadata = worker.metadata;
    const workfolder = worker.workingDirectory;
    expect(await recycleQueueCopilotSession({
      getInstance: h.deps.getInstance,
      restartFreshInstance: id => h.manager.restartFreshInstance(id),
    }, worker, vi.fn())).toBe(true);
    expect(h.instances.get(worker.id)).toBe(worker);
    expect(worker).toMatchObject({ parentId: 'queue-owner', workingDirectory: workfolder,
      executionLocation: { type: 'remote', nodeId: 'fixture-worker' },
      metadata: { planQueueRunId: 'queue-run', planQueueItemId: 'queue-item', repoJobId: 'queue-job' },
      status: 'idle', recoveryMethod: 'fresh', archivedUpToMessageId: 'old-assistant' });
    expect(worker.metadata).toBe(metadata);
    expect(worker.historyThreadId).not.toBe('old-history');
    expect(worker.providerSessionId).not.toBe('old-provider');
    expect(mocks.archiveInstance).not.toHaveBeenCalled();
    expect(mocks.createAdapter).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ instanceId: worker.id, workingDirectory: workfolder,
        jobId: 'queue-item', sessionKind: 'plan-queue', resume: false, forkSession: false }),
    }));
    const freshAdapter = h.deps.getAdapter(worker.id)!;
    freshAdapter.emit('output', { id: 'new-assistant', timestamp: 3, type: 'assistant', content: 'Fresh generation answer' });
    await vi.waitFor(() => expect(continuity.getSessionState(worker.id)?.conversationHistory.map(entry => entry.id)).toEqual(['old-user', 'old-assistant', 'new-assistant']));
    expect(worker.outputBuffer.map(message => message.id)).not.toContain('old-assistant');
    // Exercise the same stop/archive boundary used when a queue child retires.
    const stopped = new Promise<void>(resolve => continuity.once('tracking:stopped', () => resolve()));
    await h.manager.terminateInstance(worker.id);
    await stopped;
    expect(h.instances.has(worker.id)).toBe(false);
    continuity.shutdown();
    h.instances.clear();
    worker.outputBuffer.length = 0;
    const reloaded = new actualContinuity.SessionContinuityManager({ autoSaveEnabled: false });
    managers.push(reloaded);
    await reloaded.waitForRecoveryDiscoveryReady();
    const recovered = await reloaded.loadRecoveryState(worker.id);
    expect(recovered).toMatchObject({ instanceId: worker.id, parentId: 'queue-owner', workingDirectory: workfolder,
      sessionId: worker.providerSessionId, historyThreadId: worker.historyThreadId });
    expect(recovered?.conversationHistory.map(continuityEntryToOutputMessage)).toMatchObject([
      { id: 'old-user', type: 'user', content: 'Original queue task' },
      { id: 'old-assistant', type: 'assistant', content: 'Prior generation answer' },
      { id: 'new-assistant', type: 'assistant', content: 'Fresh generation answer' },
    ]);
    expect(mocks.archiveInstance).not.toHaveBeenCalled();
  });
});
