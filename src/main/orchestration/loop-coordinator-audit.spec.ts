import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLoopConfig, type ProgressSignalEvidence } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { loopStateFile, resolveLoopArtifactPaths } from './loop-artifact-paths';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';

let workspace: string;
let coordinator: LoopCoordinator;
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const maybe = gitOk ? it : it.skip;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-audit-'));
  LoopCoordinator._resetForTesting();
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  await cleanupLoopCoordinatorSpec({ coordinator, workspace });
}, 20_000);

describe('LoopCoordinator audit integration', () => {
  it('blocks before the first iteration when preflight verify is red', async () => {
    let invocations = 0;
    const paused = new Promise<{ signal: ProgressSignalEvidence }>((resolve) => {
      coordinator.on('loop:paused-no-progress', (payload) => resolve(payload as { signal: ProgressSignalEvidence }));
    });
    coordinator.on('loop:invoke-iteration', () => {
      invocations += 1;
    });

    const base = defaultLoopConfig(workspace, 'preflight should fail');
    const state = await coordinator.startLoop('chat-preflight-red', {
      initialPrompt: 'make the tests pass',
      workspaceCwd: workspace,
      caps: { ...base.caps, maxIterations: 5 },
      audit: {
        ...base.audit,
        preflightMode: 'block',
      },
      completion: {
        ...base.completion,
        verifyCommand: 'false',
      },
    });

    await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'paused');
    const pausedPayload = await paused;

    const live = coordinator.getLoop(state.id);
    const paths = resolveLoopArtifactPaths(workspace, state.id);
    expect(invocations).toBe(0);
    expect(live?.preflight?.status).toBe('failed');
    expect(live?.endReason).toBe('preflight verification failed before implementation');
    expect(pausedPayload.signal).toMatchObject({
      id: 'BLOCKED',
      verdict: 'CRITICAL',
      message: 'preflight verification failed before implementation',
    });
    expect(existsSync(paths.preflight)).toBe(true);
    const preflightReport = readFileSync(paths.preflight, 'utf8');
    expect(preflightReport).toContain('- Mode: block');
    expect(preflightReport).toMatch(/^## verify$/m);
    expect(preflightReport).toContain('false');
  });

  maybe('smoke-tests preflight, plan packet artifacts, ledger gating, and clean audit completion in a temp repo', async () => {
    initGitRepo();
    let invocations = 0;
    let loopRunId = '';
    let terminalState: { lastIteration?: { completionSignalsFired?: unknown[] }; latestFinalAudit?: unknown } | undefined;
    const completed = waitForEvent<{ loopRunId: string }>('loop:completed');
    coordinator.on('loop:state-changed', (payload: unknown) => {
      const state = (payload as { state?: { status?: string } }).state;
      if (state?.status === 'completed') {
        terminalState = state as typeof terminalState;
      }
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        callback: (result: LoopChildResult) => void;
      };
      loopRunId = p.loopRunId;
      const paths = resolveLoopArtifactPaths(workspace, loopRunId);
      mkdirSync(join(workspace, 'src'), { recursive: true });
      mkdirSync(paths.phasesDir, { recursive: true });
      writeFileSync(paths.roadmap, roadmapMarkdown(), 'utf8');
      writeFileSync(join(paths.phasesDir, 'phase-1.md'), roadmapMarkdown(), 'utf8');
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n', 'utf8');
      invocations += 1;
      if (invocations === 1) {
        writeFileSync(join(workspace, 'src', 'deliverable.ts'), 'export const delivered = true;\n', 'utf8');
        writeFileSync(paths.tasks, '# Loop Tasks\n\n- [ ] Phase 1: deliver the smoke fixture\n', 'utf8');
        expect(readFileSync(paths.tasks, 'utf8')).toContain('- [ ] Phase 1');
        queueMicrotask(() => p.callback(smokeChildResult('iteration one', [{
          path: 'src/deliverable.ts',
          additions: 1,
          deletions: 0,
          contentHash: 'deliverable-v1',
        }])));
        return;
      }
      writeFileSync(paths.tasks, '# Loop Tasks\n\n- [x] Phase 1: deliver the smoke fixture\n', 'utf8');
      queueMicrotask(() => p.callback(smokeChildResult('iteration two', [])));
    });

    const base = defaultLoopConfig(workspace, 'ship smoke fixture');
    const state = await coordinator.startLoop('chat-audit-smoke', {
      initialPrompt: 'ship smoke fixture',
      workspaceCwd: workspace,
      initialStage: 'IMPLEMENT',
      caps: { ...base.caps, maxIterations: 5 },
      audit: {
        finalAuditMode: 'gate',
        preflightMode: 'record',
        planPacketMode: 'prompted',
        cleanlinessScan: true,
      },
      completion: {
        ...base.completion,
        mode: 'gated',
        verifyCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        runVerifyTwice: false,
        requireCompletedFileRename: false,
      },
    });

    const done = await completed;
    await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'completed' || !coordinator.getLoop(state.id));

    const paths = resolveLoopArtifactPaths(workspace, state.id);
    expect(done.loopRunId).toBe(state.id);
    expect(loopRunId).toBe(state.id);
    expect(invocations).toBeGreaterThanOrEqual(2);
    expect(terminalState?.lastIteration?.completionSignalsFired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ledger-complete', sufficient: true }),
      ]),
    );
    expect(terminalState?.latestFinalAudit).toMatchObject({ status: 'passed' });
    expect(existsSync(paths.repoBaseline)).toBe(true);
    expect(existsSync(paths.preflight)).toBe(true);
    expect(existsSync(paths.roadmap)).toBe(true);
    expect(existsSync(paths.audit)).toBe(true);
    expect(readFileSync(paths.audit, 'utf8')).toContain('- Status: passed');
  }, 30_000);
});

function initGitRepo(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

function git(...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function roadmapMarkdown(): string {
  return [
    '# Loop Roadmap',
    '',
    '## Phase 1: Smoke Fixture',
    '',
    'Acceptance Criteria:',
    '- [x] Phase 1: deliver the smoke fixture',
    '',
    'Required Commands:',
    `- ${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    '',
    'Evidence:',
    '- src/deliverable.ts:1',
    '',
  ].join('\n');
}

function smokeChildResult(
  output: string,
  filesChanged: LoopChildResult['filesChanged'],
): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged,
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

function waitForEvent<T>(event: string, timeoutMs = 20_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    coordinator.on(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitForCondition(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}
