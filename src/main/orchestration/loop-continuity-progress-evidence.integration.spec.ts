import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import {
  buildObservedAttemptEvidence,
  createAttemptDeltaObserver,
} from './loop-attempt-observation';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';

let workspace: string;
let coordinator: LoopCoordinator;

function write(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function writeLedger(payload: unknown, openCount: number): void {
  const input = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(input.workspaceCwd, input.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  const tasks = Array.from({ length: 20 }, (_, index) =>
    `- [${index < 20 - openCount ? 'x' : ' '}] Stable task ${index + 1}`);
  writeFileSync(loopStateFile(paths, 'LOOP_TASKS.md'), `# Loop Tasks\n${tasks.join('\n')}\n`);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-continuity-evidence-'));
  const repository = join(workspace, 'nested-repo');
  mkdirSync(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repository });
  write(repository, 'tracked.ts', 'export const value = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repository });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repository });
  write(workspace, 'STAGE.md', 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
  coordinator.setCleanReviewClassifier(async () => ({
    clean: false,
    confidence: 1,
    reason: 'persistent CRITICAL findings remain',
  }));
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try {
      await coordinator.cancelLoop(loop.id);
    } catch {
      // Best-effort test cleanup.
    }
  }
  rmSync(workspace, { recursive: true, force: true });
});

describe('loop continuity/progress/evidence incident integration', () => {
  it('drives a persistent fake invoker through the real coordinator and preserves the cap terminal', async () => {
    const nativeThread = 'stable-native-thread';
    const initializeForRequest = vi.fn(async () => undefined);
    let initialized = false;
    const requestResponse = vi.fn(async (message: CliMessage): Promise<CliResponse> => {
      if (!initialized) {
        initialized = true;
        await initializeForRequest();
      }
      return {
        id: `response-${requestResponse.mock.calls.length}`,
        role: 'assistant',
        content: `persistent CRITICAL review: ${message.content}`,
        metadata: { nativeThread },
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0, cost: 0.01 },
      };
    });
    const observedThreads: string[] = [];
    const observedPaths = new Set<string>();
    const observedCoverages: string[] = [];
    const openCounts = [20, 18, 14, 10, 10];

    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const input = payload as {
        seq: number;
        prompt: string;
        callback(result: LoopChildResult): void;
      };
      void (async () => {
        const observer = createAttemptDeltaObserver(workspace);
        const response = await requestResponse({ role: 'user', content: input.prompt });
        if (input.seq === 0) {
          write(workspace, 'deliverable.md', 'root result');
          write(workspace, 'nested-repo/tracked.ts', 'export const value = 2;\n');
        }
        const observation = observer.observe();
        observedCoverages.push(observation.coverage);
        for (const change of observation.changes) observedPaths.add(change.path);
        observedThreads.push(String(response.metadata?.['nativeThread']));
        writeLedger(payload, openCounts[input.seq] ?? 10);
        input.callback({
          childInstanceId: null,
          output: response.content,
          tokens: response.usage?.totalTokens ?? 0,
          costUsd: response.usage?.cost ?? 0,
          filesChanged: observation.changes,
          toolCalls: [],
          errors: [],
          testPassCount: null,
          testFailCount: null,
          exitedCleanly: true,
          attemptEvidence: buildObservedAttemptEvidence({
            outcome: 'completed',
            outputOrError: response.content,
            observation,
            providerThreadReusable: true,
          }),
        });
      })();
    });

    const terminal = new Promise<{ reason: string }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(
          `incident integration did not reach the cap: calls=${requestResponse.mock.calls.length}`,
        )),
        45_000,
      );
      coordinator.on('loop:cap-reached', (event: { reason: string }) => {
        clearTimeout(timeout);
        resolve(event);
      });
      coordinator.on('loop:completed-needs-review', (event) => {
        clearTimeout(timeout);
        reject(new Error(`review stall incorrectly won: ${JSON.stringify(event)}`));
      });
    });

    const state = await coordinator.startLoop('chat-continuity-evidence', {
      initialPrompt: 'complete stable tasks',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 30,
        maxWallTimeMs: 120_000,
        maxTokens: 1_000_000,
        maxCostCents: 4,
      },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        mode: 'review-driven',
        maxStalledReviewIterations: 3,
        maxLedgerStallIterations: 20,
        verifyCommand: '',
        crossModelReview: {
          enabled: false,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    const event = await terminal;
    const final = coordinator.getLoop(state.id);
    expect(initializeForRequest).toHaveBeenCalledTimes(1);
    // T45 (Decision 4): the cost cap terminates without a wrap-up turn, so the
    // run is one paid iteration shorter than before.
    expect(requestResponse).toHaveBeenCalledTimes(4);
    expect(new Set(observedThreads)).toEqual(new Set([nativeThread]));
    expect(observedCoverages.every((coverage) => coverage === 'complete')).toBe(true);
    expect([...observedPaths].sort()).toEqual([
      'deliverable.md',
      'nested-repo/tracked.ts',
    ]);
    expect(final?.status).toBe('cap-reached');
    expect(event.reason).toMatch(/cost/i);
    expect(final?.endReason).toBe(event.reason);
  }, 50_000);
});
