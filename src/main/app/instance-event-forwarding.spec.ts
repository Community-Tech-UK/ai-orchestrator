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

const { mockTraceSink, mockRecordSpan, mockContinuity } = vi.hoisted(() => ({
  mockTraceSink: { enqueue: vi.fn() },
  mockRecordSpan: vi.fn(),
  mockContinuity: {
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    addConversationEntry: vi.fn(),
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

vi.mock('../observability', () => ({}));
vi.mock('../observability/otel-setup', () => ({ getOrchestratorTracer: vi.fn(() => ({ startSpan: vi.fn(() => ({ end: vi.fn() })) })) }));
vi.mock('../context/compaction-coordinator', () => ({ getCompactionCoordinator: vi.fn(() => ({ cleanupInstance: vi.fn(), onContextUpdate: vi.fn() })) }));
vi.mock('../context/context-window-guard', () => ({ evaluateContextWindowGuard: vi.fn(() => ({ shouldWarn: false, allowed: true })) }));
vi.mock('../orchestration/cross-model-review-service', () => ({ getCrossModelReviewService: vi.fn(() => ({ bufferMessage: vi.fn(), onInstanceIdle: vi.fn().mockResolvedValue(undefined), cancelPendingReviews: vi.fn(), on: vi.fn() })) }));
vi.mock('../orchestration/debate-coordinator', () => ({ getDebateCoordinator: vi.fn(() => ({})) }));
vi.mock('../orchestration/doom-loop-detector', () => ({ getDoomLoopDetector: vi.fn(() => ({ cleanupInstance: vi.fn(), on: vi.fn() })) }));
vi.mock('../orchestration/orchestration-activity-bridge', () => ({ getOrchestrationActivityBridge: vi.fn(() => ({ initialize: vi.fn() })) }));
vi.mock('../orchestration/multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: vi.fn(() => ({})) }));
vi.mock('../memory', () => ({ getMemoryMonitor: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../remote/observer-server', () => ({ getRemoteObserverServer: vi.fn(() => ({ publishInstanceState: vi.fn(), publishInstanceOutput: vi.fn(), recordPrompt: vi.fn() })) }));
vi.mock('../repo-jobs', () => ({ getRepoJobService: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../process/load-balancer', () => ({ getLoadBalancer: vi.fn(() => ({ removeMetrics: vi.fn(), updateMetrics: vi.fn() })) }));
vi.mock('../workflows/workflow-manager', () => ({ getWorkflowManager: vi.fn(() => ({ cleanupInstance: vi.fn() })) }));
vi.mock('../state', () => ({ getAppStore: vi.fn(), addInstance: vi.fn(), removeInstance: vi.fn(), setGlobalState: vi.fn(), updateInstance: vi.fn() }));

// ── Non-hoisted mocks (not used inside vi.mock factories) ─────────────────────

const mockSendToRenderer = vi.fn();
const mockWindowManager = { sendToRenderer: mockSendToRenderer } as unknown as import('../window-manager').WindowManager;

import { setupInstanceEventForwarding } from './instance-event-forwarding';
import { IPC_CHANNELS } from '@contracts/channels';

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
});
