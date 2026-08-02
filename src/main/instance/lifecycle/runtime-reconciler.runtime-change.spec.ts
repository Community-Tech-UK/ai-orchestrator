/**
 * RuntimeReconciler.applyRuntimeChange — session-continuity invariants.
 *
 * Regression coverage for LT-008: a yolo-only toggle on a conversation-bearing
 * Claude session resolves to `native-resume-fork`, and the reconciler used to
 * mint the fork's TARGET id itself and hand it to the adapter as the resume
 * SOURCE. No transcript exists for an id the CLI has never minted, so the
 * adapter silently skipped `--resume`, the health probe found no proof, and a
 * perfectly live session was torn down (`Illegal transition: error → busy`).
 *
 * Also covers the second half of LT-008: the runtime-change path collapsed an
 * `inconclusive` resume-health verdict to "destroy the session", where the
 * recovery path deliberately keeps it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';

const { mockContinuity, mockSessionMutex } = vi.hoisted(() => ({
  mockContinuity: {
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
  },
  mockSessionMutex: {
    acquire: vi.fn().mockResolvedValue(() => {}),
    getLockInfo: vi.fn(() => null),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: vi.fn(() => mockSessionMutex),
}));
vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: vi.fn(() => mockContinuity),
  getSessionContinuityManagerIfInitialized: vi.fn(() => mockContinuity),
}));
vi.mock('./create-validation-helpers', () => ({
  getKnownModelsForCli: vi.fn().mockResolvedValue(['sonnet', 'opus']),
}));
vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => 'minted-fork-id'),
}));

import { RuntimeReconciler } from './runtime-reconciler';
import {
  AdapterOnLoanError,
  beginAdapterLoan,
  endAdapterLoan,
  _resetAdapterLoansForTesting,
} from './adapter-loan-registry';

const LIVE_SESSION_ID = 'live-claude-session';

function makeAdapter(spawnResult = 42): CliAdapter {
  const adapter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  adapter['spawn'] = vi.fn().mockResolvedValue(spawnResult);
  adapter['terminate'] = vi.fn().mockResolvedValue(undefined);
  adapter['sendInput'] = vi.fn().mockResolvedValue(undefined);
  return adapter as unknown as CliAdapter;
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    status: 'idle',
    provider: 'claude',
    currentModel: 'sonnet',
    sessionId: LIVE_SESSION_ID,
    yoloMode: false,
    workingDirectory: '/tmp/aio-lt',
    executionLocation: { type: 'local' },
    // A real conversation is what makes the fork path reachable at all.
    outputBuffer: [
      { type: 'user', content: 'hello' },
      { type: 'assistant', content: 'hi' },
    ],
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    ...overrides,
  } as unknown as Instance;
}

interface Harness {
  reconciler: RuntimeReconciler;
  instance: Instance;
  createCalls: Array<{ options: Record<string, unknown> }>;
  deleteAdapter: ReturnType<typeof vi.fn>;
  deps: {
    evaluateResumeHealth: ReturnType<typeof vi.fn>;
    transitionState: ReturnType<typeof vi.fn>;
    buildFallbackHistory: ReturnType<typeof vi.fn>;
    emitSystemNotice: ReturnType<typeof vi.fn>;
    emitModelSelectionDegradation: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  instance: Instance,
  adapters: CliAdapter[],
  opts: {
    noAdapter?: boolean;
    getAdapter?: () => CliAdapter | undefined;
    assertLocalModelRuntimeAvailable?: () => Promise<void>;
  } = {},
): Harness {
  let adapterIndex = 0;
  const deleteAdapter = vi.fn();
  const createCalls: Array<{ options: Record<string, unknown> }> = [];
  const deps = {
    evaluateResumeHealth: vi.fn().mockResolvedValue('healthy'),
    transitionState: vi.fn((inst: Instance, status: string) => {
      (inst as unknown as { status: string }).status = status;
    }),
    buildFallbackHistory: vi.fn().mockResolvedValue('fallback history'),
    emitSystemNotice: vi.fn(),
    emitModelSelectionDegradation: vi.fn(),
  };
  const reconciler = new RuntimeReconciler({
    getInstance: () => instance,
    getAdapter: opts.getAdapter ?? (() => (opts.noAdapter ? undefined : makeAdapter())),
    setAdapter: vi.fn(),
    deleteAdapter,
    setupAdapterEvents: vi.fn(),
    transitionState: deps.transitionState,
    resolveCliTypeForInstance: async () => 'claude',
    // Claude: resumable and forkable — the exact shape that triggered LT-008.
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: true }),
    assertLocalModelRuntimeAvailable: opts.assertLocalModelRuntimeAvailable ?? vi.fn(),
    residentClaudeForSpawn: () => false,
    createRuntimeAdapter: (_cliType: unknown, options: Record<string, unknown>) => {
      createCalls.push({ options });
      const adapter = adapters[Math.min(adapterIndex, adapters.length - 1)];
      adapterIndex += 1;
      return adapter;
    },
    evaluateResumeHealth: deps.evaluateResumeHealth,
    // Kept so the pre-fix source (which collapsed the three-way verdict to a
    // boolean here) is exercised faithfully when this spec is used as a
    // negative control, rather than failing on an undefined dep.
    waitForResumeHealth: vi.fn(async () => (await deps.evaluateResumeHealth()) === 'healthy'),
    waitForInputReadinessBoundary: vi.fn().mockResolvedValue(undefined),
    prepareStatusForAdapterInput: vi.fn(),
    buildReplayContinuityMessage: () => 'replay preamble',
    buildFallbackHistory: deps.buildFallbackHistory,
    emitModelSelectionDegradation: deps.emitModelSelectionDegradation,
    emitSystemNotice: deps.emitSystemNotice,
    emitRuntimeChanged: vi.fn(),
    emitYoloToggled: vi.fn(),
    getSettings: () => ({ defaultCli: 'claude' }),
    spawnConfigBuilder: {
      getMcpConfig: () => undefined,
      getChromeDevtoolsMcpOptions: () => undefined,
      getBrowserGatewayMcpOptions: () => undefined,
      getPermissionHookPath: () => undefined,
      getRtkSpawnConfig: () => undefined,
    },
    queueUpdate: vi.fn(),
  } as unknown as RuntimeReconcilerDeps);
  return { reconciler, instance, createCalls, deps, deleteAdapter };
}

/** A pure permission-posture flip — the toggleYoloMode path. */
function yoloOnly(yoloMode: boolean): DesiredRuntime {
  return { provider: 'claude', yoloMode } as unknown as DesiredRuntime;
}

