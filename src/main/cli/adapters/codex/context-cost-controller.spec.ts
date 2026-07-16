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
});
