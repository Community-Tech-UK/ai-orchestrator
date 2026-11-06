import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { CompletedFileWatcher } from './loop-completion-detector';
import type { LoopStageMachine } from './loop-stage-machine';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import type { HarnessStopDetails } from '../../shared/utils/harness-stop';

type LoopExecution = (state: LoopState, stageMachine: LoopStageMachine) => Promise<void>;

let workspace: string;
let coordinator: LoopCoordinator;
let execution: MockInstance<LoopExecution>;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-harness-stop-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-harness-stop"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
  execution = vi.spyOn(coordinator as unknown as { runLoop: LoopExecution }, 'runLoop');
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  for (const result of execution.mock.results) {
    if (result.type === 'return') await result.value;
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

const stop: HarnessStopDetails = { reason: 'turn-token-ceiling', tokens: 300_000_123, thresholdTokens: 300_000_000 };

const evidenceFor = (workspaceEffect: 'none-observed' | 'writes-observed' | 'unknown') => ({
  outcome: 'failed' as const,
  outputExcerpt: 'Stopped by Harness',
  workspaceEffect,
  filesChanged: workspaceEffect === 'writes-observed'
    ? [{ path: 'src/half-written.ts', additions: 12, deletions: 0, contentHash: 'h1' }]
    : [],
  providerThreadReusable: false,
});

describe('LoopCoordinator when Harness stops a round at the Codex token limit', () => {
  // The same round would run past the limit again, so any retry or next round spends the tokens twice.
  it.each(['none-observed', 'writes-observed', 'unknown'] as const)(
    'ends the loop instead of retrying or moving on (workspace effect: %s)',
    async (workspaceEffect) => {
      let invokeCount = 0;
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
        invokeCount += 1;
        p.callback({
          error: 'Stopped by Harness: this turn passed 300M tokens.',
          harnessStop: stop,
          attemptEvidence: evidenceFor(workspaceEffect),
        } as never);
      });

      const state = await coordinator.startLoop(`chat-harness-stop-${workspaceEffect}`, {
        initialPrompt: 'keep going',
        workspaceCwd: workspace,
        provider: 'codex',
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 5 },
        degradedIterationRetry: { enabled: true, maxRetries: 2 },
        completion: {
          ...defaultLoopConfig(workspace, 'x').completion,
          verifyCommand: 'false',
          runVerifyTwice: false,
          requireCompletedFileRename: false,
          crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
        },
      });

      await waitForCondition(() => coordinator.getLoop(state.id)?.status !== 'running', 5000);
      // Give a wrongly scheduled retry or next round time to show itself.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const final = coordinator.getLoop(state.id);
      expect(invokeCount).toBe(1);
      expect(final?.status).toBe('error');
      expect(final?.endedAt).not.toBeNull();
      expect(final?.endReason).toContain('300M tokens');
      expect(final?.endReason).toContain('not retried');
    },
  );

  it('still retries an ordinary failed round', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      if (invokeCount === 1) {
        p.callback({ error: 'boom', attemptEvidence: evidenceFor('none-observed') } as never);
        return;
      }
      p.callback({
        childInstanceId: null, output: 'recovered', tokens: 1, filesChanged: [], toolCalls: [], errors: [],
        testPassCount: null, testFailCount: null, exitedCleanly: true,
      });
    });

    const state = await coordinator.startLoop('chat-ordinary-failure', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      provider: 'codex',
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    await waitForCondition(() => invokeCount >= 2, 5000);
    expect(coordinator.getLoop(state.id)?.status).not.toBe('error');
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met before timeout');
}
