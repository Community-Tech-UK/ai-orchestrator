import { describe, expect, it, vi } from 'vitest';

import { isSurfacedToUserError } from '../surfaced-error';
import type { AppServerNotification } from './app-server-types';
import { CodexContextCostController } from './context-cost-controller';

function createController(overrides: Partial<ConstructorParameters<typeof CodexContextCostController>[0]> = {}) {
  const proofEvents: Array<{ action: string; stage: string }> = [];
  const interruptCompletion = Promise.resolve({ status: 'interrupted' as const });
  const deps: ConstructorParameters<typeof CodexContextCostController>[0] = {
    compactionTimeoutMs: 50,
    interrupt: vi.fn(() => ({ status: 'accepted' as const, completion: interruptCompletion })),
    getCompactionTarget: () => ({ threadId: 'thread-fixture', start: vi.fn(async () => undefined) }),
    emitSystem: vi.fn(),
    recordActionProof: (action, stage) => proofEvents.push({ action, stage }),
    ...overrides,
  };
  return { controller: new CodexContextCostController(deps), deps, proofEvents };
}

describe('CodexContextCostController shared-policy execution adapter', () => {
  it('observes cumulative cost as telemetry without making a threshold decision', () => {
    const interrupt = vi.fn(() => ({ status: 'unsupported' as const }));
    const observations: unknown[] = [];
    const { controller } = createController({
      interrupt,
      recordObservation: (observation) => observations.push(observation),
    });

    controller.observe(800_000, 100_000);

    expect(observations).toEqual([
      expect.objectContaining({ multiple: 8, counterResetObserved: false }),
    ]);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('executes a shared controlled-recovery decision and records proof stages distinctly', async () => {
    const { controller, deps, proofEvents } = createController();
    deps.getCompactionTarget = () => ({
      threadId: 'thread-fixture',
      start: async () => controller.recordCompactionObserved(400_000),
    });

    await expect(controller.requestRecovery('controlled-recovery')).resolves.toEqual({
      proof: 'acknowledged',
    });
    const continueTurn = vi.fn(async () => undefined);
    await expect(controller.recoverAfterTurn({
      turnStatus: 'interrupted',
      recoveryCount: 7,
      continueTurn,
    })).resolves.toBe(true);

    expect(continueTurn).toHaveBeenCalledOnce();
    expect(proofEvents).toEqual(expect.arrayContaining([
      { action: 'controlled-recovery', stage: 'requested' },
      { action: 'controlled-recovery', stage: 'acknowledged' },
      { action: 'controlled-recovery', stage: 'observed' },
      { action: 'native-compaction', stage: 'requested' },
      { action: 'native-compaction', stage: 'acknowledged' },
      { action: 'native-compaction', stage: 'observed' },
      { action: 'same-thread-continuation', stage: 'requested' },
      { action: 'same-thread-continuation', stage: 'observed' },
    ]));
  });

  it('retries the same-thread continuation once only after the provider compaction turn settles', async () => {
    vi.useFakeTimers();
    try {
      const { controller, deps } = createController();
      deps.getCompactionTarget = () => ({
        threadId: 'thread-fixture',
        start: async () => controller.recordCompactionObserved(400_000),
      });
      await controller.requestRecovery('controlled-recovery');

      const continueTurn = vi.fn()
        .mockRejectedValueOnce(new Error('failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }'))
        .mockResolvedValueOnce(undefined);

      const pending = controller.recoverAfterTurn({ turnStatus: 'interrupted', recoveryCount: 0, continueTurn });
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.isCompactionRunning()).toBe(true);
      expect(continueTurn).toHaveBeenCalledOnce();
      controller.acceptCompactionSignal({
        method: 'turn/completed',
        params: { threadId: 'thread-fixture', turn: { id: 'provider-compact-turn', status: 'completed' } },
      }, 'thread-fixture');
      await vi.advanceTimersByTimeAsync(0);

      await expect(pending).resolves.toBe(true);
      expect(continueTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry another retry-thread failure as though it were provider compaction', async () => {
    const { controller, deps } = createController();
    deps.getCompactionTarget = () => ({
      threadId: 'thread-fixture',
      start: async () => controller.recordCompactionObserved(400_000),
    });
    await controller.requestRecovery('controlled-recovery');
    const continueTurn = vi.fn().mockRejectedValue(new Error('RPC timeout: turn/start did not respond'));

    await expect(controller.recoverAfterTurn({
      turnStatus: 'interrupted',
      recoveryCount: 0,
      continueTurn,
    })).rejects.toThrow('RPC timeout');
    expect(continueTurn).toHaveBeenCalledOnce();
  });

  it('rethrows a non-transient continuation failure without retrying', async () => {
    const { controller, deps } = createController();
    deps.getCompactionTarget = () => ({
      threadId: 'thread-fixture',
      start: async () => controller.recordCompactionObserved(400_000),
    });
    await controller.requestRecovery('controlled-recovery');

    const continueTurn = vi.fn().mockRejectedValue(new Error('unauthorized: login required'));

    await expect(controller.recoverAfterTurn({
      turnStatus: 'interrupted',
      recoveryCount: 0,
      continueTurn,
    })).rejects.toThrow('unauthorized: login required');
    expect(continueTurn).toHaveBeenCalledOnce();
  });

  it('does not treat RPC acknowledgement as observed compaction proof', async () => {
    vi.useFakeTimers();
    try {
      const { controller, proofEvents } = createController({ compactionTimeoutMs: 5 });
      const pending = controller.compactContext(5);
      await vi.advanceTimersByTimeAsync(5);

      await expect(pending).resolves.toBe(false);
      expect(proofEvents).toContainEqual({ action: 'native-compaction', stage: 'acknowledged' });
      expect(proofEvents).not.toContainEqual({ action: 'native-compaction', stage: 'observed' });
    } finally {
      vi.useRealTimers();
    }
  });

  // LT-017: the installed Codex app-server never emits `thread/compacted`, so
  // every manual compaction paid the full timeout (30 s in production) before
  // falling back. Once a session has proved the notification absent, later
  // attempts must concede immediately.
  describe('LT-017 — the unobserved-notification timeout is not paid twice', () => {
    it('skips the native attempt after a timeout, without starting another RPC', async () => {
      vi.useFakeTimers();
      try {
        const start = vi.fn(async () => undefined);
        const { controller } = createController({
          compactionTimeoutMs: 5,
          getCompactionTarget: () => ({ threadId: 'thread-fixture', start }),
        });

        const first = controller.compactContext(5);
        await vi.advanceTimersByTimeAsync(5);
        await expect(first).resolves.toBe(false);
        expect(start).toHaveBeenCalledTimes(1);
        expect(controller.nativeCompactionKnownUnsupported()).toBe(true);

        // Second attempt: resolves without advancing any timer at all, and does
        // not issue another compact RPC. Before the fix this hung until the
        // timeout elapsed again.
        await expect(controller.compactContext(5)).resolves.toBe(false);
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-enables the native path once the provider does emit the notification', async () => {
      vi.useFakeTimers();
      try {
        const { controller } = createController({ compactionTimeoutMs: 5 });
        const first = controller.compactContext(5);
        await vi.advanceTimersByTimeAsync(5);
        await expect(first).resolves.toBe(false);
        expect(controller.nativeCompactionKnownUnsupported()).toBe(true);

        // A CLI upgrade mid-session should not leave the native path disabled.
        controller.recordCompactionObserved(1_000);
        expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    // 2026-09-23: codex-cli 0.156.1 took 70s to compact a 107k-token thread.
    // The 30s window failed a compaction that was succeeding and then disabled
    // native compaction for the rest of the session.
    it('waits out a slow compaction the provider reported running', async () => {
      vi.useFakeTimers();
      try {
        const { controller, proofEvents } = createController({
          compactionTimeoutMs: 30,
          compactionRunningTimeoutMs: 180,
          getCompactionTarget: () => ({
            threadId: 'thread-fixture',
            start: async () => { controller.recordCompactionStarted(); },
          }),
        });

        const pending = controller.compactContext(30);
        await vi.advanceTimersByTimeAsync(70);
        controller.recordCompactionObserved(1_000);

        await expect(pending).resolves.toBe(true);
        expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
        expect(proofEvents).toContainEqual({ action: 'native-compaction', stage: 'observed' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails a stalled compaction without marking native compaction unsupported', async () => {
      vi.useFakeTimers();
      try {
        const lifecycle: Array<{ phase: 'started' | 'completed'; outcome?: string }> = [];
        const start = vi.fn(async () => { controller.recordCompactionStarted(); });
        const { controller } = createController({
          compactionTimeoutMs: 30,
          compactionRunningTimeoutMs: 180,
          getCompactionTarget: () => ({ threadId: 'thread-fixture', start }),
          onCompactionStateChange: (phase, outcome) => lifecycle.push({ phase, outcome }),
        });

        const first = controller.compactContext(30);
        await vi.advanceTimersByTimeAsync(180);
        await expect(first).resolves.toBe(false);
        expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
        expect(controller.isCompactionRunning()).toBe(false);
        expect(lifecycle).toEqual([
          { phase: 'started', outcome: undefined },
          { phase: 'completed', outcome: 'stalled' },
        ]);

        // The next attempt still issues a real compaction request.
        void controller.compactContext(30);
        await vi.advanceTimersByTimeAsync(0);
        expect(start).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the native path enabled when the provider does emit the notification', async () => {
      const { controller, proofEvents } = createController({ compactionTimeoutMs: 50 });
      // A provider that settles the gate during the compact RPC — i.e. a build
      // that behaves correctly. The timeout must never be recorded against it.
      const { controller: healthy } = createController({
        compactionTimeoutMs: 50,
        getCompactionTarget: () => ({
          threadId: 'thread-fixture',
          start: async () => healthy.recordCompactionObserved(1_000),
        }),
      });

      await expect(healthy.compactContext(50)).resolves.toBe(true);
      expect(healthy.nativeCompactionKnownUnsupported()).toBe(false);
      // A fresh controller starts enabled.
      expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
      expect(proofEvents).toEqual([]);
    });
  });

  // 2026-09-23: Codex self-manages compaction during the controlled-recovery
  // interrupt. `recordCompactionObserved` settles the gate with zero waiters,
  // then `compactContext` starts a fresh wait and sends `thread/compact/start`
  // against an already-compacted thread — no further signal arrives, the wait
  // times out, and `nativeCompactionUnobserved` is poisoned for the session.
  describe('compaction observed outside an active wait', () => {
    it('returns true without issuing a compact RPC when a compaction already landed', async () => {
      const start = vi.fn(async () => undefined);
      const { controller } = createController({
        compactionTimeoutMs: 50,
        getCompactionTarget: () => ({ threadId: 'thread-fixture', start }),
      });

      // Codex self-managed compaction during the interrupt — no gate waiters.
      controller.recordCompactionObserved(400_000);

      await expect(controller.compactContext(50)).resolves.toBe(true);
      expect(start).not.toHaveBeenCalled();
      expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
    });

    it('clears the flag so the next call without a new observation attempts real compaction', async () => {
      const start = vi.fn(async () => undefined);
      const { controller } = createController({
        compactionTimeoutMs: 5,
        getCompactionTarget: () => ({ threadId: 'thread-fixture', start }),
      });

      controller.recordCompactionObserved(400_000);
      await expect(controller.compactContext(5)).resolves.toBe(true);
      expect(start).not.toHaveBeenCalled();

      // Second call: no new observation, so it must attempt the RPC.
      vi.useFakeTimers();
      try {
        const pending = controller.compactContext(5);
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending).resolves.toBe(false);
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not set the flag when a wait was already pending (normal observed path)', async () => {
      vi.useFakeTimers();
      try {
        const { controller } = createController({
          compactionTimeoutMs: 50,
          getCompactionTarget: () => ({
            threadId: 'thread-fixture',
            start: async () => { /* signal arrives via recordCompactionObserved below */ },
          }),
        });

        const pending = controller.compactContext(50);
        // Simulate the signal arriving during the wait.
        controller.recordCompactionObserved(1_000);
        await expect(pending).resolves.toBe(true);

        // The flag must NOT be set (the wait consumed the observation),
        // so the next call attempts a real RPC.
        const start2 = vi.fn(async () => undefined);
        (controller as unknown as { deps: { getCompactionTarget: () => unknown } }).deps.getCompactionTarget =
          () => ({ threadId: 'thread-fixture', start: start2 });
        const pending2 = controller.compactContext(5);
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending2).resolves.toBe(false);
        expect(start2).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('a running provider compaction', () => {
    const itemParams = { threadId: 'thread-fixture', turnId: 'compact-turn', item: { type: 'contextCompaction' } };
    const started: AppServerNotification = { method: 'item/started', params: itemParams };
    const aborted: AppServerNotification = {
      method: 'turn/completed',
      params: { threadId: 'thread-fixture', turn: { id: 'compact-turn', status: 'failed' } },
    };

    async function startRecoveryWait(overrides: Parameters<typeof createController>[0] = {}) {
      const interruptCompaction = vi.fn(async () => undefined);
      const setup = createController({
        compactionTimeoutMs: 30_000,
        compactionRunningTimeoutMs: 900_000,
        getCompactionTarget: () => ({
          threadId: 'thread-fixture',
          start: async () => { setup.controller.acceptCompactionSignal(started, 'thread-fixture'); },
          interrupt: interruptCompaction,
        }),
        ...overrides,
      });
      await setup.controller.requestRecovery('controlled-recovery');
      const continueTurn = vi.fn(async () => undefined);
      const recovery = setup.controller.recoverAfterTurn({ turnStatus: 'interrupted', recoveryCount: 0, continueTurn });
      await vi.advanceTimersByTimeAsync(0);
      return { ...setup, recovery, continueTurn, interruptCompaction };
    }

    it('emits liveness heartbeats while it runs and stops when it completes', async () => {
      vi.useFakeTimers();
      try {
        const emitHeartbeat = vi.fn();
        const { controller, recovery, continueTurn } = await startRecoveryWait({
          compactionHeartbeatMs: 15_000,
          emitHeartbeat,
        });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(emitHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(40);

        controller.recordCompactionObserved(1_000);
        await expect(recovery).resolves.toBe(true);
        expect(continueTurn).toHaveBeenCalledOnce();

        const calls = emitHeartbeat.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(emitHeartbeat).toHaveBeenCalledTimes(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops heartbeats at the running window even if no completion ever reaches this thread', async () => {
      vi.useFakeTimers();
      try {
        const emitHeartbeat = vi.fn();
        const { controller } = createController({
          compactionTimeoutMs: 100,
          compactionRunningTimeoutMs: 1_000,
          compactionHeartbeatMs: 100,
          emitHeartbeat,
        });
        controller.acceptCompactionSignal(started, 'thread-fixture');
        await vi.advanceTimersByTimeAsync(1_000);
        const calls = emitHeartbeat.mock.calls.length;

        await vi.advanceTimersByTimeAsync(5_000);

        expect(emitHeartbeat).toHaveBeenCalledTimes(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it('pauses at once, with an error already shown to the user, when the provider aborts the compaction', async () => {
      vi.useFakeTimers();
      try {
        const { controller, recovery, continueTurn, deps } = await startRecoveryWait();
        const outcome = recovery.then(() => null, (error: unknown) => error);

        controller.acceptCompactionSignal(aborted, 'thread-fixture');
        await vi.advanceTimersByTimeAsync(0);

        const error = await outcome;
        expect(isSurfacedToUserError(error)).toBe(true);
        expect((error as Error).message).toMatch(/compaction could not be confirmed/);
        expect(continueTurn).not.toHaveBeenCalled();
        expect(deps.emitSystem).toHaveBeenCalledWith(
          expect.stringMatching(/compaction could not be confirmed/),
          expect.objectContaining({ contextCostRecoveryPaused: true }),
        );
        // An aborted compaction proves the provider signals compaction, so native stays enabled.
        expect(controller.nativeCompactionKnownUnsupported()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('interrupts the compaction turn on a user stop and ends the recovery without continuing', async () => {
      vi.useFakeTimers();
      try {
        const { controller, recovery, continueTurn, interruptCompaction, deps } = await startRecoveryWait();

        const result = controller.interruptRecoveryCompaction();
        expect(result).toMatchObject({ status: 'accepted', turnId: 'compact-turn' });
        expect(interruptCompaction).toHaveBeenCalledWith('compact-turn');

        controller.acceptCompactionSignal({
          method: 'turn/completed' as const,
          params: { threadId: 'thread-fixture', turn: { id: 'compact-turn', status: 'interrupted' } },
        }, 'thread-fixture');

        await expect(result?.completion).resolves.toEqual({ status: 'interrupted', turnId: 'compact-turn' });
        await expect(recovery).resolves.toBe(true);
        expect(continueTurn).not.toHaveBeenCalled();
        expect(deps.emitSystem).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not continue when the compaction completes after the user asked to stop', async () => {
      vi.useFakeTimers();
      try {
        const { controller, recovery, continueTurn } = await startRecoveryWait();

        const result = controller.interruptRecoveryCompaction();
        controller.recordCompactionObserved(1_000);

        await expect(result?.completion).resolves.toMatchObject({ status: 'completed' });
        await expect(recovery).resolves.toBe(true);
        expect(continueTurn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the recovery stoppable when a plain compaction overlaps its wait', async () => {
      vi.useFakeTimers();
      try {
        const { controller, recovery, continueTurn } = await startRecoveryWait();
        const overlapping = controller.compactContext(30_000);
        await vi.advanceTimersByTimeAsync(0);

        const result = controller.interruptRecoveryCompaction();
        expect(result).toMatchObject({ status: 'accepted', turnId: 'compact-turn' });
        controller.acceptCompactionSignal(aborted, 'thread-fixture');

        await expect(overlapping).resolves.toBe(false);
        await expect(recovery).resolves.toBe(true);
        expect(continueTurn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('offers no compaction stop outside a controlled recovery', async () => {
      vi.useFakeTimers();
      try {
        const { controller } = createController({
          compactionRunningTimeoutMs: 1_000,
          getCompactionTarget: () => ({
            threadId: 'thread-fixture',
            start: async () => { controller.acceptCompactionSignal(started, 'thread-fixture'); },
            interrupt: vi.fn(async () => undefined),
          }),
        });
        // A plain compaction wait (e.g. per-turn cap recovery) is not stoppable here.
        void controller.compactContext(50);
        await vi.advanceTimersByTimeAsync(0);

        expect(controller.interruptRecoveryCompaction()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not interrupt again when the shared policy requests recovery during the compaction wait', async () => {
      vi.useFakeTimers();
      try {
        const { controller, deps, interruptCompaction } = await startRecoveryWait();
        const interruptCalls = (deps.interrupt as ReturnType<typeof vi.fn>).mock.calls.length;

        await expect(controller.requestRecovery('controlled-recovery')).resolves.toEqual({ proof: 'acknowledged' });

        expect(deps.interrupt).toHaveBeenCalledTimes(interruptCalls);
        expect(interruptCompaction).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases the wait when the app-server exits mid-compaction', async () => {
      vi.useFakeTimers();
      try {
        const lifecycle: Array<{ phase: 'started' | 'completed'; outcome?: string }> = [];
        const { controller, recovery } = await startRecoveryWait({
          onCompactionStateChange: (phase, outcome) => lifecycle.push({ phase, outcome }),
        });
        const outcome = recovery.then(() => null, (error: unknown) => error);

        controller.handleRuntimeExit();
        await vi.advanceTimersByTimeAsync(0);

        expect(isSurfacedToUserError(await outcome)).toBe(true);
        expect(controller.isCompactionRunning()).toBe(false);
        expect(lifecycle).toEqual([
          { phase: 'started', outcome: undefined },
          { phase: 'completed', outcome: 'cancelled' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('exposes a bounded gate for sends that arrive while compaction is running', async () => {
      vi.useFakeTimers();
      try {
        const { controller } = createController({ compactionRunningTimeoutMs: 20_000 });
        controller.acceptCompactionSignal(started, 'thread-fixture');

        let settled = false;
        const wait = controller.awaitCompactionSettled().finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(settled).toBe(false);

        controller.recordCompactionObserved(1_000);
        await expect(wait).resolves.toBe('observed');
        expect(controller.isCompactionRunning()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the reported turn id and single start when a rejection races the start notification', () => {
      const lifecycle: Array<'started' | 'completed'> = [];
      const { controller } = createController({
        onCompactionStateChange: (phase) => lifecycle.push(phase),
      });

      controller.acceptCompactionSignal(started, 'thread-fixture');
      controller.markCompactionRunningFromRejection(null);

      expect(controller.runningCompactionTurnId()).toBe('compact-turn');
      expect(lifecycle).toEqual(['started']);
    });

    it('resets the trigger after policy compaction so a later provider compaction is self-managed', async () => {
      const lifecycle: Array<{ phase: 'started' | 'completed'; trigger: 'self-managed' | 'policy' }> = [];
      let controller: CodexContextCostController;
      ({ controller } = createController({
        getCompactionTarget: () => ({
          threadId: 'thread-fixture',
          start: async () => controller.recordCompactionStarted(),
        }),
        onCompactionStateChange: (phase) => {
          lifecycle.push({ phase, trigger: controller.runningCompactionTrigger() });
        },
      }));

      const policyCompaction = controller.compactContext(50);
      controller.recordCompactionObserved(1_000);
      await expect(policyCompaction).resolves.toBe(true);

      controller.acceptCompactionSignal(started, 'thread-fixture');

      expect(lifecycle).toEqual([
        { phase: 'started', trigger: 'policy' },
        { phase: 'completed', trigger: 'policy' },
        { phase: 'started', trigger: 'self-managed' },
      ]);
    });

    it('returns stalled when a running compaction exceeds the bounded send gate', async () => {
      vi.useFakeTimers();
      try {
        const { controller } = createController({ compactionRunningTimeoutMs: 20_000 });
        controller.acceptCompactionSignal(started, 'thread-fixture');

        const wait = controller.awaitCompactionSettled();
        await vi.advanceTimersByTimeAsync(20_000);

        await expect(wait).resolves.toBe('stalled');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
