import { describe, expect, it, vi } from 'vitest';
import { IdleMonitor } from '../idle-monitor';
import type { ActivityStateDetector } from '../../../providers/activity-state-detector';
import type { RecoveryRecipeEngine } from '../../../session/recovery-recipe-engine';
import type { Instance } from '../../../../shared/types/instance.types';

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('IdleMonitor', () => {
  it('refreshes detector PID from the live instance before detecting activity', async () => {
    let detectorPid = 111;
    const detector = {
      setPid: vi.fn((pid: number) => {
        detectorPid = pid;
      }),
      detect: vi.fn(async () => ({
        state: detectorPid === 222 ? 'idle' as const : 'exited' as const,
        confidence: 'low' as const,
        staleAfterMs: 0,
        source: 'test',
      })),
    } as unknown as ActivityStateDetector;
    const recoveryEngine = {
      handleFailure: vi.fn(async () => ({ status: 'recovered' as const })),
    } as unknown as RecoveryRecipeEngine;

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => recoveryEngine,
      getActivityDetectors: () => new Map([['instance-1', detector]]),
      getInstance: () => ({
        id: 'instance-1',
        status: 'busy',
        processId: 222,
        executionLocation: { type: 'local' },
      } as unknown as Instance),
      forEachInstance: vi.fn(),
      getAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery: vi.fn(async () => undefined),
    });

    monitor.check();
    await flushAsyncWork();

    expect(detector.setPid).toHaveBeenCalledWith(222);
    expect(detector.detect).toHaveBeenCalledOnce();
    expect(recoveryEngine.handleFailure).not.toHaveBeenCalled();
  });

  it('still dispatches unexpected-exit recovery when the refreshed detector reports exited', async () => {
    const detector = {
      setPid: vi.fn(),
      detect: vi.fn(async () => ({
        state: 'exited' as const,
        confidence: 'low' as const,
        staleAfterMs: 0,
        source: 'test',
      })),
    } as unknown as ActivityStateDetector;
    const recoveryEngine = {
      handleFailure: vi.fn(async () => ({ status: 'recovered' as const })),
    } as unknown as RecoveryRecipeEngine;
    const dispatchRecovery = vi.fn(async () => undefined);

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => recoveryEngine,
      getActivityDetectors: () => new Map([['instance-1', detector]]),
      getInstance: () => ({
        id: 'instance-1',
        status: 'busy',
        processId: null,
        executionLocation: { type: 'local' },
      } as unknown as Instance),
      forEachInstance: vi.fn(),
      getAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery,
    });

    monitor.check();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(detector.setPid).not.toHaveBeenCalled();
    expect(recoveryEngine.handleFailure).toHaveBeenCalledWith(expect.objectContaining({
      category: 'process_exited_unexpected',
      instanceId: 'instance-1',
    }));
    expect(dispatchRecovery).toHaveBeenCalledWith('instance-1', expect.objectContaining({
      category: 'process_exited_unexpected',
    }));
  });

  it.each(['superseded', 'failed'] as const)(
    'does not dispatch recovery for a %s instance whose process has exited',
    async (status) => {
      // Regression: a superseded source (edit/fork retry) keeps its dead CLI
      // process around. Without this guard the monitor classified it as
      // process_exited_unexpected and looped forever attempting an illegal
      // superseded -> initializing RESTART transition.
      const detector = {
        setPid: vi.fn(),
        detect: vi.fn(async () => ({
          state: 'exited' as const,
          confidence: 'low' as const,
          staleAfterMs: 0,
          source: 'test',
        })),
      } as unknown as ActivityStateDetector;
      const recoveryEngine = {
        handleFailure: vi.fn(async () => ({ status: 'recovered' as const })),
      } as unknown as RecoveryRecipeEngine;
      const dispatchRecovery = vi.fn(async () => undefined);

      const monitor = new IdleMonitor({
        getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
        getRecoveryEngine: () => recoveryEngine,
        getActivityDetectors: () => new Map([['instance-1', detector]]),
        getInstance: () => ({
          id: 'instance-1',
          status,
          processId: null,
          supersededBy: status === 'superseded' ? 'fork-1' : undefined,
          executionLocation: { type: 'local' },
        } as unknown as Instance),
        forEachInstance: vi.fn(),
        getAdapter: vi.fn(),
        queueUpdate: vi.fn(),
        deleteAdapter: vi.fn(),
        transitionState: vi.fn(),
        terminateInstance: vi.fn(async () => undefined),
        hibernateInstance: vi.fn(async () => undefined),
        dispatchRecovery,
      });

      monitor.check();
      await flushAsyncWork();
      await flushAsyncWork();

      expect(recoveryEngine.handleFailure).not.toHaveBeenCalled();
      expect(dispatchRecovery).not.toHaveBeenCalled();
    },
  );

  function makeRemoteMonitor(staleMs: number, queueUpdate: ReturnType<typeof vi.fn>, status = 'busy'): IdleMonitor {
    const detector = {
      setPid: vi.fn(),
      detect: vi.fn(async () => ({ state: 'idle' as const, confidence: 'low' as const, staleAfterMs: 0, source: 'test' })),
    } as unknown as ActivityStateDetector;
    return new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => ({ handleFailure: vi.fn() } as unknown as RecoveryRecipeEngine),
      getActivityDetectors: () => new Map([['r1', detector]]),
      getInstance: () => ({
        id: 'r1',
        status,
        executionLocation: { type: 'remote', nodeId: 'node-x' },
      } as unknown as Instance),
      forEachInstance: vi.fn(),
      getAdapter: () => ({ getMillisSinceLastActivity: () => staleMs }) as never,
      queueUpdate,
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery: vi.fn(async () => undefined),
    });
  }

  it('D4: surfaces a remote-heartbeat wait when a busy remote turn goes silent', async () => {
    const queueUpdate = vi.fn();
    makeRemoteMonitor(200_000, queueUpdate).check();
    await flushAsyncWork();

    const staleCall = queueUpdate.mock.calls.find(
      (c) => (c[10] as { kind?: string } | null)?.kind === 'remote-heartbeat',
    );
    expect(staleCall).toBeDefined();
    expect(staleCall![10]).toMatchObject({ kind: 'remote-heartbeat', nodeId: 'node-x' });
    expect((staleCall![10] as { staleForMs: number }).staleForMs).toBeGreaterThanOrEqual(120_000);
  });

  it('D4: does NOT surface a remote-heartbeat wait when remote activity is recent', async () => {
    const queueUpdate = vi.fn();
    makeRemoteMonitor(1_000, queueUpdate).check();
    await flushAsyncWork();

    const staleCall = queueUpdate.mock.calls.find(
      (c) => (c[10] as { kind?: string } | null)?.kind === 'remote-heartbeat',
    );
    expect(staleCall).toBeUndefined();
  });

  it('D4: does NOT surface a remote-heartbeat wait when the remote instance is idle (not active)', async () => {
    const queueUpdate = vi.fn();
    makeRemoteMonitor(200_000, queueUpdate, 'idle').check();
    await flushAsyncWork();

    const staleCall = queueUpdate.mock.calls.find(
      (c) => (c[10] as { kind?: string } | null)?.kind === 'remote-heartbeat',
    );
    expect(staleCall).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // terminateIdleHalf age guard
  //
  // `idle` means "waiting for the next message", so a child between turns of
  // active work is indistinguishable from an abandoned one without an age
  // check. Reclaiming without one destroyed live sessions under memory pressure.
  // ---------------------------------------------------------------------------

  function makeIdleHalfMonitor(children: { id: string; idleForMs: number }[]) {
    const terminateInstance = vi.fn(async () => undefined);
    const now = Date.now();
    const instances = children.map((c) => ({
      id: c.id,
      status: 'idle',
      parentId: 'parent-1',
      displayName: c.id,
      lastActivity: now - c.idleForMs,
    } as unknown as Instance));

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => ({} as unknown as RecoveryRecipeEngine),
      getActivityDetectors: () => new Map(),
      getInstance: (id: string) => instances.find((i) => i.id === id),
      forEachInstance: vi.fn((cb: (instance: Instance, id: string) => void) => {
        for (const i of instances) cb(i, i.id);
      }),
      getAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance,
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery: vi.fn(async () => undefined),
    } as never);

    return { monitor, terminateInstance };
  }

  it('terminateIdleHalf spares children that were active more recently than the guard', () => {
    const { monitor, terminateInstance } = makeIdleHalfMonitor([
      { id: 'just-sent-to', idleForMs: 1_000 },
      { id: 'also-recent', idleForMs: 30_000 },
    ]);

    monitor.terminateIdleHalf();

    expect(terminateInstance).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // cleanupZombieProcesses in-flight lifecycle guard
  //
  // Regression: the reaper fired 1s into a restart that held the session lock,
  // force-killing the app-server the restart had just spawned. The in-flight
  // replay send then rejected with "Codex app-server runtime closed", the
  // restart reported failure, and the session was parked in `error`.
  // ---------------------------------------------------------------------------

  function makeZombieMonitor(opts: {
    status: string;
    locked: boolean;
    processId?: number | null;
    hasAdapter?: boolean;
  }) {
    const instance = {
      id: 'inst-1',
      status: opts.status,
      processId: opts.processId ?? null,
    } as unknown as Instance;
    const adapter = { isRunning: () => true, terminate: vi.fn(async () => undefined) };
    const hasAdapter = opts.hasAdapter ?? true;
    const deleteAdapter = vi.fn();
    const transitionState = vi.fn();

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => ({} as unknown as RecoveryRecipeEngine),
      getActivityDetectors: () => new Map(),
      getInstance: () => instance,
      forEachInstance: vi.fn((cb: (i: Instance, id: string) => void) => cb(instance, instance.id)),
      getAdapter: () => (hasAdapter ? (adapter as never) : undefined),
      queueUpdate: vi.fn(),
      deleteAdapter,
      transitionState,
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery: vi.fn(async () => undefined),
      isLifecycleLocked: () => opts.locked,
    });

    return { monitor, adapter, deleteAdapter, transitionState, instance };
  }

  it('does NOT reap a running adapter while a lifecycle operation holds the session lock', async () => {
    const { monitor, adapter, deleteAdapter } = makeZombieMonitor({ status: 'error', locked: true });

    monitor.cleanupZombieProcesses();
    await flushAsyncWork();

    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(deleteAdapter).not.toHaveBeenCalled();
  });

  it('still reaps a running adapter of an errored instance once no lock is held', async () => {
    const { monitor, adapter, deleteAdapter } = makeZombieMonitor({ status: 'error', locked: false });

    monitor.cleanupZombieProcesses();
    await flushAsyncWork();

    expect(adapter.terminate).toHaveBeenCalledWith(false);
    expect(deleteAdapter).toHaveBeenCalledWith('inst-1');
  });

  it('does NOT force an initializing instance to error mid-restart when the lock is held', () => {
    // Restart clears processId and spawns a replacement, so the PID-without-adapter
    // pass would otherwise flip a healthy in-flight restart to `error`.
    const { monitor, transitionState } = makeZombieMonitor({
      status: 'initializing',
      locked: true,
      processId: 4321,
      hasAdapter: false,
    });

    monitor.cleanupZombieProcesses();

    expect(transitionState).not.toHaveBeenCalled();
  });

  it('still clears a stale PID and errors an initializing instance when no lock is held', () => {
    const { monitor, transitionState, instance } = makeZombieMonitor({
      status: 'initializing',
      locked: false,
      processId: 4321,
      hasAdapter: false,
    });

    monitor.cleanupZombieProcesses();

    expect(instance.processId).toBeNull();
    expect(transitionState).toHaveBeenCalledWith(instance, 'error');
  });

  it('terminateIdleHalf still reclaims genuinely stale children, oldest first', () => {
    const { monitor, terminateInstance } = makeIdleHalfMonitor([
      { id: 'recent', idleForMs: 1_000 },
      { id: 'stale-oldest', idleForMs: 60 * 60 * 1000 },
      { id: 'stale-newer', idleForMs: 10 * 60 * 1000 },
    ]);

    monitor.terminateIdleHalf();

    // 2 stale candidates → ceil(2/2) = 1 terminated, the oldest.
    expect(terminateInstance).toHaveBeenCalledTimes(1);
    expect(terminateInstance).toHaveBeenCalledWith('stale-oldest', true);
  });
});
