import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the transport-failure backoff instant so these tests don't wait the real
// 5s window. Everything else in the utils module is preserved.
vi.mock('./loop-coordinator-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loop-coordinator-utils')>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { classifyDegradedIteration } from './loop-coordinator-block-utils';
import { CompletedFileWatcher } from './loop-completion-detector';
import {
  isTransportFailureOnlyIteration,
  isTransportFailureOnlyOutput,
} from './loop-transport-failure-output';
import { defaultLoopConfig } from '../../shared/types/loop.types';

/** Verbatim shape cursor-agent printed as the assistant turn during the 2026-09-02 outage. */
const CURSOR_TRANSPORT_FAILURE =
  '\n\nError: RetriableError: [unavailable] getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh\n';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-transport-failure-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-transport-failure"}\n');
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

describe('isTransportFailureOnlyOutput', () => {
  it('matches transport failures printed as the assistant turn', () => {
    for (const text of [
      CURSOR_TRANSPORT_FAILURE,
      'Error: fetch failed',
      'error: socket hang up',
      'Error: connect ECONNREFUSED 127.0.0.1:443',
      'Request failed: 503 Service Unavailable',
      'Error: getaddrinfo EAI_AGAIN api.example.com',
    ]) {
      expect(isTransportFailureOnlyOutput(text), text).toBe(true);
    }
  });

  it('does not match a real turn that merely discusses networking', () => {
    for (const text of [
      "I fixed the ECONNREFUSED retry path in the gateway client and added a test for socket hang up handling.",
      'Read 4 files, then updated fetch failed handling in http-client.ts.',
      'Error: expected 3 to be 4', // a test failure, not a transport failure
      `Error: RetriableError: ${'x'.repeat(700)}`, // too long to be a bare error turn
      '',
      '   ',
    ]) {
      expect(isTransportFailureOnlyOutput(text), text).toBe(false);
    }
    expect(isTransportFailureOnlyOutput(null)).toBe(false);
    expect(isTransportFailureOnlyOutput(undefined)).toBe(false);
  });
});

describe('isTransportFailureOnlyIteration', () => {
  it('only matches a recorded iteration that did no work at all', () => {
    const base = { filesChanged: [], toolCalls: [], outputExcerpt: CURSOR_TRANSPORT_FAILURE };
    expect(isTransportFailureOnlyIteration(base)).toBe(true);
    expect(isTransportFailureOnlyIteration({ ...base, toolCalls: [{}] })).toBe(false);
    expect(isTransportFailureOnlyIteration({ ...base, filesChanged: [{}] })).toBe(false);
    expect(isTransportFailureOnlyIteration({ ...base, outputExcerpt: 'did the work' })).toBe(false);
    expect(isTransportFailureOnlyIteration(null)).toBe(false);
  });

  it('prefers the full output over the excerpt', () => {
    expect(isTransportFailureOnlyIteration({
      filesChanged: [],
      toolCalls: [],
      outputFull: 'I refactored the retry client.',
      outputExcerpt: 'Error: fetch failed',
    })).toBe(false);
  });
});

describe('classifyDegradedIteration — transport failure', () => {
  it('classifies a work-free transport-error turn as degraded', () => {
    expect(classifyDegradedIteration(iterationResult(CURSOR_TRANSPORT_FAILURE), null))
      .toBe('transport-failure');
  });

  it('leaves a turn that also did work alone', () => {
    expect(classifyDegradedIteration(
      iterationResult(CURSOR_TRANSPORT_FAILURE, {
        toolCalls: [{ toolName: 'Read', argsHash: 'abc', success: true, durationMs: 1 }],
      }),
      null,
    )).toBeNull();
    expect(classifyDegradedIteration(
      iterationResult(CURSOR_TRANSPORT_FAILURE, {
        filesChanged: [{ path: 'src/a.ts', additions: 1, deletions: 0, contentHash: 'h' }],
      }),
      null,
    )).toBeNull();
  });
});

describe('LoopCoordinator provider transport failure handling', () => {
  it('retries the same seq instead of burning an iteration on a transport blip', async () => {
    let invokeCount = 0;
    const seqs: number[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (result: LoopChildResult) => void };
      invokeCount += 1;
      seqs.push(p.seq);
      p.callback(invokeCount === 1
        ? iterationResult(CURSOR_TRANSPORT_FAILURE)
        : iterationResult('recovered after the network came back'));
    });

    const state = await coordinator.startLoop('chat-transport-blip', loopOptions(1));
    try {
      await waitForCondition(() => invokeCount >= 2, 5000);
      await waitForCondition(() => coordinator.getLoop(state.id)?.status !== 'running', 5000);
      // Both attempts belong to seq 0 — the blip cost a retry, not an iteration.
      expect(seqs.slice(0, 2)).toEqual([0, 0]);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('pauses instead of grinding when the provider stays unreachable', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult(CURSOR_TRANSPORT_FAILURE));
    });

    const state = await coordinator.startLoop('chat-transport-outage', loopOptions(5));
    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'paused', 8000);
      const paused = coordinator.getLoop(state.id);
      expect(paused?.status).toBe('paused');
      expect(paused?.endReason).toContain('Provider transport failure');
      // seq 0 and seq 1, each with 1 attempt + 2 retries — the cap is never reached.
      expect(invokeCount).toBe(6);
      expect(paused?.totalIterations).toBeLessThanOrEqual(2);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });
});

function loopOptions(maxIterations: number) {
  const defaults = defaultLoopConfig(workspace, 'x');
  return {
    initialPrompt: 'keep going',
    workspaceCwd: workspace,
    caps: { ...defaults.caps, maxIterations },
    degradedIterationRetry: { enabled: true, maxRetries: 2 },
    completion: {
      ...defaults.completion,
      verifyCommand: 'false',
      runVerifyTwice: false,
      requireCompletedFileRename: false,
      crossModelReview: {
        enabled: false,
        blockingSeverities: ['critical' as const],
        timeoutSeconds: 10,
        reviewDepth: 'structured' as const,
      },
    },
  };
}

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
