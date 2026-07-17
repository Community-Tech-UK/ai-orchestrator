/**
 * RuntimeReconciler.applyRecoveryRespawn — the spec-item-2 spawn core.
 *
 * Ports the incident-hardened invariants from the interrupt-respawn path to
 * their new owner: fresh-fallback ordering (listener strip BEFORE terminate,
 * writeThroughIdentityLocked with the fresh id + null cursor BEFORE reporting
 * complete), abort checks at every hardened point, session flag bookkeeping,
 * and the caller-holds-the-lock contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';
import type {
  RecoveryRespawnHooks,
  RecoveryRespawnRequest,
  RuntimeReconcilerDeps,
} from './runtime-reconciler.types';

const { mockContinuity, mockSessionMutex } = vi.hoisted(() => ({
  mockContinuity: {
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
  },
  mockSessionMutex: {
    acquire: vi.fn(),
    getLockInfo: vi.fn(
      (): { source: string; acquiredAt: number; durationMs: number } | null =>
        ({ source: 'respawn', acquiredAt: 1, durationMs: 0 }),
    ),
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
vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => 'fresh-id'),
}));

import { RuntimeReconciler } from './runtime-reconciler';

function makeAdapter(spawnResult: Promise<number> | number = 42): CliAdapter {
  const adapter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  adapter['spawn'] = vi.fn(() =>
    typeof spawnResult === 'number' ? Promise.resolve(spawnResult) : spawnResult,
  );
  adapter['terminate'] = vi.fn().mockResolvedValue(undefined);
  adapter['sendInput'] = vi.fn().mockResolvedValue(undefined);
  return adapter as unknown as CliAdapter;
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    status: 'respawning',
    sessionId: 'old-session',
    executionLocation: { type: 'local' },
    outputBuffer: [],
    contextUsage: { used: 0, total: 100000, percentage: 0 },
    ...overrides,
  } as unknown as Instance;
}

interface Harness {
  reconciler: RuntimeReconciler;
  instance: Instance;
  adapters: CliAdapter[];
  createCalls: Array<{ options: Record<string, unknown> }>;
  deps: {
    setAdapter: ReturnType<typeof vi.fn>;
    setupAdapterEvents: ReturnType<typeof vi.fn>;
    waitForResumeHealth: ReturnType<typeof vi.fn>;
    buildFallbackHistory: ReturnType<typeof vi.fn>;
    buildReplayContinuityMessage: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(instance: Instance, adapters: CliAdapter[]): Harness {
  let adapterIndex = 0;
  const createCalls: Array<{ options: Record<string, unknown> }> = [];
  const deps = {
    setAdapter: vi.fn(),
    setupAdapterEvents: vi.fn(),
    waitForResumeHealth: vi.fn().mockResolvedValue(true),
    buildFallbackHistory: vi.fn().mockResolvedValue('fallback history'),
    buildReplayContinuityMessage: vi.fn(() => 'replay preamble'),
  };
  const reconciler = new RuntimeReconciler({
    getInstance: () => instance,
    setAdapter: deps.setAdapter,
    setupAdapterEvents: deps.setupAdapterEvents,
    createRuntimeAdapter: (_cliType: unknown, options: Record<string, unknown>) => {
      createCalls.push({ options });
      const adapter = adapters[Math.min(adapterIndex, adapters.length - 1)];
      adapterIndex += 1;
      return adapter;
    },
    waitForResumeHealth: deps.waitForResumeHealth,
    buildFallbackHistory: deps.buildFallbackHistory,
    buildReplayContinuityMessage: deps.buildReplayContinuityMessage,
  } as unknown as RuntimeReconcilerDeps);
  return { reconciler, instance, adapters, createCalls, deps };
}

function makeHooks(overrides: Partial<RecoveryRespawnHooks> = {}): RecoveryRespawnHooks & {
  delivered: Array<string>;
} {
  const delivered: string[] = [];
  return {
    delivered,
    shouldAbort: () => false,
    onAborted: vi.fn().mockResolvedValue(undefined),
    waitReady: vi.fn().mockResolvedValue(true),
    deliverContinuity: vi.fn(async (_adapter: CliAdapter, text: string) => {
      delivered.push(text);
      return false; // queued, not sent inline
    }),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RecoveryRespawnRequest> = {}): RecoveryRespawnRequest {
  return {
    cliType: 'claude',
    spawnOptions: {
      instanceId: 'inst-1',
      sessionId: 'old-session',
      workingDirectory: '/tmp',
      resume: true,
      forkSession: false,
    } as unknown as RecoveryRespawnRequest['spawnOptions'],
    shouldResume: true,
    hasConversation: true,
    postSpawnProviderSessionId: 'old-session',
    replayReason: 'interrupt-respawn',
    fallbackReason: 'resume-failed-fallback',
    ...overrides,
  };
}

describe('RuntimeReconciler.applyRecoveryRespawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionMutex.getLockInfo.mockReturnValue({ source: 'respawn', acquiredAt: 1, durationMs: 0 });
    mockContinuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
  });

  it('throws when the caller does not hold the session lock (recovery-entry contract)', async () => {
    mockSessionMutex.getLockInfo.mockReturnValue(null);
    const { reconciler } = makeHarness(makeInstance(), [makeAdapter()]);
    await expect(
      reconciler.applyRecoveryRespawn('inst-1', makeRequest(), makeHooks()),
    ).rejects.toThrow(/requires the caller to hold the session lock/);
  });

  it('native resume success: records pid, provider session id, and durability flags', async () => {
    const adapter = makeAdapter(81);
    const { reconciler, instance } = makeHarness(
      makeInstance({ sessionResumeBlacklisted: true } as Partial<Instance>),
      [adapter],
    );

    const outcome = await reconciler.applyRecoveryRespawn(
      'inst-1',
      makeRequest({ postSpawnProviderSessionId: 'forked-id' }),
      makeHooks(),
    );

    expect(outcome).toMatchObject({ status: 'ok', pid: 81, actuallyResumed: true, recoveryInputSent: false });
    expect(instance.processId).toBe(81);
    expect(instance.providerSessionId).toBe('forked-id');
    expect(instance.recoveryMethod).toBe('native');
    // Resume succeeded → blacklist cleared, session proven on disk.
    expect(instance.sessionResumeBlacklisted).toBe(false);
    expect(instance.providerSessionPersisted).toBe(true);
  });

  it('resume failure: strips listeners BEFORE terminate, persists the fresh identity, delivers fallback history', async () => {
    const order: string[] = [];
    const resumeAdapter = makeAdapter(Promise.reject(new Error('resume refused')));
    (resumeAdapter.removeAllListeners as unknown) = vi.fn(() => order.push('removeAllListeners'));
    (resumeAdapter.terminate as unknown) = vi.fn(async () => { order.push('terminate'); });
    const fallbackAdapter = makeAdapter(82);
    const instance = makeInstance({ outputBuffer: [{ id: 'u1', type: 'user', content: 'ctx', timestamp: 1 }] } as Partial<Instance>);
    const { reconciler, createCalls } = makeHarness(instance, [resumeAdapter, fallbackAdapter]);
    const hooks = makeHooks();

    const outcome = await reconciler.applyRecoveryRespawn('inst-1', makeRequest(), hooks);

    expect(order).toEqual(['removeAllListeners', 'terminate']);
    expect(outcome).toMatchObject({ status: 'ok', pid: 82, actuallyResumed: false, sessionId: 'fresh-id' });
    // Fresh identity + flags.
    expect(instance.sessionId).toBe('fresh-id');
    expect(instance.providerSessionId).toBe('fresh-id');
    expect(instance.sessionResumeBlacklisted).toBe(false);
    expect(instance.providerSessionPersisted).toBe(false);
    expect(instance.recoveryMethod).toBe('replay');
    // C1/B4: fresh id + null cursor persisted before completion.
    expect(mockContinuity.writeThroughIdentityLocked).toHaveBeenCalledWith('inst-1', {
      sessionId: 'fresh-id',
      resumeCursor: null,
    });
    // Fallback options flipped to a fresh session.
    expect(createCalls[1].options).toMatchObject({ resume: false, forkSession: false, sessionId: 'fresh-id' });
    // Continuity delivered from the fallback path (queued → recoveryInputSent false).
    expect(hooks.delivered).toEqual(['fallback history']);
  });

  it('resume failure without conversation delivers no continuity', async () => {
    const resumeAdapter = makeAdapter(Promise.reject(new Error('resume refused')));
    const fallbackAdapter = makeAdapter(83);
    const { reconciler, instance } = makeHarness(makeInstance(), [resumeAdapter, fallbackAdapter]);
    const hooks = makeHooks();

    const outcome = await reconciler.applyRecoveryRespawn(
      'inst-1',
      makeRequest({ hasConversation: false }),
      hooks,
    );

    expect(outcome.status).toBe('ok');
    expect(hooks.delivered).toEqual([]);
    expect(instance.recoveryMethod).toBe('fresh');
  });

  it('fresh (non-resume) path with conversation delivers the replay preamble', async () => {
    const adapter = makeAdapter(84);
    const { reconciler, deps } = makeHarness(makeInstance(), [adapter]);
    const hooks = makeHooks();

    const outcome = await reconciler.applyRecoveryRespawn(
      'inst-1',
      makeRequest({
        shouldResume: false,
        postSpawnProviderSessionId: 'new-id',
        spawnOptions: {
          instanceId: 'inst-1', sessionId: 'new-id', workingDirectory: '/tmp', resume: false, forkSession: false,
        } as unknown as RecoveryRespawnRequest['spawnOptions'],
      }),
      hooks,
    );

    expect(outcome).toMatchObject({ status: 'ok', actuallyResumed: false });
    expect(deps.buildReplayContinuityMessage).toHaveBeenCalledWith(expect.anything(), 'interrupt-respawn');
    expect(hooks.delivered).toEqual(['replay preamble']);
  });

  it('spawn failure without resume propagates (no silent fallback)', async () => {
    const adapter = makeAdapter(Promise.reject(new Error('spawn exploded')));
    const { reconciler } = makeHarness(makeInstance(), [adapter]);

    await expect(
      reconciler.applyRecoveryRespawn('inst-1', makeRequest({ shouldResume: false }), makeHooks()),
    ).rejects.toThrow('spawn exploded');
  });

  it('aborts cleanly at the pre-spawn, mid-failure, and post-spawn checkpoints', async () => {
    // Pre-spawn abort.
    {
      const adapter = makeAdapter(1);
      const { reconciler } = makeHarness(makeInstance(), [adapter]);
      const hooks = makeHooks({ shouldAbort: () => true });
      const outcome = await reconciler.applyRecoveryRespawn('inst-1', makeRequest(), hooks);
      expect(outcome).toEqual({ status: 'aborted' });
      expect(hooks.onAborted).toHaveBeenCalledWith(adapter, 'pre-spawn recovery respawn cancellation');
      expect(adapter.spawn).not.toHaveBeenCalled();
    }
    // Abort discovered when the resume spawn fails.
    {
      const adapter = makeAdapter(Promise.reject(new Error('resume refused')));
      const { reconciler } = makeHarness(makeInstance(), [adapter]);
      let aborted = false;
      const hooks = makeHooks({ shouldAbort: () => aborted });
      (adapter.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        aborted = true;
        return Promise.reject(new Error('resume refused'));
      });
      const outcome = await reconciler.applyRecoveryRespawn('inst-1', makeRequest(), hooks);
      expect(outcome).toEqual({ status: 'aborted' });
      expect(hooks.onAborted).toHaveBeenCalledWith(adapter, 'recovery respawn spawn cancelled');
    }
    // Post-spawn abort.
    {
      const adapter = makeAdapter(9);
      const { reconciler } = makeHarness(makeInstance(), [adapter]);
      let calls = 0;
      const hooks = makeHooks({ shouldAbort: () => ++calls > 1 });
      const outcome = await reconciler.applyRecoveryRespawn('inst-1', makeRequest(), hooks);
      expect(outcome).toEqual({ status: 'aborted' });
      expect(hooks.onAborted).toHaveBeenCalledWith(adapter, 'post-spawn recovery respawn cancellation');
    }
  });

  it('tolerates a writeThroughIdentity failure during fallback (warn, not fail)', async () => {
    mockContinuity.writeThroughIdentityLocked.mockRejectedValue(new Error('disk full'));
    const resumeAdapter = makeAdapter(Promise.reject(new Error('resume refused')));
    const fallbackAdapter = makeAdapter(85);
    const { reconciler } = makeHarness(makeInstance(), [resumeAdapter, fallbackAdapter]);

    const outcome = await reconciler.applyRecoveryRespawn('inst-1', makeRequest(), makeHooks());
    expect(outcome.status).toBe('ok');
  });

  it('reports recoveryInputSent when the hook sends inline', async () => {
    const adapter = makeAdapter(86);
    const { reconciler } = makeHarness(makeInstance(), [adapter]);
    const hooks = makeHooks({
      deliverContinuity: vi.fn(async () => true),
    });

    const outcome = await reconciler.applyRecoveryRespawn(
      'inst-1',
      makeRequest({ shouldResume: false }),
      hooks,
    );
    expect(outcome).toMatchObject({ status: 'ok', recoveryInputSent: true });
  });
});
