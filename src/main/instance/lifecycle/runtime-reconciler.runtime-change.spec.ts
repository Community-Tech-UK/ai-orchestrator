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
  deps: {
    evaluateResumeHealth: ReturnType<typeof vi.fn>;
    transitionState: ReturnType<typeof vi.fn>;
    buildFallbackHistory: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(instance: Instance, adapters: CliAdapter[]): Harness {
  let adapterIndex = 0;
  const createCalls: Array<{ options: Record<string, unknown> }> = [];
  const deps = {
    evaluateResumeHealth: vi.fn().mockResolvedValue('healthy'),
    transitionState: vi.fn((inst: Instance, status: string) => {
      (inst as unknown as { status: string }).status = status;
    }),
    buildFallbackHistory: vi.fn().mockResolvedValue('fallback history'),
  };
  const reconciler = new RuntimeReconciler({
    getInstance: () => instance,
    getAdapter: () => makeAdapter(),
    setAdapter: vi.fn(),
    deleteAdapter: vi.fn(),
    setupAdapterEvents: vi.fn(),
    transitionState: deps.transitionState,
    resolveCliTypeForInstance: async () => 'claude',
    // Claude: resumable and forkable — the exact shape that triggered LT-008.
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: true }),
    assertLocalModelRuntimeAvailable: vi.fn(),
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
    emitModelSelectionDegradation: vi.fn(),
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
  return { reconciler, instance, createCalls, deps };
}

/** A pure permission-posture flip — the toggleYoloMode path. */
function yoloOnly(yoloMode: boolean): DesiredRuntime {
  return { provider: 'claude', yoloMode } as unknown as DesiredRuntime;
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
