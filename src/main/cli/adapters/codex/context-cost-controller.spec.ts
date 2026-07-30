import { describe, expect, it, vi } from 'vitest';

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
});
