/**
 * InstanceTerminationCoordinator — a deliberate terminate is not an unexpected exit.
 *
 * Regression coverage for LT-013. `terminateInstance` SIGTERMs the adapter while
 * the instance is still `idle` and only calls `markTerminated()` afterwards, so
 * the adapter's own exit event (code 143) reached the still-attached
 * `instance-communication` listener and was classified as an *unexpected* exit.
 * That fired `respawnAfterUnexpectedExit`, which assigns
 * `instance.sessionId = generateId()` for its fork plan before it does any
 * spawning — and `archiveRootConversation` then persisted that freshly minted,
 * never-spawned id as the history entry's resume anchor.
 *
 * The observable damage is silent: no transcript exists for an id no CLI ever
 * used, so every later History restore of that conversation misses the
 * `native-resume` rung. Live evidence 2026-07-27: 4 of 4 archived Claude entries
 * across two independent sessions recorded a session id with no `.jsonl` on disk.
 *
 * Deliberate-stop observation now fences recovery while retaining observers
 * until termination succeeds, so a refused stop remains safe and retryable.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { createInstance, type Instance } from '../../../shared/types/instance.types';
import type { InstanceTerminationDeps } from './instance-termination';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const historyManagerMock = vi.hoisted(() => ({
  getRecoveryCoverage: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => loggerMock,
}));
vi.mock('../../history', () => ({
  getHistoryManager: () => historyManagerMock,
}));
vi.mock('../../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('./respawn-circuit-breaker', () => ({ deleteCircuitBreaker: vi.fn() }));
vi.mock('./session-branch-merge', () => ({
  mergeSessionBranchToMain: vi.fn().mockResolvedValue({ merged: false, reason: 'disabled' }),
}));
vi.mock('../instance-provider-limit-handler', () => ({
  getInstanceProviderLimitHandler: () => ({ release: vi.fn() }),
}));
vi.mock('../instance-auth-repair-handler', () => ({
  getInstanceAuthRepairHandler: () => ({ forget: vi.fn() }),
}));

import { getSelfWakeupTracker, SelfWakeupTracker } from '../self-wakeup-tracker';
import { InstanceTerminationCoordinator } from './instance-termination';
import { InstanceCommunicationManager } from '../instance-communication';

const LIVE_SESSION_ID = 'live-claude-session';
/** What respawnAfterUnexpectedExit's fork branch assigns: a not-yet-minted id. */
const RESPAWN_MINTED_ID = 'minted-fork-id';
const HISTORY_THREAD_ID = 'thread-placeholder-termination';
const PROVIDER_SESSION_ID = 'provider-placeholder-termination';

/**
 * An adapter whose graceful terminate emits `exit` the way a real SIGTERM does
 * (BaseCliAdapter resolves terminate() on the child process's exit, and the
 * adapter re-emits it to its subscribers).
 */
function makeAdapter(): CliAdapter & EventEmitter {
  const adapter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  adapter['terminate'] = vi.fn(async () => {
    adapter.emit('exit', 143, null);
  });
  adapter['getName'] = vi.fn(() => 'claude-cli');
  adapter['getSessionId'] = () => LIVE_SESSION_ID;
  return adapter as unknown as CliAdapter & EventEmitter;
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    ...createInstance({ workingDirectory: '/tmp/aio-lt', provider: 'claude', sessionId: LIVE_SESSION_ID }),
    id: 'inst-1',
    status: 'idle',
    provider: 'claude',
    currentModel: 'opus',
    sessionId: LIVE_SESSION_ID,
    workingDirectory: '/tmp/aio-lt',
    outputBuffer: [
      { type: 'user', content: 'Reply with MANGO', timestamp: Date.now() },
      { type: 'assistant', content: 'MANGO', timestamp: Date.now() },
    ],
    childrenIds: [],
    restartCount: 0,
    ...overrides,
  } as unknown as Instance;
}

function message(id: string, type: Instance['outputBuffer'][number]['type'], timestamp: number) {
  return {
    id,
    type,
    content: `${type} content placeholder`,
    timestamp,
  };
}