/**
 * A harness whose pre-teardown await lets a loop claim the adapter mid-flight —
 * standing in for the real cold-cache CLI probe on a provider swap, which takes
 * seconds and is the window the entry-time loan check cannot cover on its own.
 */
function makeHarnessWithLateLoan(instance: Instance): Harness {
  return makeHarness(instance, [makeAdapter()], {
    assertLocalModelRuntimeAvailable: async () => {
      await Promise.resolve();
      beginAdapterLoan('inst-1', 'loop-late');
    },
  });
}

/** A change carrying a local-model target, so the pre-teardown await runs. */
function localModelChange(): DesiredRuntime {
  return {
    provider: 'claude',
    modelRuntimeTarget: {
      kind: 'local-model',
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      selectorId: 'lm://this-device/ollama/ollama/qwen',
    },
  } as unknown as DesiredRuntime;
}

describe('RuntimeReconciler.applyRuntimeChange — fork resume source (LT-008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.acquire.mockResolvedValue(() => {});
    mockContinuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
    mockContinuity.updateState.mockResolvedValue(undefined);
  });

  it('resumes FROM the live session id when forking, not from the newly minted target id', async () => {
    const { reconciler, createCalls } = makeHarness(makeInstance(), [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(createCalls).toHaveLength(1);
    const spawned = createCalls[0].options;
    expect(spawned['resume']).toBe(true);
    expect(spawned['forkSession']).toBe(true);
    // The regression: this was 'minted-fork-id', an id the CLI has never seen,
    // so the adapter skipped --resume and the session was destroyed.
    expect(spawned['sessionId']).toBe(LIVE_SESSION_ID);
  });

  it('still advances instance.sessionId to the forked id (the CLI re-adopts the authoritative one)', async () => {
    const { reconciler, instance } = makeHarness(makeInstance(), [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(instance.sessionId).toBe('minted-fork-id');
  });

  it('keeps the live session and never enters error on a yolo toggle', async () => {
    const { reconciler, instance, createCalls } = makeHarness(makeInstance(), [makeAdapter(77)]);

    const result = await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(result.yoloMode).toBe(true);
    expect(result.status).toBe('idle');
    expect(instance.processId).toBe(77);
    // No fresh-fallback adapter was ever needed.
    expect(createCalls).toHaveLength(1);
  });

  it('passes the same id through when resuming without a fork', async () => {
    const { reconciler, createCalls } = makeHarness(makeInstance(), [makeAdapter()]);
    // A provider whose adapter resumes in place rather than forking.
    (reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps.getAdapterRuntimeCapabilities =
      () => ({ supportsResume: true, supportsForkSession: false });

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(createCalls[0].options['forkSession']).toBe(false);
    expect(createCalls[0].options['sessionId']).toBe(LIVE_SESSION_ID);
  });
});

/**
 * LT-018. A cross-provider swap forces `planContinuity` to 'replay', which mints
 * a brand-new session id — so the previous provider's `used` belongs to a
 * session that no longer exists, and its `occupancyReported` is a claim about a
 * runtime being torn down. Spreading them across the swap produced a
 * *confident* percentage computed from the old provider's token count against
 * the new provider's window, broadcast in a visible `idle` state before the new
 * runtime had run a turn. A swap to a smaller window could fake >=95%, which
 * disables the composer.
 */
describe('RuntimeReconciler.applyRuntimeChange — occupancy across a swap (LT-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.acquire.mockResolvedValue(() => {});
    mockContinuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
    mockContinuity.updateState.mockResolvedValue(undefined);
  });

  it('clears occupancy when the session identity is minted fresh', async () => {
    const reported = makeInstance({
      contextUsage: { used: 124_000, total: 200_000, percentage: 62, occupancyReported: true },
    });
    const { reconciler, instance } = makeHarness(reported, [makeAdapter()]);
    (reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps.getAdapterRuntimeCapabilities =
      () => ({ supportsResume: false, supportsForkSession: false });

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(instance.contextUsage.used).toBe(0);
    expect(instance.contextUsage.percentage).toBe(0);
    expect(instance.contextUsage.occupancyReported).toBeUndefined();
  });

  it('keeps occupancy when the session genuinely resumes', async () => {
    const reported = makeInstance({
      contextUsage: { used: 124_000, total: 200_000, percentage: 62, occupancyReported: true },
    });
    const { reconciler, instance } = makeHarness(reported, [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(instance.contextUsage.used).toBe(124_000);
    expect(instance.contextUsage.occupancyReported).toBe(true);
  });

  /**
   * The occupancy decision is made BEFORE spawn, assuming the resume succeeds.
   * When the health probe then fails and the method falls back to a brand-new
   * session, that assumption is void — without recomputing, the instance keeps
   * the dead runtime's `used` and flag, rescaled to the new window, for a
   * session that has produced zero turns.
   */
  it('clears occupancy when a planned resume fails and falls back to a fresh session', async () => {
    const reported = makeInstance({
      contextUsage: { used: 124_000, total: 200_000, percentage: 62, occupancyReported: true },
    });
    const { reconciler, instance, deps } = makeHarness(reported, [makeAdapter(), makeAdapter(88)]);
    deps.evaluateResumeHealth.mockResolvedValue('unrecoverable');

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(instance.contextUsage.used).toBe(0);
    expect(instance.contextUsage.occupancyReported).toBeUndefined();
  });

  it('preserves accrued cost across a fresh-session swap', async () => {
    const reported = makeInstance({
      contextUsage: {
        used: 124_000, total: 200_000, percentage: 62, occupancyReported: true, costEstimate: 3.5,
      },
    });
    const { reconciler, instance } = makeHarness(reported, [makeAdapter()]);
    (reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps.getAdapterRuntimeCapabilities =
      () => ({ supportsResume: false, supportsForkSession: false });

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    // Spend already incurred does not become untrue because the runtime changed.
    expect(instance.contextUsage.costEstimate).toBe(3.5);
    expect(instance.contextUsage.occupancyReported).toBeUndefined();
  });
});

describe('RuntimeReconciler.applyRuntimeChange — resume-health policy (LT-008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.acquire.mockResolvedValue(() => {});
  });

  it('keeps the live session when resume health is inconclusive (retries, never destroys)', async () => {
    const { reconciler, instance, createCalls, deps } = makeHarness(
      makeInstance(),
      [makeAdapter(88)],
    );
    deps.evaluateResumeHealth.mockResolvedValue('inconclusive');

    const result = await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(result.status).toBe('idle');
    expect(instance.processId).toBe(88);
    // The regression: an inconclusive verdict used to collapse to false, throw
    // 'Native resume did not stabilize', and fresh-fallback (2nd adapter).
    expect(createCalls).toHaveLength(1);
    // Inconclusive is retried exactly once before being accepted.
    expect(deps.evaluateResumeHealth).toHaveBeenCalledTimes(2);
  });

  it('falls back to a fresh session only when resume is proven unrecoverable', async () => {
    const { reconciler, createCalls, deps } = makeHarness(
      makeInstance(),
      [makeAdapter(88), makeAdapter(99)],
    );
    deps.evaluateResumeHealth.mockResolvedValue('unrecoverable');

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(createCalls).toHaveLength(2);
    expect(createCalls[1].options['resume']).toBe(false);
    expect(createCalls[1].options['forkSession']).toBe(false);
    expect(deps.buildFallbackHistory).toHaveBeenCalled();
  });
});

// LT-015: the runtime-change notices were delivered with `adapter.sendInput`,
// which reaches the CLI but produces no visible message. Three live-check
// families asserted on a transcript line that could never appear. They must now
// be both delivered AND recorded.
describe('RuntimeReconciler.applyRuntimeChange — runtime-change notices are visible (LT-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.acquire.mockResolvedValue(() => {});
    mockContinuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
    mockContinuity.updateState.mockResolvedValue(undefined);
  });

  it('records the YOLO-enabled notice in the transcript, not only to the CLI', async () => {
    const { reconciler, deps } = makeHarness(makeInstance(), [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(deps.emitSystemNotice).toHaveBeenCalledTimes(1);
    const [, content, metadata] = deps.emitSystemNotice.mock.calls[0];
    expect(content).toContain('[System: YOLO mode enabled');
    expect(metadata).toMatchObject({ kind: 'yolo-mode-changed' });
  });

  it('records the YOLO-disabled notice too', async () => {
    const instance = makeInstance();
    (instance as unknown as { yoloMode: boolean }).yoloMode = true;
    const { reconciler, deps } = makeHarness(instance, [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(false));

    expect(deps.emitSystemNotice).toHaveBeenCalledTimes(1);
    expect(deps.emitSystemNotice.mock.calls[0][1]).toContain('[System: YOLO mode disabled');
  });

  it('still delivers the notice to the adapter as well as recording it', async () => {
    const adapter = makeAdapter();
    const { reconciler, deps } = makeHarness(makeInstance(), [adapter]);

    await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    const delivered = (adapter.sendInput as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]));
    expect(delivered.some((text) => text.includes('[System: YOLO mode enabled'))).toBe(true);
    expect(deps.emitSystemNotice).toHaveBeenCalled();
  });

  it('does not abort the runtime change when rendering the notice throws', async () => {
    const { reconciler, deps, instance } = makeHarness(makeInstance(), [makeAdapter(77)]);
    deps.emitSystemNotice.mockImplementation(() => {
      throw new Error('renderer detached');
    });

    // The change has already been applied to the live session by this point;
    // a failed transcript write must not undo it.
    const result = await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));

    expect(result.yoloMode).toBe(true);
    expect(result.status).toBe('idle');
    expect(instance.processId).toBe(77);
  });
});

