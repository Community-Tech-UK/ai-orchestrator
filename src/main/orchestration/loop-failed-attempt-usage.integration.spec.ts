import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator } from './loop-coordinator';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { LoopChildInvocationError } from './loop-coordinator.types';

interface ActivityPayload {
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}

describe('failed-attempt usage accounting (coordinator)', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    workspace = mkdtempSync(join(tmpdir(), 'loop-failed-attempt-usage-'));
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: passingVerifyCommand() } }));
    coordinator = new LoopCoordinator();
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  function startFailingLoop(
    failure: LoopChildInvocationError,
  ): { activity: ActivityPayload[]; ended: Promise<void>; start: () => Promise<{ id: string }> } {
    const activity: ActivityPayload[] = [];
    coordinator.on('loop:activity', (payload: unknown) => activity.push(payload as ActivityPayload));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildInvocationError) => void };
      queueMicrotask(() => p.callback(failure));
    });

    const ended = new Promise<void>((resolve) => {
      coordinator.on('loop:error', () => resolve());
      coordinator.on('loop:failed', () => resolve());
      coordinator.on('loop:paused', () => resolve());
      coordinator.on('loop:cap-reached', () => resolve());
    });

    const base = defaultLoopConfig(workspace, 'finish the work');
    const start = () => coordinator.startLoop('chat-failed-usage', {
      ...base,
      degradedIterationRetry: { enabled: false, maxRetries: 0 },
      caps: { ...base.caps, maxIterations: 1 },
      completion: { ...base.completion, verifyCommand: passingVerifyCommand(), runVerifyTwice: false },
    });

    return { activity, ended, start };
  }

  it('charges an estimated partial-usage snapshot once and labels it estimated', async () => {
    const { activity, ended, start } = startFailingLoop({
      error: 'ACP prompt turn failed.',
      model: 'grok-4.6',
      partialUsage: { inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000, isEstimated: true },
    });

    const state = await start();
    await ended;

    const finalState = coordinator.getLoop(state.id);
    expect(finalState?.totalTokens).toBe(2_000);
    expect(finalState?.totalCostCents).toBeGreaterThan(0);
    expect(finalState?.tokensSinceLastTestImprovement).toBe(2_000);

    const charged = activity.filter((a) => a.detail?.['accounting'] === 'failed-attempt');
    expect(charged).toHaveLength(1);
    expect(charged[0].message).toContain('Estimated');
    expect(charged[0].message).toContain('2,000 tokens');
    expect(charged[0].detail).toMatchObject({ estimated: true, tokens: 2_000, model: 'grok-4.6' });
  }, 20_000);

  it('charges the attempt without hijacking cap or writes-unprovable pause semantics', async () => {
    // The charge deliberately does NOT terminate the run itself, even when it
    // overshoots a hard cap: a second cap path would skip the
    // `capWrapUpIteration` wrap-up turn LoopPreIterationGuard guarantees.
    // The pre-existing WS5 rule still owns the outcome — a failed attempt with
    // an unprovable workspace state pauses for review instead of replaying.
    const capReached: { cap: string }[] = [];
    coordinator.on('loop:cap-reached', (p: unknown) => capReached.push(p as { cap: string }));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildInvocationError) => void };
      queueMicrotask(() => p.callback({
        error: 'ACP prompt turn failed.',
        model: 'grok-4.6',
        partialUsage: { inputTokens: 3_000, outputTokens: 2_000, totalTokens: 5_000, isEstimated: true },
      }));
    });
    const settled = new Promise<void>((resolve) => {
      for (const event of ['loop:completed-needs-review', 'loop:cap-reached', 'loop:error', 'loop:failed']) {
        coordinator.on(event, () => resolve());
      }
    });

    const base = defaultLoopConfig(workspace, 'finish the work');
    // Retries ON: the WS5 guard, not the retry budget, must decide the outcome.
    const state = await coordinator.startLoop('chat-cap-guard', {
      ...base,
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
      caps: { ...base.caps, maxIterations: 10, maxTokens: 1_000 },
      completion: { ...base.completion, verifyCommand: passingVerifyCommand(), runVerifyTwice: false },
    });
    await settled;

    const finalState = coordinator.getLoop(state.id);
    // Charged, and past the 1,000-token cap — but not killed by the charge.
    expect(finalState?.totalTokens).toBe(5_000);
    expect(capReached).toHaveLength(0);
    // Unchanged WS5 semantics: unprovable workspace state pauses for review.
    expect(finalState?.status).toBe('completed-needs-review');
  }, 30_000);

  it('leaves run totals untouched when the failed attempt reported nothing estimable', async () => {
    const { activity, ended, start } = startFailingLoop({ error: 'spawn failed' });

    const state = await start();
    await ended;

    const finalState = coordinator.getLoop(state.id);
    expect(finalState?.totalTokens).toBe(0);
    expect(finalState?.totalCostCents).toBe(0);
    expect(activity.some((a) => a.detail?.['accounting'] === 'failed-attempt')).toBe(false);
  }, 20_000);
});
