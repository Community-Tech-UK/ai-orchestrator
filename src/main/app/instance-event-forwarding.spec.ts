/**
 * Tests for instance-event-forwarding.ts
 *
 * Focuses on the provider:normalized-event hot path:
 *   - renderer IPC is called synchronously for every emitted event
 *   - trace sink receives all events
 *   - continuity failures are caught without surfacing
 *   - duplicate context events do not produce info logs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// ── Hoisted mocks (vi.mock factories are hoisted above const declarations) ────

const {
  mockTraceSink,
  mockRecordSpan,
  mockContinuity,
  mockRecordProviderThreadCompactionMarker,
  mockCrossModelReview,
} = vi.hoisted(() => ({
  mockTraceSink: { enqueue: vi.fn() },
  mockRecordSpan: vi.fn(),
  mockContinuity: {
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    addConversationEntry: vi.fn(),
    patchConversationEntry: vi.fn(),
  },
  mockRecordProviderThreadCompactionMarker: vi.fn(),
  mockCrossModelReview: {
    bufferMessage: vi.fn(),
    onInstanceIdle: vi.fn().mockResolvedValue(undefined),
    cancelPendingReviews: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../observability/provider-runtime-trace-sink', () => ({
  getProviderRuntimeTraceSink: vi.fn(() => mockTraceSink),
}));

vi.mock('../observability/otel-spans', () => ({
  recordProviderRuntimeEventSpan: mockRecordSpan,
}));

vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManager: vi.fn(() => mockContinuity),
}));

vi.mock('./compaction-runtime', () => ({
  recordProviderThreadCompactionMarker: mockRecordProviderThreadCompactionMarker,
}));

vi.mock('../observability', () => ({}));
vi.mock('../observability/otel-setup', () => ({ getOrchestratorTracer: vi.fn(() => ({ startSpan: vi.fn(() => ({ end: vi.fn() })) })) }));
vi.mock('../context/compaction-coordinator', () => ({ getCompactionCoordinator: vi.fn(() => ({ cleanupInstance: vi.fn(), onContextUpdate: vi.fn() })) }));
vi.mock('../context/context-window-guard', () => ({ evaluateContextWindowGuard: vi.fn(() => ({ shouldWarn: false, allowed: true })) }));
vi.mock('../orchestration/cross-model-review-service', () => ({
  getCrossModelReviewService: vi.fn(() => mockCrossModelReview),
}));
vi.mock('../orchestration/debate-coordinator', () => ({ getDebateCoordinator: vi.fn(() => ({})) }));
vi.mock('../orchestration/doom-loop-detector', () => ({ getDoomLoopDetector: vi.fn(() => ({ cleanupInstance: vi.fn(), on: vi.fn() })) }));
vi.mock('../orchestration/orchestration-activity-bridge', () => ({ getOrchestrationActivityBridge: vi.fn(() => ({ initialize: vi.fn() })) }));
vi.mock('../orchestration/multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: vi.fn(() => ({})) }));
vi.mock('../memory/memory-monitor', () => ({ getMemoryMonitor: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../remote/observer-server', () => ({ getRemoteObserverServer: vi.fn(() => ({ publishInstanceState: vi.fn(), publishInstanceOutput: vi.fn(), recordPrompt: vi.fn() })) }));
vi.mock('../repo-jobs', () => ({ getRepoJobService: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../process/load-balancer', () => ({ getLoadBalancer: vi.fn(() => ({ removeMetrics: vi.fn(), updateMetrics: vi.fn() })) }));
vi.mock('../workflows/workflow-manager', () => ({ getWorkflowManager: vi.fn(() => ({ cleanupInstance: vi.fn() })) }));
vi.mock('../state', () => ({ getAppStore: vi.fn(), setGlobalState: vi.fn() }));

// ── Non-hoisted mocks (not used inside vi.mock factories) ─────────────────────

const mockSendToRenderer = vi.fn();
const mockWindowManager = { sendToRenderer: mockSendToRenderer } as unknown as import('../window-manager').WindowManager;

import { setupInstanceEventForwarding } from './instance-event-forwarding';
import { IPC_CHANNELS } from '@contracts/channels';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
import { buildObservedCompactionEvents } from '../cli/adapters/codex/compaction-presentation';

function makeEnvelope(kind: string, instanceId = 'inst-1', seq = 0): ProviderRuntimeEventEnvelope {
  return {
    eventId: randomUUID(),
    seq,
    timestamp: Date.now(),
    provider: 'claude',
    instanceId,
    sessionId: 'session-1',
    event: kind === 'output'
      ? { kind: 'output', content: 'hello' }
      : { kind: 'error', message: 'boom' },
  } as ProviderRuntimeEventEnvelope;
}

function buildManager(instances: Record<string, unknown> = {}): import('../instance/instance-manager').InstanceManager {
  const emitter = new EventEmitter();
  const mgr = Object.assign(emitter, {
    getInstance: (id: string) => instances[id] ?? null,
    getOrchestrationHandler: () => Object.assign(new EventEmitter(), {}),
  });
  return mgr as unknown as import('../instance/instance-manager').InstanceManager;
}

describe('setupInstanceEventForwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordProviderThreadCompactionMarker.mockReturnValue('marker-1');
  });

  it('forwards provider:normalized-event to renderer IPC', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    const envelope = makeEnvelope('output');
    mgr.emit('provider:normalized-event', envelope);

    expect(mockSendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.PROVIDER_RUNTIME_EVENT,
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });

  it('enqueues event to the trace sink', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    const envelope = makeEnvelope('output');
    mgr.emit('provider:normalized-event', envelope);

    expect(mockTraceSink.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });

  it('calls recordProviderRuntimeEventSpan for each event', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('provider:normalized-event', makeEnvelope('output', 'inst-1', 0));
    mgr.emit('provider:normalized-event', makeEnvelope('output', 'inst-1', 1));

    expect(mockRecordSpan).toHaveBeenCalledTimes(2);
  });

  it('renderer IPC is called even when continuity throws', async () => {
    mockContinuity.updateState.mockRejectedValueOnce(new Error('continuity fail'));

    const mgr = buildManager({ 'inst-1': { id: 'inst-1', sessionId: 's1' } });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    const envelope = makeEnvelope('output');
    // Should not throw
    expect(() => mgr.emit('provider:normalized-event', envelope)).not.toThrow();
    expect(mockSendToRenderer).toHaveBeenCalled();
  });

  it('enriches envelope with currentModel when instance has one', () => {
    const mgr = buildManager({ 'inst-1': { id: 'inst-1', currentModel: 'claude-opus-4-7', provider: 'claude' } });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    const envelope = makeEnvelope('output');
    mgr.emit('provider:normalized-event', envelope);

    const sent = mockSendToRenderer.mock.calls[0][1] as ProviderRuntimeEventEnvelope;
    expect(sent.model).toBe('claude-opus-4-7');
  });

  it('records provider-managed thread compaction markers and forwards the marker id in output metadata', async () => {
    const instance = {
      id: 'inst-1',
      provider: 'codex',
      providerSessionId: 'provider-thread-1',
      sessionId: 'session-1',
      workingDirectory: '/repo',
      contextUsage: { used: 25_000, total: 100_000, percentage: 25 },
    };
    const mgr = buildManager({ 'inst-1': instance });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output'),
      provider: 'codex',
      sessionId: 'provider-thread-1',
      event: {
        kind: 'output',
        content: 'Codex automatically compacted the conversation to free context space.',
        messageType: 'system',
        messageId: 'msg-compact',
        timestamp: 1234,
        metadata: { threadCompacted: true },
      },
    } as ProviderRuntimeEventEnvelope);

    expect(mockRecordProviderThreadCompactionMarker).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      instance,
      provider: 'codex',
      sessionId: 'provider-thread-1',
      messageId: 'msg-compact',
      createdAt: 1234,
      messageMetadata: { threadCompacted: true },
    });
    expect(mockSendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.PROVIDER_RUNTIME_EVENT,
      expect.objectContaining({
        event: expect.objectContaining({
          metadata: expect.objectContaining({
            threadCompacted: true,
            compactionMarkerId: 'marker-1',
            isCompactionBoundary: true,
            method: 'self-managed',
          }),
        }),
      }),
    );
    await vi.waitFor(() => expect(mockContinuity.addConversationEntry).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        id: 'msg-compact', role: 'system', isCompacted: true,
      }),
    ));
  });

  it('passes message identity and accumulated streaming content to cross-model review', () => {
    const mgr = buildManager({ 'inst-1': { id: 'inst-1', provider: 'codex' } });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output'),
      provider: 'codex',
      event: {
        kind: 'output',
        content: ' delta',
        messageType: 'assistant',
        messageId: 'assistant-1',
        metadata: { accumulatedContent: 'Complete streamed answer' },
      },
    } as ProviderRuntimeEventEnvelope);

    expect(mockCrossModelReview.bufferMessage).toHaveBeenCalledWith(
      'inst-1',
      'assistant',
      ' delta',
      'codex',
      '',
      'assistant-1',
      'Complete streamed answer',
    );
  });

  it('persists typed tool identity, thinking, tokens, and compaction metadata', async () => {
    const mgr = buildManager({
      'inst-1': {
        id: 'inst-1', provider: 'claude', sessionId: 'session-1',
        historyThreadId: 'history-1', displayName: 'Fixture', workingDirectory: '/repo',
      },
    });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 1),
      event: {
        kind: 'output',
        content: '',
        messageType: 'tool_use',
        messageId: 'tool-call-1',
        timestamp: 100,
        metadata: {
          toolName: 'Read', input: { path: '/fixture' }, tokens: 17, isCompacted: true,
        },
        thinking: [{
          id: 'thinking-1', content: 'Inspect the fixture.', format: 'structured', tokenCount: 4,
        }],
        thinkingExtracted: true,
      },
    } as ProviderRuntimeEventEnvelope);
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 2),
      event: {
        kind: 'output',
        content: 'fixture result',
        messageType: 'tool_result',
        messageId: 'tool-result-1',
        timestamp: 101,
        metadata: { toolName: 'Read', output: 'fixture result' },
      },
    } as ProviderRuntimeEventEnvelope);

    await vi.waitFor(() => expect(mockContinuity.addConversationEntry).toHaveBeenCalledTimes(2));
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(1, 'inst-1', {
      id: 'tool-call-1',
      role: 'assistant',
      content: '',
      timestamp: 100,
      tokens: 17,
      toolUse: { kind: 'call', toolName: 'Read', input: { path: '/fixture' } },
      thinking: 'Inspect the fixture.',
      thinkingBlocks: [{
        id: 'thinking-1', content: 'Inspect the fixture.', format: 'structured', tokenCount: 4,
      }],
      isCompacted: true,
      compaction: { boundary: true },
    });
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(2, 'inst-1', {
      id: 'tool-result-1',
      role: 'tool',
      content: 'fixture result',
      timestamp: 101,
      toolUse: {
        kind: 'result', toolName: 'Read', input: null,
        output: 'fixture result',
      },
    });
  });

  it('persists actual bridged tool, thinking, completion, and compaction shapes', async () => {
    const mgr = buildManager({
      'inst-1': {
        id: 'inst-1', provider: 'claude', displayName: 'Fixture', workingDirectory: '/repo',
      },
    });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });
    const toolUse = mapAdapterRuntimeEvent('tool_use', [{
      id: 'call-placeholder', name: 'Read', input: { path: '/fixture' },
    }]);
    const toolResult = mapAdapterRuntimeEvent('tool_result', [{
      tool_use_id: 'call-placeholder', name: 'Read', content: 'denied fixture', is_error: true,
    }]);
    const complete = mapAdapterRuntimeEvent('complete', [{ usage: {
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 5,
      cacheWriteTokens: 3, reasoningTokens: 2, totalTokens: 28,
    } }]);
    const thinking = mapAdapterRuntimeEvent('output', [{
      id: 'assistant-thinking-placeholder', timestamp: 90, type: 'assistant', content: 'answer fixture',
      thinking: [{
        id: 'thinking-placeholder', content: 'reasoning fixture',
        format: 'structured', tokenCount: 4,
      }],
      thinkingExtracted: true,
    }]);
    const observedCompaction = buildObservedCompactionEvents({
      contextWindow: 1_000, cumulativeTokens: 30, costEstimate: 0,
    });
    observedCompaction.output.id = 'compaction-placeholder';
    observedCompaction.output.timestamp = 95;
    const compaction = mapAdapterRuntimeEvent('output', [observedCompaction.output]);
    expect(toolUse && toolResult && complete && thinking && compaction).toBeTruthy();

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 1), eventId: 'event-thinking', event: thinking!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 2), provider: 'codex',
      eventId: 'event-compaction', event: compaction!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 3), eventId: 'event-tool-use', event: toolUse!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 4), eventId: 'event-tool-result', event: toolResult!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 5), eventId: 'event-complete', event: complete!.event,
    });

    await vi.waitFor(() => expect(mockContinuity.addConversationEntry).toHaveBeenCalledTimes(4));
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(1, 'inst-1',
      expect.objectContaining({
        id: 'assistant-thinking-placeholder', role: 'assistant',
        thinkingBlocks: [expect.objectContaining({
          id: 'thinking-placeholder', content: 'reasoning fixture', tokenCount: 4,
        })],
      }));
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(2, 'inst-1',
      expect.objectContaining({
        id: 'compaction-placeholder', role: 'system', isCompacted: true,
        compaction: expect.objectContaining({
          boundary: true, markerId: 'marker-1', method: 'self-managed',
        }),
      }));
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(3, 'inst-1', {
      id: 'tool-call:call-placeholder', role: 'assistant', content: '',
      timestamp: expect.any(Number),
      toolUse: {
        kind: 'call', toolName: 'Read', callId: 'call-placeholder',
        input: { path: '/fixture' },
      },
    });
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(4, 'inst-1', {
      id: 'tool-result:call-placeholder:event-tool-result', role: 'tool',
      content: 'denied fixture', timestamp: expect.any(Number),
      toolUse: {
        kind: 'result', toolName: 'Read', resultForCallId: 'call-placeholder',
        input: null, output: 'denied fixture', isError: true,
      },
    });
    await vi.waitFor(() => expect(mockContinuity.patchConversationEntry).toHaveBeenCalledWith(
      'inst-1',
      'tool-call:call-placeholder',
      {
        tokens: 28,
        tokenUsage: {
          input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 2, total: 28,
        },
      },
    ));
  });

  it('does not reuse the prior token owner for a consecutive completion without new output', async () => {
    const mgr = buildManager({
      'inst-1': {
        id: 'inst-1', provider: 'claude', displayName: 'Fixture', workingDirectory: '/repo',
      },
    });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });
    const assistant = mapAdapterRuntimeEvent('output', [{
      id: 'assistant-token-owner', timestamp: 100, type: 'assistant', content: 'fixture answer',
    }]);
    const firstComplete = mapAdapterRuntimeEvent('complete', [{ usage: {
      inputTokens: 11, outputTokens: 7, totalTokens: 18,
    } }]);
    const ownerlessComplete = mapAdapterRuntimeEvent('complete', [{ usage: {
      inputTokens: 99, outputTokens: 88, totalTokens: 187,
    } }]);
    expect(assistant && firstComplete && ownerlessComplete).toBeTruthy();

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 1), eventId: 'owner-output', event: assistant!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 2), eventId: 'owner-complete', event: firstComplete!.event,
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 3), eventId: 'ownerless-complete', event: ownerlessComplete!.event,
    });

    await vi.waitFor(() => expect(mockContinuity.updateState).toHaveBeenCalledTimes(3));
    expect(mockContinuity.patchConversationEntry).toHaveBeenCalledTimes(1);
    expect(mockContinuity.patchConversationEntry).toHaveBeenCalledWith(
      'inst-1',
      'assistant-token-owner',
      expect.objectContaining({ tokens: 18 }),
    );
  });

  it('correlates the actual Claude output tool-result shape with its tool call', async () => {
    const mgr = buildManager({
      'inst-1': {
        id: 'inst-1', provider: 'claude', displayName: 'Fixture', workingDirectory: '/repo',
      },
    });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 1),
      eventId: 'event-actual-tool-use',
      event: {
        kind: 'output', messageId: 'actual-tool-use', timestamp: 100,
        messageType: 'tool_use', content: 'Using tool: Read',
        metadata: { id: 'call-placeholder', name: 'Read', input: { path: '/fixture' } },
      },
    });
    mgr.emit('provider:normalized-event', {
      ...makeEnvelope('output', 'inst-1', 2),
      eventId: 'event-actual-tool-result',
      event: {
        kind: 'output', messageId: 'actual-tool-result', timestamp: 101,
        messageType: 'tool_result', content: 'denied fixture',
        metadata: { tool_use_id: 'call-placeholder', is_error: true },
      },
    });

    await vi.waitFor(() => expect(mockContinuity.addConversationEntry).toHaveBeenCalledTimes(2));
    expect(mockContinuity.addConversationEntry).toHaveBeenNthCalledWith(2, 'inst-1', {
      id: 'actual-tool-result', role: 'tool', content: 'denied fixture', timestamp: 101,
      toolUse: {
        kind: 'result', toolName: 'Read', resultForCallId: 'call-placeholder',
        input: null, output: 'denied fixture', isError: true,
      },
    });
  });

  it('forwards a schema-invalid envelope to the renderer instead of throwing (Fix B)', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    // pid -2 is below the remote sentinel and fails schema validation. Before
    // Fix B the strict .parse() threw synchronously back into the emitter; now
    // it is logged and the event still forwards.
    const invalid = {
      ...makeEnvelope('output'),
      event: { kind: 'spawned', pid: -2 },
    } as unknown as ProviderRuntimeEventEnvelope;

    expect(() => mgr.emit('provider:normalized-event', invalid)).not.toThrow();
    expect(mockSendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.PROVIDER_RUNTIME_EVENT,
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
    expect(mockTraceSink.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });

  it('accepts the remote spawned pid sentinel (-1) on the hot path', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    const remoteSpawned = {
      ...makeEnvelope('output'),
      event: { kind: 'spawned', pid: -1 },
    } as unknown as ProviderRuntimeEventEnvelope;

    expect(() => mgr.emit('provider:normalized-event', remoteSpawned)).not.toThrow();
    expect(mockSendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.PROVIDER_RUNTIME_EVENT,
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
  });

  it('forwards discarded reviews as a terminal renderer event', () => {
    const mgr = buildManager();
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });
    const discardedHandler = mockCrossModelReview.on.mock.calls
      .find(([eventName]) => eventName === 'review:discarded')?.[1] as
        | ((data: Record<string, string>) => void)
        | undefined;

    discardedHandler?.({
      instanceId: 'inst-1',
      reviewId: 'review-1',
      reason: 'superseded',
    });

    expect(mockSendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.CROSS_MODEL_REVIEW_DISCARDED,
      {
        instanceId: 'inst-1',
        reviewId: 'review-1',
        reason: 'superseded',
      },
    );
  });
});

/**
 * LT-018. `session-continuity.updateState` does a shallow `Object.assign`, so
 * whatever is enqueued here REPLACES the stored `contextUsage` wholesale.
 * Narrowing it to `{used, total}` therefore dropped `occupancyReported`,
 * `percentage` and `costEstimate` from the on-disk record on every ordinary
 * turn — accrued spend vanished on any hibernate/wake or restart, and the wake
 * restore lost the one flag it exists to recover.
 */