/**
 * LT-020. The reconciler is the single choke point for every change-driven
 * respawn, so the loan guard has to live here — not only in the queue.
 */
describe('RuntimeReconciler — adapter loans (LT-020)', () => {
  beforeEach(() => {
    _resetAdapterLoansForTesting();
  });

  it('refuses a change while a loop iteration holds the adapter', async () => {
    const { reconciler } = makeHarness(makeInstance(), [makeAdapter()]);
    const loan = beginAdapterLoan('inst-1', 'loop-a');

    await expect(reconciler.applyRuntimeChange('inst-1', yoloOnly(true)))
      .rejects.toBeInstanceOf(AdapterOnLoanError);

    endAdapterLoan(loan);
  });

  it('re-checks the loan immediately before terminating, closing the await window', async () => {
    // A provider swap awaits CLI availability before teardown. If the loop
    // starts its next iteration during that await, the first check has already
    // passed — and terminating anyway is the original defect.
    const instance = makeInstance();
    const { reconciler, deleteAdapter } = makeHarnessWithLateLoan(instance);

    await expect(reconciler.applyRuntimeChange('inst-1', localModelChange()))
      .rejects.toBeInstanceOf(AdapterOnLoanError);

    // The decisive assertion: the old adapter was never torn down.
    expect(deleteAdapter).not.toHaveBeenCalled();
  });

  it('allows the change when the adapter is already gone (failover must not be blocked)', async () => {
    const instance = makeInstance({ status: 'error' } as Partial<Instance>);
    const { reconciler } = makeHarness(instance, [makeAdapter(99)], { noAdapter: true });
    beginAdapterLoan('inst-1', 'loop-a');

    // A dead CLI has nothing to SIGTERM, and blocking here would strand the
    // instance on a failing provider — the case `error` is an allowed status for.
    const result = await reconciler.applyRuntimeChange('inst-1', yoloOnly(true));
    expect(result.yoloMode).toBe(true);
  });
});
