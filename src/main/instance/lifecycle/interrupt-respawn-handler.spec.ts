/**
 * Tests for InterruptRespawnHandler — the Phase 1 P0 correctness fixes.
 *
 * Focused scenarios from the plan's PR 1 checklist:
 *   - accepted-without-completion: respawnPromise is created; force-abort net fires
 *   - never-settling completion: A3 deadline fires; instance recovers to idle
 *   - second-interrupt escalation: transitions immediately to cancelled (A1/A4)
 *   - process-exits-after-interrupt: non-interruptible status → interrupt() returns false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InterruptRespawnDeps } from './interrupt-respawn-handler';
import type {
  Instance,
  InstanceStatus,
  OutputMessage,
} from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { InterruptResult } from '../../cli/adapters/base-cli-adapter';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const {
  mockSupervisor,
  mockCircuitBreaker,
  mockContinuity,
  mockCreateAdapter,
  mockPlanSessionRecovery,
  mockSessionMutex,
} = vi.hoisted(() => ({
  mockSupervisor: { recordInterrupt: vi.fn(), recordTurnEnd: vi.fn(), recordAdapterSetup: vi.fn() },
  mockCircuitBreaker: { recordAttempt: vi.fn(() => 0), isOpen: vi.fn(() => false) },
  mockContinuity: {
    createSnapshot: vi.fn().mockResolvedValue(null),
    getSessionState: vi.fn(() => null),
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
  },
  mockCreateAdapter: vi.fn(),
  mockPlanSessionRecovery: vi.fn(() => ({
    kind: 'fresh',
    reason: 'test fresh recovery',
    providerSessionPersisted: false,
  })),
  // getLockInfo defaults to null (uncontended) so no waitReason churn unless a
  // test opts into contention via mockReturnValue.
  mockSessionMutex: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    getLockInfo: vi.fn(() => null as null | { source: string; acquiredAt: number; durationMs: number; owner?: { operation?: string } }),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => 'test-id'),
}));

vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: vi.fn(() => mockSessionMutex),
}));

vi.mock('../../session/session-turn-supervisor', () => ({
  getOrCreateTurnSupervisor: vi.fn(() => mockSupervisor),
}));

vi.mock('./respawn-circuit-breaker', () => ({
  getOrCreateCircuitBreaker: vi.fn(() => mockCircuitBreaker),
  _resetAllCircuitBreakersForTesting: vi.fn(),
}));

vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: vi.fn(() => mockContinuity),
}));

vi.mock('./session-recovery', () => ({
  computeResumeConfigFingerprint: vi.fn(() => 'test-fingerprint'),
  planSessionRecovery: mockPlanSessionRecovery,
}));

vi.mock('../../display-items/interrupt-boundary-renderer', () => ({
  emitInterruptBoundaryDisplayMarker: vi.fn(),
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: mockCreateAdapter,
  })),
}));

vi.mock('../../runtime/operation-deadline', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtime/operation-deadline')>();
  return real; // use real implementation — we test via timer advancement
});

import { InterruptRespawnHandler } from './interrupt-respawn-handler';
import { RuntimeReconciler } from './runtime-reconciler';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';

// ── Fake helpers ──────────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    status: 'busy',
    processId: 42,
    contextUsage: { used: 0, total: 100000 },
    adapterGeneration: 1,
    restartEpoch: 0,
    messageGenerationId: 0,
    respawnPromise: undefined,
    activeTurnId: 'turn-1',
    interruptRequestId: undefined,
    interruptRequestedAt: undefined,
    interruptPhase: undefined,
    lastTurnOutcome: undefined,
    lastActivity: Date.now(),
    cancelledForEdit: false,
    provider: 'claude',
    model: 'claude-3-5-sonnet',
    name: 'Test Instance',
    workingDirectory: '/tmp',
    createdAt: Date.now(),
    agentId: 'agent-1',
    ...overrides,
  } as unknown as Instance;
}

function makeAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    getName: vi.fn(() => 'claude-cli'),
    interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    terminate: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    spawn: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as CliAdapter;
}

interface FakeDepsState {
  instance: Instance | undefined;
  adapter: CliAdapter | undefined;
  queueUpdateCalls: unknown[][];
  outputMessages: OutputMessage[];
  transitions: InstanceStatus[];
}

function makeDeps(state: FakeDepsState): InterruptRespawnDeps {
  const deps: InterruptRespawnDeps = {
    getInstance: () => state.instance,
    getAdapter: () => state.adapter,
    setAdapter: (_id, a) => { state.adapter = a; },
    deleteAdapter: () => { state.adapter = undefined; },
    queueUpdate: (...args) => { state.queueUpdateCalls.push(args); },
    markInterrupted: vi.fn(),
    clearInterrupted: vi.fn(),
    addToOutputBuffer: (_inst, msg) => state.outputMessages.push(msg),
    setupAdapterEvents: vi.fn(),
    transitionState: (inst, newState) => {
      inst.status = newState;
      state.transitions.push(newState);
    },
    getAdapterRuntimeCapabilities: vi.fn(() => ({
      supportsResume: false, supportsForkSession: false,
      supportsNativeCompaction: false, supportsPermissionPrompts: false,
      supportsDeferPermission: false, selfManagedAutoCompaction: false,
    })),
    resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude'),
    getMcpConfig: vi.fn(() => []),
    getPermissionHookPath: vi.fn(() => undefined),
    waitForResumeHealth: vi.fn().mockResolvedValue(true),
    waitForAdapterWritable: vi.fn().mockResolvedValue(true),
    buildReplayContinuityMessage: vi.fn(() => 'replay preamble'),
    buildFallbackHistory: vi.fn().mockResolvedValue('fallback history'),
    applyRecoveryRespawn: undefined as unknown as InterruptRespawnDeps['applyRecoveryRespawn'],
    emitOutput: vi.fn(),
  };
  // Real spawn core so the fallback-ordering tests keep exercising the actual
  // logic — a RuntimeReconciler wired to the same fake state, exactly like the
  // lifecycle wiring in production. Only the members applyRecoveryRespawn uses
  // are provided.
  const reconciler = new RuntimeReconciler({
    getInstance: deps.getInstance,
    setAdapter: deps.setAdapter,
    setupAdapterEvents: deps.setupAdapterEvents,
    createRuntimeAdapter: (cliType: unknown, options: unknown, executionLocation: unknown) =>
      mockCreateAdapter(cliType, options, executionLocation),
    waitForResumeHealth: (id: string) => deps.waitForResumeHealth(id),
    buildReplayContinuityMessage: deps.buildReplayContinuityMessage,
    buildFallbackHistory: deps.buildFallbackHistory,
  } as unknown as RuntimeReconcilerDeps);
  deps.applyRecoveryRespawn = (instanceId, request, hooks) =>
    reconciler.applyRecoveryRespawn(instanceId, request, hooks);
  return deps;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InterruptRespawnHandler.interrupt()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when instance is not found', () => {
    const state: FakeDepsState = { instance: undefined, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));
    expect(handler.interrupt('inst-1')).toBe(false);
  });

  it('returns false when adapter is not found', () => {
    const state: FakeDepsState = { instance: makeInstance(), adapter: undefined, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));
    expect(handler.interrupt('inst-1')).toBe(false);
  });

  it('returns false when instance is in non-interruptible status', () => {
    const state: FakeDepsState = { instance: makeInstance({ status: 'idle' }), adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));
    expect(handler.interrupt('inst-1')).toBe(false);
  });

  it('returns false when adapter.interrupt() returns rejected', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'rejected', reason: 'not supported' } as InterruptResult)),
    });
    const state: FakeDepsState = { instance: makeInstance({ status: 'busy' }), adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));
    expect(handler.interrupt('inst-1')).toBe(false);
    // No state transition should occur
    expect(state.transitions).toHaveLength(0);
  });

  it('accepted-without-completion: transitions to interrupting and creates respawnPromise', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    const result = handler.interrupt('inst-1');

    expect(result).toBe(true);
    expect(state.transitions).toContain('interrupting');
    expect(instance.respawnPromise).toBeInstanceOf(Promise);
  });

  it('accepted-without-completion: force-abort net fires and transitions to cancelled', async () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');
    expect(instance.respawnPromise).toBeInstanceOf(Promise);

    // Advance past INTERRUPT_FORCE_ABORT_MS (30_000)
    vi.advanceTimersByTime(31_000);
    await Promise.resolve(); // flush microtasks

    expect(state.transitions).toContain('cancelled');
    expect(instance.respawnPromise).toBeUndefined();
    expect(instance.interruptPhase).toBe('escalated');
  });

  it('force-abort net stands down when a respawn has replaced the adapter', async () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');
    expect(state.transitions).toContain('interrupting');

    // Simulate an in-flight respawn installing a healthy replacement adapter
    // before the force-abort deadline.
    const replacement = makeAdapter();
    state.adapter = replacement;

    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    // The net must NOT force-cancel the recovered session, tear down the
    // replacement adapter, or emit a contradictory "force-cancelled" banner.
    expect(state.transitions).not.toContain('cancelled');
    expect(replacement.terminate).not.toHaveBeenCalled();
    expect(state.outputMessages.some((m) => /force-cancelled/i.test(m.content))).toBe(false);
  });

  it('user interrupt suppresses unexpected-exit auto-respawn (sets autoRespawnSuppressedUntil past the force-abort window)', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    const before = Date.now();
    handler.interrupt('inst-1');

    expect(instance.autoRespawnSuppressedUntil).toBeDefined();
    // Must cover at least the 30s force-abort window so a CLI exit during
    // interrupt handling cannot resurrect the session and continue the model.
    expect(instance.autoRespawnSuppressedUntil!).toBeGreaterThan(before + 30_000);
  });

  it('noteInterruptSettled disarms the force-abort net when the CLI settles in place', async () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');
    expect(instance.respawnPromise).toBeInstanceOf(Promise);

    // Simulate the resident CLI settling back to idle (the status handler would
    // have already transitioned the instance) and notify the handler.
    instance.status = 'idle';
    handler.noteInterruptSettled('inst-1');

    // The net is disarmed: respawn promise resolved, interrupt marked completed.
    expect(instance.respawnPromise).toBeUndefined();
    expect(instance.interruptPhase).toBe('completed');

    // Advancing past the 30s deadline must NOT force-cancel the healthy session.
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(state.transitions).not.toContain('cancelled');
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(state.outputMessages.some((m) => /force-cancelled/i.test(m.content))).toBe(false);
  });

  it('noteInterruptSettled is a no-op when no interrupt is in flight', () => {
    const instance = makeInstance({ status: 'idle' });
    const state: FakeDepsState = { instance, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    // No interrupt armed — must not touch interrupt bookkeeping.
    handler.noteInterruptSettled('inst-1');

    expect(instance.interruptPhase).toBeUndefined();
    expect(state.transitions).toHaveLength(0);
  });

  it('second-interrupt escalation: transitions to cancelled immediately', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1'); // first — goes to 'interrupting'
    expect(state.transitions).toContain('interrupting');

    handler.interrupt('inst-1'); // second — should escalate immediately

    expect(state.transitions).toContain('interrupt-escalating');
    expect(state.transitions).toContain('cancelled');
    expect(instance.respawnPromise).toBeUndefined(); // resolved by escalation
    expect(instance.interruptPhase).toBe('escalated');
  });

  it('second-interrupt escalation: deletes adapter so no further operations can use it', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const deps = makeDeps(state);
    const deleteAdapterSpy = vi.spyOn(deps, 'deleteAdapter');
    const handler = new InterruptRespawnHandler(deps);

    handler.interrupt('inst-1'); // accepted → interrupting
    handler.interrupt('inst-1'); // escalation

    expect(deleteAdapterSpy).toHaveBeenCalledWith('inst-1');
    expect(state.adapter).toBeUndefined(); // deleted by escalation path
  });

  it('never-settling completion: A3 deadline fires; force-abort net handles cleanup (NOT idle at 15s)', async () => {
    let completionResolve: (v: { status: 'interrupted' }) => void;
    const neverSettles = new Promise<{ status: 'interrupted' }>((_resolve) => {
      completionResolve = _resolve;
    });
    void completionResolve!; // prevent unused warning

    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted', completion: neverSettles } as unknown as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');
    expect(state.transitions).toContain('interrupting');

    // Advance past INTERRUPT_COMPLETION_DEADLINE_MS (15s) — handleInterruptCompletion
    // returns early (A3 fix). Force-abort net is still armed; instance NOT idle yet.
    vi.advanceTimersByTime(16_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.transitions).not.toContain('idle');
    expect(instance.respawnPromise).toBeDefined(); // force-abort not yet fired

    // Advance to 31s total — force-abort net fires, terminates adapter, settles to 'cancelled'.
    vi.advanceTimersByTime(15_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.terminate).toHaveBeenCalledWith(true);
    expect(state.transitions).toContain('cancelled');
    expect(instance.respawnPromise).toBeUndefined();
  });

  it('records interrupt in SessionTurnSupervisor when accepted', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');

    expect(mockSupervisor.recordInterrupt).toHaveBeenCalledOnce();
  });

  it('sets interrupt-ack waitReason when interrupt is accepted', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');

    // The interrupting queueUpdate (arg index 10) should include interrupt-ack waitReason.
    const interruptingCall = state.queueUpdateCalls.find(args => args[1] === 'interrupting');
    expect(interruptingCall).toBeDefined();
    expect((interruptingCall![10] as { kind?: string } | null | undefined)?.kind).toBe('interrupt-ack');
  });

  it('force-abort net clears waitReason in cancelled queueUpdate', async () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1');

    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    // The force-abort 'cancelled' queueUpdate (arg index 10) should be null (clear).
    const cancelledCall = state.queueUpdateCalls.find(args => args[1] === 'cancelled');
    expect(cancelledCall).toBeDefined();
    expect(cancelledCall![10]).toBeNull();
  });

  it('second-interrupt escalation clears waitReason in cancelled queueUpdate', () => {
    const adapter = makeAdapter({
      interrupt: vi.fn(() => ({ status: 'accepted' } as InterruptResult)),
    });
    const instance = makeInstance({ status: 'busy' });
    const state: FakeDepsState = { instance, adapter, queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    handler.interrupt('inst-1'); // first — goes to 'interrupting'
    handler.interrupt('inst-1'); // second — escalates to cancelled

    const cancelledCall = state.queueUpdateCalls.find(args => args[1] === 'cancelled');
    expect(cancelledCall).toBeDefined();
    expect(cancelledCall![10]).toBeNull();
  });
});

describe('InterruptRespawnHandler.respawnAfterInterrupt() — mutex waitReason (C3/§4.G)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCircuitBreaker.recordAttempt.mockReturnValue(0);
    mockSessionMutex.acquire.mockResolvedValue(vi.fn());
    mockSessionMutex.getLockInfo.mockReturnValue(null);
  });

  it('surfaces a `mutex` waitReason when the session lock is contended, then clears it', async () => {
    // status 'cancelled' makes shouldAbortRespawn() return true right after the
    // lock is acquired, so respawn exits before spawning a new adapter.
    const instance = makeInstance({ status: 'cancelled' });
    const state: FakeDepsState = { instance, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    mockSessionMutex.getLockInfo.mockReturnValue({
      source: 'autosave', acquiredAt: Date.now(), durationMs: 1234, owner: { operation: 'save' },
    });

    await handler.respawnAfterInterrupt('inst-1');

    const mutexCalls = state.queueUpdateCalls.filter(
      (args) => (args[10] as { kind?: string } | null)?.kind === 'mutex',
    );
    expect(mutexCalls).toHaveLength(1);
    expect(mutexCalls[0][10]).toMatchObject({ kind: 'mutex', operation: 'respawn', owner: 'save' });

    // The reason must be cleared (null) after we own the lock.
    const idx = state.queueUpdateCalls.indexOf(mutexCalls[0]);
    const clearedAfter = state.queueUpdateCalls.slice(idx + 1).some((args) => args[10] === null);
    expect(clearedAfter).toBe(true);
  });

  it('does not churn waitReason when the session lock is uncontended', async () => {
    const instance = makeInstance({ status: 'cancelled' });
    const state: FakeDepsState = { instance, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const handler = new InterruptRespawnHandler(makeDeps(state));

    mockSessionMutex.getLockInfo.mockReturnValue(null);

    await handler.respawnAfterInterrupt('inst-1');

    const mutexCalls = state.queueUpdateCalls.filter(
      (args) => (args[10] as { kind?: string } | null)?.kind === 'mutex',
    );
    expect(mutexCalls).toHaveLength(0);
  });
});

describe('InterruptRespawnHandler recovery replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCircuitBreaker.recordAttempt.mockReturnValue(0);
    mockPlanSessionRecovery.mockReturnValue({
      kind: 'fresh',
      reason: 'test fresh recovery',
      providerSessionPersisted: false,
    });
    mockSessionMutex.getLockInfo.mockReturnValue(null);
  });

  it('queues fresh-session continuity for the next user turn instead of running replay under the session lock', async () => {
    const release = vi.fn();
    // Mirror the real mutex: after acquire, getLockInfo reports a holder —
    // applyRecoveryRespawn asserts the caller holds the session lock.
    mockSessionMutex.acquire.mockImplementation(async () => {
      mockSessionMutex.getLockInfo.mockReturnValue({
        source: 'respawn-unexpected', acquiredAt: Date.now(), durationMs: 0,
      });
      return release;
    });
    const previousAdapter = makeAdapter();
    const replacementAdapter = makeAdapter({
      spawn: vi.fn().mockResolvedValue(84),
    });
    mockCreateAdapter.mockReturnValue(replacementAdapter);
    const instance = makeInstance({
      status: 'respawning',
      executionLocation: { type: 'local' },
      outputBuffer: [{
        id: 'user-1',
        type: 'user',
        content: 'Keep this context',
        timestamp: Date.now(),
      }],
      sessionId: 'old-session',
    });
    const state: FakeDepsState = {
      instance,
      adapter: previousAdapter,
      queueUpdateCalls: [],
      outputMessages: [],
      transitions: [],
    };
    const deps = makeDeps(state);
    deps.queueContinuityPreamble = vi.fn();
    const handler = new InterruptRespawnHandler(deps);

    await handler.respawnAfterUnexpectedExit('inst-1');

    expect(deps.queueContinuityPreamble).toHaveBeenCalledWith('inst-1', 'replay preamble');
    expect(replacementAdapter.sendInput).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(instance.status).toBe('idle');
  });

  it('queues transcript fallback after native resume fails instead of replaying it under the session lock', async () => {
    const release = vi.fn();
    // Mirror the real mutex: after acquire, getLockInfo reports a holder —
    // applyRecoveryRespawn asserts the caller holds the session lock.
    mockSessionMutex.acquire.mockImplementation(async () => {
      mockSessionMutex.getLockInfo.mockReturnValue({
        source: 'respawn-interrupt', acquiredAt: Date.now(), durationMs: 0,
      });
      return release;
    });
    mockPlanSessionRecovery.mockReturnValue({
      kind: 'native-resume',
      reason: 'persisted provider session is resumable',
      providerSessionPersisted: true,
    });
    const previousAdapter = makeAdapter();
    const resumeAdapter = makeAdapter({
      spawn: vi.fn().mockResolvedValue(81),
    });
    const fallbackAdapter = makeAdapter({
      spawn: vi.fn().mockResolvedValue(82),
    });
    mockCreateAdapter
      .mockReturnValueOnce(resumeAdapter)
      .mockReturnValueOnce(fallbackAdapter);
    const instance = makeInstance({
      status: 'busy',
      executionLocation: { type: 'local' },
      outputBuffer: [{
        id: 'user-1',
        type: 'user',
        content: 'Keep this context',
        timestamp: Date.now(),
      }],
      providerSessionPersisted: true,
      sessionId: 'old-session',
    });
    const state: FakeDepsState = {
      instance,
      adapter: previousAdapter,
      queueUpdateCalls: [],
      outputMessages: [],
      transitions: [],
    };
    const deps = makeDeps(state);
    deps.getAdapterRuntimeCapabilities = vi.fn(() => ({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    }));
    deps.waitForResumeHealth = vi.fn().mockResolvedValue(false);
    deps.queueContinuityPreamble = vi.fn();
    const handler = new InterruptRespawnHandler(deps);

    await handler.respawnAfterInterrupt('inst-1');

    expect(resumeAdapter.terminate).toHaveBeenCalledWith(true);
    expect(deps.queueContinuityPreamble).toHaveBeenCalledWith('inst-1', 'fallback history');
    expect(fallbackAdapter.sendInput).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(instance.status).toBe('idle');
  });
});

describe('InterruptRespawnHandler recovery-ladder exhaustion (WS7 Phase B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCircuitBreaker.recordAttempt.mockReturnValue(0);
    mockPlanSessionRecovery.mockReturnValue({ kind: 'fresh', reason: 'fresh', providerSessionPersisted: false });
    mockSessionMutex.acquire.mockImplementation(async () => {
      mockSessionMutex.getLockInfo.mockReturnValue({ source: 'respawn', acquiredAt: Date.now(), durationMs: 0 });
      return vi.fn();
    });
  });

  it('fires onRecoveryLadderExhausted when the fresh spawn fails terminally', async () => {
    // Fresh (non-resume) plan whose only spawn rejects → no fallback → error catch.
    const deadAdapter = makeAdapter({ spawn: vi.fn().mockRejectedValue(new Error('provider auth 401')) });
    mockCreateAdapter.mockReturnValue(deadAdapter);
    const instance = makeInstance({ status: 'respawning', executionLocation: { type: 'local' }, outputBuffer: [] });
    const state: FakeDepsState = { instance, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const deps = makeDeps(state);
    const onRecoveryLadderExhausted = vi.fn();
    deps.onRecoveryLadderExhausted = onRecoveryLadderExhausted;
    const handler = new InterruptRespawnHandler(deps);

    await expect(handler.respawnAfterInterrupt('inst-1')).rejects.toThrow('provider auth 401');

    expect(instance.status).toBe('error');
    expect(onRecoveryLadderExhausted).toHaveBeenCalledWith(instance, expect.any(Error));
  });

  it('does not fire the callback on a successful respawn', async () => {
    const okAdapter = makeAdapter({ spawn: vi.fn().mockResolvedValue(99) });
    mockCreateAdapter.mockReturnValue(okAdapter);
    const instance = makeInstance({ status: 'respawning', executionLocation: { type: 'local' }, outputBuffer: [] });
    const state: FakeDepsState = { instance, adapter: makeAdapter(), queueUpdateCalls: [], outputMessages: [], transitions: [] };
    const deps = makeDeps(state);
    const onRecoveryLadderExhausted = vi.fn();
    deps.onRecoveryLadderExhausted = onRecoveryLadderExhausted;
    const handler = new InterruptRespawnHandler(deps);

    await handler.respawnAfterInterrupt('inst-1');

    expect(instance.status).toBe('idle');
    expect(onRecoveryLadderExhausted).not.toHaveBeenCalled();
  });
});
