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
import type { CliAdapter, UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { InterruptResult } from '../../cli/adapters/base-cli-adapter';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const { mockSupervisor, mockCircuitBreaker, mockContinuity } = vi.hoisted(() => ({
  mockSupervisor: { recordInterrupt: vi.fn(), recordTurnEnd: vi.fn(), recordAdapterSetup: vi.fn() },
  mockCircuitBreaker: { recordAttempt: vi.fn(() => 0), isOpen: vi.fn(() => false) },
  mockContinuity: { createSnapshot: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => 'test-id'),
}));

vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: vi.fn(() => ({
    acquire: vi.fn().mockResolvedValue(vi.fn()),
  })),
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
  planSessionRecovery: vi.fn().mockResolvedValue({
    strategy: 'fresh',
    sessionId: undefined,
    reason: 'test',
    providerSessionPersisted: false,
  }),
}));

vi.mock('../../display-items/interrupt-boundary-renderer', () => ({
  emitInterruptBoundaryDisplayMarker: vi.fn(),
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: vi.fn(),
  })),
}));

vi.mock('../../runtime/operation-deadline', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtime/operation-deadline')>();
  return real; // use real implementation — we test via timer advancement
});

import { InterruptRespawnHandler } from './interrupt-respawn-handler';

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
  return {
    getInstance: (_id) => state.instance,
    getAdapter: (_id) => state.adapter,
    setAdapter: (_id, a) => { state.adapter = a; },
    deleteAdapter: (_id) => { state.adapter = undefined; },
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
    emitOutput: vi.fn(),
  };
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

  it('never-settling completion: A3 deadline fires; instance transitions to idle', async () => {
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

    // Advance past INTERRUPT_COMPLETION_DEADLINE_MS (15_000)
    vi.advanceTimersByTime(16_000);
    // Allow promise chain microtasks to run
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The deadline fires, result becomes {status:'rejected'}, and handleInterruptCompletion
    // transitions to idle and resolves respawnPromise.
    expect(state.transitions).toContain('idle');
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
});
