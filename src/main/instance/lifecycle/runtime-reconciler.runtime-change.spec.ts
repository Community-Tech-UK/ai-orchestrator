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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { TestAcpCliAdapter, createInitializedAgentHarness } from '../../cli/adapters/acp-cli-adapter.test-helpers';
import { ProviderAccountBindingService } from '../../providers/account-pool/provider-account-binding-service';
import { ProviderAccountRoutingService, _resetProviderAccountRoutingServiceForTesting } from '../../providers/account-pool/provider-account-routing-service';

const { mockContinuity, mockSessionMutex, mockProcessKill } = vi.hoisted(() => ({
  mockProcessKill: vi.fn(() => false),
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
vi.mock('../../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: mockProcessKill }));
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
const accountPool = vi.hoisted(() => ({ continuation: 'shared-store' as 'shared-store' | 'replay' }));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getPoolPolicy: () => ({ continuation: accountPool.continuation }),
    getProfile: (provider: string, id: string) => ({
      id, provider, label: id === 'legacy' ? 'Existing Claude account' : `Max ${id}`,
      expectedIdentity: null, expectedAccountKey: null, planLabel: null, priority: 0,
      enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy',
      ...(provider === 'opencode' ? { region: 'ams' } : {}), createdAt: 1, updatedAt: 1,
    }),
  }),
}));
vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => 'minted-fork-id'),
}));

import { RuntimeReconciler } from './runtime-reconciler';
import { getKnownModelsForCli } from './create-validation-helpers';
import * as providerSwap from './model-change-provider-swap';
import {
  AdapterOnLoanError,
  beginAdapterLoan,
  endAdapterLoan,
  _resetAdapterLoansForTesting,
} from './adapter-loan-registry';

const LIVE_SESSION_ID = 'live-claude-session';

beforeEach(() => _resetProviderAccountRoutingServiceForTesting(new ProviderAccountRoutingService({
  bindingService: new ProviderAccountBindingService({
    readOpenCodeAuthList: async () => '┌  Credentials\n●  aio-mimo-b api\n└  1 credentials\n',
  }),
})));
afterEach(() => _resetProviderAccountRoutingServiceForTesting());

