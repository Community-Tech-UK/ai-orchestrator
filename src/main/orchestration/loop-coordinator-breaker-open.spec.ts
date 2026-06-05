import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the breaker-open backoff instant so these tests don't wait the real
// 65s reset window. Everything else in the utils module is preserved.
vi.mock('./loop-coordinator-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loop-coordinator-utils')>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { isCircuitBreakerOpenError } from './loop-coordinator-block-utils';
import { CompletedFileWatcher } from './loop-completion-detector';
import { defaultLoopConfig } from '../../shared/types/loop.types';

const BREAKER_OPEN_ERROR = "Circuit breaker 'loop-orchestration:claude' is OPEN";

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-breaker-open-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-breaker-open"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('isCircuitBreakerOpenError', () => {
  it('matches the breaker rejection message regardless of casing/name', () => {
    expect(isCircuitBreakerOpenError(BREAKER_OPEN_ERROR)).toBe(true);
    expect(isCircuitBreakerOpenError("Circuit breaker 'cross-review-codex' is OPEN")).toBe(true);
    expect(isCircuitBreakerOpenError('circuit breaker foo is open')).toBe(true);
  });

  it('does not match unrelated invocation errors', () => {
    expect(isCircuitBreakerOpenError('boom')).toBe(false);
    expect(isCircuitBreakerOpenError('Loop iteration timed out after 1800000ms')).toBe(false);
    expect(isCircuitBreakerOpenError(null)).toBe(false);
    expect(isCircuitBreakerOpenError(undefined)).toBe(false);
  });
});

describe('LoopCoordinator circuit-breaker-open handling', () => {
  it('backs off and recovers from a transient breaker trip even with degraded retry disabled', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      if (invokeCount === 1) {
        p.callback({ error: BREAKER_OPEN_ERROR });
        return;
      }
      p.callback(iterationResult('recovered after breaker reopened'));
    });

    const state = await coordinator.startLoop('chat-breaker-recovers', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      // Breaker-open backoff is independent of the degraded-iteration budget:
      // even disabled, a breaker trip must still be retried.
      degradedIterationRetry: { enabled: false, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 5000);
      await waitForCondition(() => coordinator.getLoop(state.id)?.status !== 'running', 5000);
      expect(invokeCount).toBeGreaterThanOrEqual(2);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('gives up and terminates as error after the bounded breaker-open backoffs are exhausted', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      p.callback({ error: BREAKER_OPEN_ERROR });
    });

    const state = await coordinator.startLoop('chat-breaker-exhausts', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      degradedIterationRetry: { enabled: false, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'error', 5000);
      // 1 initial attempt + LOOP_MAX_BREAKER_OPEN_WAITS (3) retries.
      expect(invokeCount).toBe(4);
      expect(coordinator.getLoop(state.id)?.status).toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
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

function iterationResult(output: string, overrides?: Partial<LoopChildResult>): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
    ...overrides,
  };
}