describe('instance:batch-update contextUsage persistence (LT-018)', () => {
  it('persists the whole ContextUsage, not a narrowed subset', async () => {
    const mgr = buildManager({ 'inst-1': { id: 'inst-1', sessionId: 's1' } });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });

    mgr.emit('instance:batch-update', {
      updates: [{
        instanceId: 'inst-1',
        status: 'idle',
        contextUsage: {
          used: 124_000,
          total: 200_000,
          percentage: 62,
          costEstimate: 4.25,
          occupancyReported: true,
        },
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockContinuity.updateState).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        contextUsage: expect.objectContaining({
          used: 124_000,
          total: 200_000,
          percentage: 62,
          costEstimate: 4.25,
          occupancyReported: true,
        }),
      }),
    );
  });
});

/**
 * LT-034 (gate round 3, finding 3). The context-window guard derives pressure
 * from `total - used`. For an aggregate-only provider `used` is cumulative turn
 * spend and — unlike `percentage` — is NOT clamped, so it grows past `total` and
 * drives `remaining` negative, firing a false "context window is low" warning
 * and a false hard-block classification over a nearly-empty context.
 */
describe('context:warning guard for aggregate-only providers (LT-034)', () => {
  const emitUsage = (contextUsage: Record<string, unknown>) => {
    const mgr = buildManager({ 'inst-1': { id: 'inst-1', sessionId: 's1' } });
    setupInstanceEventForwarding({
      instanceManager: mgr,
      windowManager: mockWindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
    });
    mgr.emit('instance:batch-update', {
      updates: [{ instanceId: 'inst-1', status: 'idle', contextUsage }],
    });
  };

  const warnings = () =>
    mockSendToRenderer.mock.calls.filter(([channel]) => channel === 'context:warning');

  beforeEach(async () => {
    mockSendToRenderer.mockClear();
    // The threshold function is module-mocked to never warn. Force it to WANT
    // to warn, so these tests isolate the occupancy gate rather than
    // re-testing `evaluateContextWindowGuard`'s own bands.
    const guard = await import('../context/context-window-guard');
    vi.mocked(guard.evaluateContextWindowGuard).mockReturnValue({
      shouldWarn: true, allowed: false, remainingTokens: 5_000,
      source: 'default', message: 'low',
    } as ReturnType<typeof guard.evaluateContextWindowGuard>);
  });

  it('does not warn on cumulative spend that has overrun the window', async () => {
    emitUsage({
      used: 260_000, total: 200_000, percentage: 100,
      occupancyReported: true, occupancyIsAggregate: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings()).toHaveLength(0);
  });

  it('still warns on genuine low remaining context', async () => {
    emitUsage({
      used: 195_000, total: 200_000, percentage: 97.5, occupancyReported: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings().length).toBeGreaterThan(0);
  });

  it('does not warn off an unreported placeholder reading', async () => {
    emitUsage({ used: 195_000, total: 200_000, percentage: 97.5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings()).toHaveLength(0);
  });
});
