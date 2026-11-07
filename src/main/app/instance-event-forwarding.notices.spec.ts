/**
 * Tests for instance-event-forwarding.ts
 *
 * Focuses on the provider:normalized-event hot path:
 *   - renderer IPC is called synchronously for every emitted event
 *   - trace sink receives all events
 *   - continuity failures are caught without surfacing
 *   - duplicate context events do not produce info logs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks (vi.mock factories are hoisted above const declarations) ────

const {
  mockTraceSink,
  mockRecordSpan,
  mockContinuity,
  mockRecordProviderThreadCompactionMarker,
  mockRecordLifecycleTrace,
  mockCrossModelReview,
} = vi.hoisted(() => ({
  mockTraceSink: { enqueue: vi.fn() },
  mockRecordSpan: vi.fn(),
  mockContinuity: {
    startTracking: vi.fn(),
    markConversationIncomplete: vi.fn(),
    captureConversationCheckpoint: vi.fn(() => 7),
    checkpointCompleteConversation: vi.fn(async () => undefined),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    addConversationEntry: vi.fn(),
    patchConversationEntry: vi.fn(async () => true),
  },
  mockRecordProviderThreadCompactionMarker: vi.fn(),
  mockRecordLifecycleTrace: vi.fn(),
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

vi.mock('../observability/lifecycle-trace', () => ({
  recordLifecycleTrace: mockRecordLifecycleTrace,
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
const mockObserverClearPrompt = vi.hoisted(() => vi.fn());
vi.mock('../remote/observer-server', () => ({ getRemoteObserverServer: vi.fn(() => ({ publishInstanceState: vi.fn(), publishInstanceOutput: vi.fn(), recordPrompt: vi.fn(), clearPrompt: mockObserverClearPrompt })) }));
vi.mock('../repo-jobs', () => ({ getRepoJobService: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../process/load-balancer', () => ({ getLoadBalancer: vi.fn(() => ({ removeMetrics: vi.fn(), updateMetrics: vi.fn() })) }));
vi.mock('../workflows/workflow-manager', () => ({ getWorkflowManager: vi.fn(() => ({ cleanupInstance: vi.fn() })) }));
vi.mock('../state', () => ({ getAppStore: vi.fn(), setGlobalState: vi.fn() }));

// ── Non-hoisted mocks (not used inside vi.mock factories) ─────────────────────

const mockSendToRenderer = vi.fn();

import { setupInstanceEventForwarding } from './instance-event-forwarding';
import { _resetContextEngineForTesting } from '../context/context-engine';

function buildManager(instances: Record<string, unknown> = {}): import('../instance/instance-manager').InstanceManager {
  const emitter = new EventEmitter();
  const mgr = Object.assign(emitter, {
    getInstance: (id: string) => instances[id] ?? null,
    getOrchestrationHandler: () => Object.assign(new EventEmitter(), {}),
  });
  return mgr as unknown as import('../instance/instance-manager').InstanceManager;
}

describe('user-action notification forwarding', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => _resetContextEngineForTesting());
  it('passes the request and the actual session display name to the window manager', () => {
    const orchestration = new EventEmitter();
    const manager = buildManager({ 'inst-1': { displayName: 'Fix login' } });
    vi.spyOn(manager, 'getOrchestrationHandler').mockReturnValue(orchestration as never);
    const notifyUserActionRequest = vi.fn();
    setupInstanceEventForwarding({ instanceManager: manager,
      windowManager: { sendToRenderer: mockSendToRenderer, notifyUserActionRequest } as never,
      isStatelessExecProvider: () => false, getNodeLatencyForInstance: () => undefined });
    const request = { id: 'request-1', instanceId: 'inst-1', requestType: 'ask_questions',
      title: 'Question', message: 'Choose a mode', createdAt: 1 };
    orchestration.emit('user-action-request', request);
    expect(notifyUserActionRequest).toHaveBeenCalledWith(request, 'Fix login');
  });
});