function makeAdapter(spawnResult = 42): CliAdapter {
  const adapter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  adapter['spawn'] = vi.fn().mockResolvedValue(spawnResult);
  adapter['terminate'] = vi.fn().mockResolvedValue(undefined);
  adapter['sendInput'] = vi.fn().mockResolvedValue(undefined);
  adapter['queueNextPromptContext'] = vi.fn();
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
    resolveCliTypeForInstance: async () => instance.provider,
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

describe('RuntimeReconciler.applyRuntimeChange — account-pool handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.acquire.mockResolvedValue(() => {});
    _resetAdapterLoansForTesting();
    accountPool.continuation = 'shared-store';
  });

  function handoff(kind: 'explicit' | 'failover' | 'preemptive', confirmed = false): DesiredRuntime {
    return {
      provider: 'claude',
      accountProfileId: 'b',
      accountHandoffKind: kind,
      ...(confirmed ? { accountHandoffConfirmed: true } : {}),
    } as unknown as DesiredRuntime;
  }

  it('requires confirmation only for an explicit switch', async () => {
    const explicit = makeHarness(makeInstance(), [makeAdapter()]);
    await expect(explicit.reconciler.applyRuntimeChange('inst-1', handoff('explicit'))).rejects.toThrow(/confirmation/);
    expect(explicit.instance.accountProfileId).toBeUndefined();

    const failover = makeHarness(makeInstance(), [makeAdapter()]);
    await failover.reconciler.applyRuntimeChange('inst-1', handoff('failover'));
    expect(failover.instance).toMatchObject({ accountProfileId: 'b', accountRoutingSource: 'failover', accountSwitches: 1 });
  });

  it('natively resumes a Claude conversation across accounts under a shared store', async () => {
    const { reconciler, createCalls } = makeHarness(makeInstance(), [makeAdapter()]);
    await reconciler.applyRuntimeChange('inst-1', handoff('failover'));
    expect(createCalls[0].options['resume']).toBe(true);
    expect(createCalls[0].options['sessionId']).toBe(LIVE_SESSION_ID);
  });

  it('replays under the replay continuation policy', async () => {
    accountPool.continuation = 'replay';
    const { reconciler, createCalls } = makeHarness(makeInstance(), [makeAdapter()]);
    await reconciler.applyRuntimeChange('inst-1', handoff('preemptive'));
    expect(createCalls[0].options['resume']).toBe(false);
  });

  it('emits the "Account switched" transcript note with labels and reason', async () => {
    const { reconciler, deps } = makeHarness(makeInstance(), [makeAdapter()]);
    await reconciler.applyRuntimeChange('inst-1', {
      ...handoff('failover'),
      accountHandoffReason: 'usage limit; resets 18:30',
    } as DesiredRuntime);
    const notices = deps.emitSystemNotice.mock.calls.map((call) => String(call[1]));
    expect(notices.some((text) => text.includes('Account switched: Existing Claude account → Max b (usage limit; resets 18:30)'))).toBe(true);
  });

  it('rolls the account back when the handoff spawn fails', async () => {
    const failing = makeAdapter();
    (failing as unknown as { spawn: ReturnType<typeof vi.fn> }).spawn = vi.fn().mockRejectedValue(new Error('boom'));
    const { reconciler, instance } = makeHarness(makeInstance({ accountProfileId: 'legacy', accountSwitches: 2 }), [failing]);
    accountPool.continuation = 'replay';
    await expect(reconciler.applyRuntimeChange('inst-1', handoff('failover'))).rejects.toThrow('boom');
    expect(instance).toMatchObject({ accountProfileId: 'legacy', accountSwitches: 2 });
  });

  it.each(['claude', 'codex'] as const)('restores the %s account when construction rejects before spawn', async (provider) => {
    const original = makeAdapter();
    const adapter = makeAdapter();
    const h = makeHarness(makeInstance({ provider, accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2 }), [adapter], { getAdapter: () => original });
    const runtimeDeps = (h.reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps;
    runtimeDeps.createRuntimeAdapter = async () => { throw new Error('Synthetic account admission refusal'); };
    await expect(h.reconciler.applyRuntimeChange('inst-1', { ...handoff('failover'), provider })).rejects.toThrow('Synthetic account admission refusal');
    expect(original.terminate).toHaveBeenCalledWith(true);
    expect(h.instance).toMatchObject({ provider, accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'error' });
    expect(adapter.spawn).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(h.deps.emitSystemNotice).not.toHaveBeenCalled();
    expect(runtimeDeps.emitRuntimeChanged).not.toHaveBeenCalled();
  });

  it('retains provider rollback when adapter construction rejects before spawn', async () => {
    const available = vi.spyOn(providerSwap, 'assertSwapTargetCliAvailable').mockResolvedValue(undefined);
    const adapter = makeAdapter();
    const h = makeHarness(makeInstance({ fastMode: true, reasoningEffort: 'high' }), [adapter]);
    const runtimeDeps = (h.reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps;
    runtimeDeps.createRuntimeAdapter = async () => { throw new Error('Synthetic provider construction refusal'); };
    try {
      await expect(h.reconciler.applyRuntimeChange('inst-1', {
        provider: 'opencode', model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      })).rejects.toThrow('Synthetic provider construction refusal');
      expect(h.instance).toMatchObject({ provider: 'claude', currentModel: 'sonnet', fastMode: true, reasoningEffort: 'high', status: 'error' });
      expect(adapter.spawn).not.toHaveBeenCalled();
      expect(adapter.sendInput).not.toHaveBeenCalled();
      expect(h.deps.emitSystemNotice).not.toHaveBeenCalled();
      expect(runtimeDeps.emitRuntimeChanged).not.toHaveBeenCalled();
    } finally { available.mockRestore(); }
  });

  it('retains Copilot account rollback when admission rejects before spawn', async () => {
    const adapter = makeAdapter();
    const h = makeHarness(makeInstance({ provider: 'copilot', copilotAccountProfileId: 'personal' }), [adapter]);
    const runtimeDeps = (h.reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps;
    runtimeDeps.createRuntimeAdapter = async () => { throw new Error('Synthetic Copilot admission refusal'); };
    await expect(h.reconciler.applyRuntimeChange('inst-1', {
      provider: 'copilot', copilotAccountProfileId: 'enterprise', copilotAccountHandoffConfirmed: true,
    })).rejects.toThrow('Synthetic Copilot admission refusal');
    expect(h.instance).toMatchObject({ provider: 'copilot', copilotAccountProfileId: 'personal', status: 'error' });
    expect(adapter.spawn).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(h.deps.emitSystemNotice).not.toHaveBeenCalled();
    expect(runtimeDeps.emitRuntimeChanged).not.toHaveBeenCalled();
  });

  /** MiMo multi-account (plan 2026-10-10 phase 4, Decision 6). */
  function mimoHandoff(): DesiredRuntime {
    return {
      provider: 'opencode',
      accountProfileId: 'b',
      accountHandoffKind: 'failover',
      accountHandoffReason: 'usage limit',
    } as unknown as DesiredRuntime;
  }

  function mimoInstance(): Instance {
    return makeInstance({
      provider: 'opencode',
      currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountProfileId: 'a',
    });
  }

  it.each(['cli-resolution', 'model-validation', 'spawn-config', 'adapter-construction', 'event-registration', 'adapter-registration'] as const)(
    'restores a MiMo handoff when %s fails after teardown and before spawn', async (stage) => {
      const original = makeAdapter();
      const adapter = makeAdapter();
      const h = makeHarness(makeInstance({ ...mimoInstance(), accountRoutingSource: 'persisted', accountSwitches: 2 }), [adapter], { getAdapter: () => original });
      const runtimeDeps = (h.reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps;
      const failure = new Error(`Synthetic ${stage} refusal`);
      const reject = () => { throw failure; };
      switch (stage) {
        case 'cli-resolution': runtimeDeps.resolveCliTypeForInstance = async () => reject(); break;
        case 'model-validation': vi.mocked(getKnownModelsForCli).mockRejectedValueOnce(failure); break;
        case 'spawn-config': runtimeDeps.spawnConfigBuilder.getMcpConfig = reject; break;
        case 'adapter-construction': runtimeDeps.createRuntimeAdapter = async () => reject(); break;
        case 'event-registration': runtimeDeps.setupAdapterEvents = reject; break;
        case 'adapter-registration': runtimeDeps.setAdapter = reject; break;
      }
      await expect(h.reconciler.applyRuntimeChange('inst-1', mimoHandoff())).rejects.toThrow(failure.message);
      expect(original.terminate).toHaveBeenCalledWith(true);
      expect(h.instance).toMatchObject({
        provider: 'opencode', currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
        accountProfileId: 'a', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'error',
      });
      expect(h.instance.recoveryMethod).toBeUndefined();
      expect(adapter.spawn).not.toHaveBeenCalled();
      expect(adapter.sendInput).not.toHaveBeenCalled();
      expect((adapter as unknown as { queueNextPromptContext: ReturnType<typeof vi.fn> }).queueNextPromptContext).not.toHaveBeenCalled();
      expect(h.deps.emitSystemNotice).not.toHaveBeenCalled();
      expect(runtimeDeps.emitRuntimeChanged).not.toHaveBeenCalled();
      expect(runtimeDeps.queueUpdate).not.toHaveBeenCalled();
    },
  );

  it('switches a running OpenCode session between MiMo accounts in place — no new process', async () => {
    const live = makeAdapter() as unknown as Record<string, unknown>;
    live['applyLiveSessionConfig'] = vi.fn().mockResolvedValue(undefined);
    const { reconciler, instance, createCalls, deleteAdapter } = makeHarness(mimoInstance(), [makeAdapter()], {
      getAdapter: () => live as unknown as CliAdapter,
    });

    await reconciler.applyRuntimeChange('inst-1', mimoHandoff());

    // The live session re-binds to the next account's provider prefix; the
    // logical model on the instance is untouched (Decision 4).
    expect(live['applyLiveSessionConfig']).toHaveBeenCalledWith({ model: 'aio-mimo-b/mimo-v2.6-pro' });
    expect(createCalls).toHaveLength(0);
    expect(deleteAdapter).not.toHaveBeenCalled();
    expect(live['terminate']).not.toHaveBeenCalled();
    expect(instance).toMatchObject({
      accountProfileId: 'b',
      accountRoutingSource: 'failover',
      accountSwitches: 1,
      currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    });
  });

  it('rejects a MiMo account switch on another backend before terminating its adapter', async () => {
    const original = makeAdapter();
    const { reconciler, instance, deleteAdapter } = makeHarness(makeInstance({ provider: 'opencode', currentModel: 'opencode/big-pickle' }), [makeAdapter()], { getAdapter: () => original });
    await expect(reconciler.applyRuntimeChange('inst-1', mimoHandoff())).rejects.toThrow(/MiMo Token Plan model/);
    expect(deleteAdapter).not.toHaveBeenCalled();
    expect(original.terminate).not.toHaveBeenCalled();
    expect(instance.accountProfileId).toBeUndefined();
  });

  it.each(['accepted', 'refused', 'unsupported', 'mismatched', 'superseded'] as const)(
    'confirms real live MiMo effort or respawns with the visible startup default warning when %s', async (mode) => {
      const modelA = 'aio-mimo-a/mimo-v2.5';
      const modelB = 'aio-mimo-b/mimo-v2.5';
      let model = modelA;
      let effort = 'high';
      const options = (selectedModel: string, selectedEffort: string, offerEffort = true) => [
        { id: 'model', category: 'model', currentValue: selectedModel, options: [{ value: modelA }, { value: modelB }] },
        ...(offerEffort ? [{ id: 'effort', category: 'thought_level', currentValue: selectedEffort, options: [{ value: 'low' }, { value: 'high' }] }] : []),
      ];
      const liveProc = createInitializedAgentHarness();
      liveProc.onRequest('session/new', (request) => liveProc.respond(request.id, {
        sessionId: LIVE_SESSION_ID, configOptions: options(model, effort),
      }));
      liveProc.onRequest('session/set_config_option', (request) => {
        const params = request.params as { configId: string; value: string };
        if (params.configId === 'model') { model = params.value; effort = 'low'; }
        else if (mode === 'refused') {
          liveProc.respondError(request.id, -32602, 'Synthetic effort refusal');
          return;
        } else effort = mode === 'mismatched' ? 'low' : params.value;
        liveProc.respond(request.id, { configOptions: options(model, effort, mode !== 'unsupported') });
        if (params.configId === 'effort' && mode === 'superseded') {
          effort = 'low';
          liveProc.notify('session/update', { sessionId: LIVE_SESSION_ID, update: {
            sessionUpdate: 'config_option_update', configOptions: options(model, effort),
          } });
        }
      });
      const live = new TestAcpCliAdapter(liveProc, { workingDirectory: '/tmp' });
      const startupProc = createInitializedAgentHarness();
      startupProc.onRequest('session/load', (request) => startupProc.respond(request.id, { configOptions: options(modelB, 'low') }));
      startupProc.onRequest('session/set_config_option', (request) => startupProc.respondError(request.id, -32602, 'Synthetic startup effort refusal'));
      const startup = new TestAcpCliAdapter(startupProc, {
        workingDirectory: '/tmp', resume: true, sessionId: LIVE_SESSION_ID,
        sessionConfig: { model: modelB, effort: 'high' }, requireSessionModelConfirmation: true,
      });
      const startupWarnings: string[] = [];
      startup.on('output', (message) => { if (message.type === 'system') startupWarnings.push(message.content); });
      const { reconciler, instance, createCalls, deleteAdapter, deps } = makeHarness(
        makeInstance({ ...mimoInstance(), currentModel: 'xiaomi-token-plan-ams/mimo-v2.5', reasoningEffort: 'high' }),
        [startup], { getAdapter: () => live },
      );
      const terminate = vi.spyOn(live, 'terminate');
      try {
        await live.spawn();
        if (mode !== 'accepted') {
          // Simulate the native process exiting after the real graceful terminate
          // requests SIGTERM; no OS signal or shutdown timeout is needed.
          mockProcessKill.mockImplementationOnce(() => { queueMicrotask(() => liveProc.exit()); return true; });
        }
        await reconciler.applyRuntimeChange('inst-1', mimoHandoff());
        expect(model).toBe(modelB);
        expect(instance).toMatchObject({ accountProfileId: 'b', reasoningEffort: 'high', accountSwitches: 1, status: 'idle' });
        if (mode === 'accepted') {
          expect(effort).toBe('high');
          expect(createCalls).toHaveLength(0);
          expect(terminate).not.toHaveBeenCalled();
          expect(deleteAdapter).not.toHaveBeenCalled();
          expect(startupWarnings).toEqual([]);
        } else {
          expect(createCalls).toHaveLength(1);
          expect(createCalls[0].options).toMatchObject({ reasoningEffort: 'high', resume: true });
          expect(terminate).toHaveBeenCalledWith(true);
          expect(deleteAdapter).toHaveBeenCalledOnce();
          expect(startupWarnings).toHaveLength(1);
          expect(startupWarnings[0]).toContain('Could not set effort "high"');
          expect(startupWarnings[0]).toContain("The agent's own default is used instead.");
        }
        expect(deps.emitSystemNotice.mock.calls.filter((call) => String(call[1]).includes('Account switched'))).toHaveLength(1);
        for (const proc of [liveProc, startupProc]) {
          expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toHaveLength(0);
        }
      } finally { liveProc.exit(); startupProc.exit(); }
    },
  );

  it.each(['native', 'replay', 'failed-resume'] as const)('defers account notice and continuity on an OpenCode %s respawn until real input', async (mode) => {
    const adapters = [makeAdapter(), makeAdapter()];
    if (mode === 'replay') accountPool.continuation = 'replay';
    const { reconciler, instance, createCalls, deps } = makeHarness(mimoInstance(), adapters);
    if (mode === 'failed-resume') deps.evaluateResumeHealth.mockResolvedValue('unrecoverable');
    await reconciler.applyRuntimeChange('inst-1', { ...mimoHandoff(), accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
    expect(createCalls).toHaveLength(mode === 'failed-resume' ? 2 : 1);
    const selected = adapters[mode === 'failed-resume' ? 1 : 0] as unknown as { sendInput: ReturnType<typeof vi.fn>; queueNextPromptContext: ReturnType<typeof vi.fn> };
    expect(selected.sendInput).not.toHaveBeenCalled();
    const context = String(selected.queueNextPromptContext.mock.calls[0]?.[0]);
    expect(context).toContain('Account switched');
    if (mode === 'replay') expect(context).toContain('replay preamble');
    if (mode === 'failed-resume') expect(context).toContain('fallback history');
    expect(instance.recoveryMethod).toBe(mode === 'native' ? 'native' : 'replay');
    expect(deps.emitSystemNotice.mock.calls.some((call) => String(call[1]).includes('Account switched'))).toBe(true);
  });

  it.each(['shared-store', 'replay'] as const)('rolls back a refused MiMo account startup under %s without announcing success or delivering work', async (continuation) => {
    accountPool.continuation = continuation;
    const previousModel = 'aio-mimo-a/mimo-v2.5';
    const targetModel = 'aio-mimo-b/mimo-v2.5';
    const processes = [createInitializedAgentHarness(), createInitializedAgentHarness()];
    const adapters = processes.map((proc, index) => {
      const options = [{ id: 'model', category: 'model', currentValue: previousModel, options: [{ value: previousModel }, { value: targetModel }] }];
      proc.onRequest('session/new', (request) => proc.respond(request.id, { sessionId: 'refused-account-session', configOptions: options }));
      proc.onRequest('session/load', (request) => proc.respond(request.id, { configOptions: options }));
      proc.onRequest('session/set_config_option', (request) => proc.respondError(request.id, -32602, 'Synthetic rejected account model'));
      const adapter = new TestAcpCliAdapter(proc, {
        workingDirectory: '/tmp',
        sessionId: LIVE_SESSION_ID,
        resume: continuation === 'shared-store' && index === 0,
        sessionConfig: { model: targetModel },
        requireSessionModelConfirmation: true,
      });
      vi.spyOn(adapter, 'sendInput');
      vi.spyOn(adapter, 'queueNextPromptContext');
      return adapter;
    });
    const original = makeAdapter();
    const { reconciler, instance, createCalls, deps } = makeHarness(
      makeInstance({ ...mimoInstance(), currentModel: 'xiaomi-token-plan-ams/mimo-v2.5', accountRoutingSource: 'persisted', accountSwitches: 2 }),
      adapters,
      { getAdapter: () => original },
    );
    const runtimeDeps = (reconciler as unknown as { deps: RuntimeReconcilerDeps }).deps;
    const buildReplay = vi.spyOn(runtimeDeps, 'buildReplayContinuityMessage');

    try {
      await expect(reconciler.applyRuntimeChange('inst-1', mimoHandoff())).rejects.toThrow('Unable to confirm the selected model');

      expect(original.terminate).toHaveBeenCalledWith(true);
      expect(createCalls).toHaveLength(continuation === 'shared-store' ? 2 : 1);
      expect(instance).toMatchObject({
        status: 'error',
        provider: 'opencode',
        currentModel: 'xiaomi-token-plan-ams/mimo-v2.5',
        accountProfileId: 'a',
        accountRoutingSource: 'persisted',
        accountSwitches: 2,
      });
      expect(instance.recoveryMethod).toBeUndefined();
      expect(deps.emitSystemNotice).not.toHaveBeenCalled();
      expect(runtimeDeps.emitRuntimeChanged).not.toHaveBeenCalled();
      expect(runtimeDeps.queueUpdate).not.toHaveBeenCalled();
      expect(deps.buildFallbackHistory).not.toHaveBeenCalled();
      expect(buildReplay).not.toHaveBeenCalled();
      for (const adapter of adapters) {
        expect(adapter.sendInput).not.toHaveBeenCalled();
        expect(adapter.queueNextPromptContext).not.toHaveBeenCalled();
      }
      for (const proc of processes) {
        expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toHaveLength(0);
      }
    } finally {
      for (const proc of processes) proc.exit();
    }
  });

  it.each(['claude', 'codex'] as const)('preserves immediate account announcement delivery for %s', async (provider) => {
    const adapter = makeAdapter();
    const { reconciler } = makeHarness(makeInstance({ provider }), [adapter]);
    await reconciler.applyRuntimeChange('inst-1', { ...handoff('failover'), provider });
    expect(adapter.sendInput).toHaveBeenCalledWith(expect.stringContaining('Account switched'));
    expect((adapter as unknown as { queueNextPromptContext: ReturnType<typeof vi.fn> }).queueNextPromptContext).not.toHaveBeenCalled();
  });

  it('falls back to the respawn handoff when no live-switchable adapter is running', async () => {
    const { reconciler, instance, createCalls } = makeHarness(mimoInstance(), [makeAdapter()]);

    await reconciler.applyRuntimeChange('inst-1', mimoHandoff());

    expect(createCalls).toHaveLength(1);
    expect(instance).toMatchObject({ accountProfileId: 'b', accountSwitches: 1 });
  });
});