describe('InstanceTerminationCoordinator — deliberate terminate vs unexpected exit', () => {
  let instance: Instance;
  let adapter: CliAdapter & EventEmitter;
  let archiveInstance: Mock<InstanceTerminationDeps['archiveInstance']>;
  let deps: InstanceTerminationDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    SelfWakeupTracker._resetForTesting();
    historyManagerMock.getRecoveryCoverage.mockResolvedValue(new Map());
    instance = makeInstance();
    adapter = makeAdapter();
    archiveInstance = vi.fn().mockResolvedValue(undefined);

    deps = {
      getAdapter: vi.fn((id: string) => (id === instance.id ? adapter : undefined)),
      getInstance: vi.fn((id: string) => (id === instance.id ? instance : undefined)),
      deleteAdapter: vi.fn(),
      deleteInstance: vi.fn(),
      forceReleaseSessionMutex: vi.fn(),
      removeActivityDetector: vi.fn(),
      clearRecoveryHistory: vi.fn(),
      transitionState: vi.fn((inst: Instance, status) => {
        inst.status = status;
      }),
      terminateChild: vi.fn().mockResolvedValue(undefined),
      unregisterSupervisor: vi.fn(),
      unregisterOrchestration: vi.fn(),
      clearFirstMessageTracking: vi.fn(),
      endRlmSession: vi.fn(),
      deleteOutputStorage: vi.fn().mockResolvedValue(undefined),
      archiveInstance,
      importTranscript: vi.fn(),
      emitRemoved: vi.fn(),
    };
  });

  /** The real exit listener decides whether a provider respawn is requested. */
  function attachUnexpectedExitListener(): { fired: () => boolean } {
    let fired = false;
    const communication = new InstanceCommunicationManager({
      getInstance: deps.getInstance, getAdapter: deps.getAdapter,
      setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
      processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
      ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined,
      onUnexpectedExit: async () => { fired = true; instance.sessionId = RESPAWN_MINTED_ID; },
    });
    communication.setupAdapterEvents(instance.id, adapter);
    return { fired: () => fired };
  }

  it('does not dispatch unexpected-exit recovery for a deliberate terminate SIGTERM', async () => {
    const listener = attachUnexpectedExitListener();
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    expect(listener.fired()).toBe(false);
  });

  it('archives the live provider session id, not one minted by a racing respawn', async () => {
    attachUnexpectedExitListener();
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    expect(archiveInstance).toHaveBeenCalledTimes(1);
    const archived = archiveInstance.mock.calls[0]![0] as Instance;
    expect(archived.sessionId).toBe(LIVE_SESSION_ID);
  });

  it('adds and publishes a pending wakeup warning before archiving, exactly once', async () => {
    const now = Date.now();
    getSelfWakeupTracker().observe(instance.id, { kind: 'requested', toolUseId: 'stub-wakeup', requestedAt: now, delaySeconds: 90, dueAt: now + 90_000, reason: '' });
    deps.emitSystemOutput = vi.fn();
    const coordinator = new InstanceTerminationCoordinator(deps);
    await coordinator.terminateInstance(instance.id, true);
    expect(instance.outputBuffer.filter(message => message.content.includes('wake-up pending'))).toHaveLength(1);
    expect(deps.emitSystemOutput).toHaveBeenCalledOnce();
    expect(archiveInstance.mock.calls[0][0].outputBuffer.some((message: { content: string }) => message.content.includes('wake-up pending'))).toBe(true);
    coordinator.warnLostWakeup(instance.id, instance);
    expect(deps.emitSystemOutput).toHaveBeenCalledOnce();
  });

  it('still terminates the adapter and completes teardown', async () => {
    attachUnexpectedExitListener();
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    expect(adapter.terminate).toHaveBeenCalledWith(true);
    expect(deps.deleteAdapter).toHaveBeenCalledWith(instance.id);
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
    expect(instance.status).toBe('terminated');
  });

  it('retains the adapter and session when runtime termination fails so its owner can retry', async () => {
    vi.mocked(adapter.terminate).mockRejectedValueOnce(new Error('stop failed'));
    const coordinator = new InstanceTerminationCoordinator(deps);
    await expect(coordinator.terminateInstance(instance.id, false)).rejects.toThrow('stop failed');
    expect(deps.deleteAdapter).not.toHaveBeenCalled();
    expect(deps.deleteInstance).not.toHaveBeenCalled();
    expect(deps.emitRemoved).not.toHaveBeenCalled();
    await coordinator.terminateInstance(instance.id, false);
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
  });

  it('archives an errored instance as an error, not as a clean completion', async () => {
    instance.status = 'error';
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    expect(archiveInstance).toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('tolerates an adapter without removeAllListeners (remote/stub adapters)', async () => {
    const bare = { terminate: vi.fn().mockResolvedValue(undefined) } as unknown as CliAdapter;
    deps.getAdapter = vi.fn(() => bare);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await expect(coordinator.terminateInstance(instance.id, true)).resolves.toBeUndefined();
    expect(bare.terminate).toHaveBeenCalledWith(true);
  });

  it('delegates hibernated archive decisions to the archive dependency', async () => {
    const order: string[] = [];
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    deps.archiveInstance = vi.fn(async () => {
      order.push('archive');
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(order).toEqual(['archive']);
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
  });

  it('always invokes archive when legacy injected coverage covers only the bounded live tail', async () => {
    const order: string[] = [];
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-tail-user', 'user', 300),
        message('message-tail-assistant', 'assistant', 400),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    const legacyCoverage = vi.fn(async () => {
      order.push('coverage');
      return {
        recoveryKey: `history:claude:${HISTORY_THREAD_ID}`,
        provider: 'claude' as const,
        historyThreadId: HISTORY_THREAD_ID,
        sessionId: PROVIDER_SESSION_ID,
        coveredThrough: 400,
        messageCount: 2,
        historyEntryId: 'entry-placeholder-tail',
      };
    });
    (deps as InstanceTerminationDeps & {
      getArchiveHistoryCoverage?: typeof legacyCoverage;
    }).getArchiveHistoryCoverage = legacyCoverage;
    deps.archiveInstance = vi.fn(async () => {
      order.push('archive');
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(order).toEqual(['archive']);
    expect(legacyCoverage).not.toHaveBeenCalled();
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('invokes archive for a root instance even when the live output tail is empty', async () => {
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      outputBuffer: [],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('does not let same-session legacy coverage without a thread prevent archive', async () => {
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    const legacyCoverage = vi.fn().mockResolvedValue({
      recoveryKey: `history:claude:${HISTORY_THREAD_ID}`,
      provider: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      coveredThrough: 200,
      messageCount: 2,
      historyEntryId: 'entry-placeholder-session-only',
    });
    (deps as InstanceTerminationDeps & {
      getArchiveHistoryCoverage?: typeof legacyCoverage;
    }).getArchiveHistoryCoverage = legacyCoverage;
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(legacyCoverage).not.toHaveBeenCalled();
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('does not query history coverage before archiving without an injected coverage dependency', async () => {
    const order: string[] = [];
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    historyManagerMock.getRecoveryCoverage.mockImplementation(async () => {
      order.push('coverage');
      return new Map();
    });
    deps.archiveInstance = vi.fn(async () => {
      order.push('archive');
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(order).toEqual(['archive']);
    expect(historyManagerMock.getRecoveryCoverage).not.toHaveBeenCalled();
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('delegates conflicting-history identity handling to the archive dependency', async () => {
    const order: string[] = [];
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    historyManagerMock.getRecoveryCoverage.mockImplementation(async () => {
      order.push('coverage');
      return new Map();
    });
    deps.archiveInstance = vi.fn(async () => {
      order.push('archive');
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(order).toEqual(['archive']);
    expect(historyManagerMock.getRecoveryCoverage).not.toHaveBeenCalled();
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('archives hibernated roots without preflight coverage', async () => {
    const order: string[] = [];
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    deps.archiveInstance = vi.fn(async () => {
      order.push('archive');
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(order).toEqual(['archive']);
    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });

  it('does not log covered archive skips from the coordinator', async () => {
    instance = makeInstance({
      status: 'superseded',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      supersededBy: 'replacement-placeholder',
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-assistant', 'assistant', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    const logged = JSON.stringify(loggerMock.info.mock.calls);
    expect(logged).not.toContain('covered-superseded-or-hibernated');
    expect(logged).not.toContain(HISTORY_THREAD_ID);
    expect(logged).not.toContain(PROVIDER_SESSION_ID);
  });

  it('preserves hidden automation visibility by archiving an unsuccessful hidden automation even when covered', async () => {
    instance = makeInstance({
      status: 'hibernated',
      historyThreadId: HISTORY_THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      sessionId: PROVIDER_SESSION_ID,
      metadata: {
        automationId: 'automation-placeholder',
        automationHidden: true,
      },
      outputBuffer: [
        message('message-user', 'user', 100),
        message('message-error', 'error', 200),
      ],
    });
    (deps.getInstance as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === instance.id ? instance : undefined),
    );
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
  });
});
