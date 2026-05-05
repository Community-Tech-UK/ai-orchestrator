import { describe, expect, it, vi, afterEach } from 'vitest';
import type {
  OperatorProjectRecord,
  OperatorRunNodeRecord,
  OperatorRunRecord,
} from '../../shared/types/operator.types';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';
import type { OperatorVerificationPlan } from './operator-verification-planner';
import {
  OperatorVerificationExecutor,
  type OperatorVerificationCommandResult,
  type OperatorVerificationCommandRunner,
} from './operator-verification-executor';

describe('OperatorVerificationExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records passed required checks and persists audit events', async () => {
    const context = createContext();
    const runner = commandRunner([
      { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, error: null },
    ]);
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: runner,
      now: steppedNow(100, 135),
    });

    const summary = await executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: verificationPlan('/work/app', [
        { label: 'typecheck', command: 'npm', args: ['run', 'typecheck'], required: true, timeoutMs: 5000 },
      ]),
    });

    expect(summary).toMatchObject({
      status: 'passed',
      projectPath: '/work/app',
      kinds: ['node', 'typescript'],
      requiredFailed: 0,
      optionalFailed: 0,
    });
    expect(summary.checks[0]).toMatchObject({
      label: 'typecheck',
      command: 'npm',
      args: ['run', 'typecheck'],
      cwd: '/work/app',
      required: true,
      status: 'passed',
      exitCode: 0,
      durationMs: 35,
      stdoutBytes: 3,
      stderrBytes: 0,
      stdoutExcerpt: 'ok\n',
      stderrExcerpt: '',
      error: null,
    });
    expect(runner.run).toHaveBeenCalledWith('npm', ['run', 'typecheck'], {
      cwd: '/work/app',
      timeoutMs: 5000,
      maxBufferBytes: 1024 * 1024,
    });
    const graph = context.runStore.getRunGraph(context.run.id)!;
    expect(graph.events).toContainEqual(expect.objectContaining({
      kind: 'shell-command',
      nodeId: context.node.id,
      payload: expect.objectContaining({
        cmd: 'npm',
        args: ['run', 'typecheck'],
        cwd: '/work/app',
        exitCode: 0,
        durationMs: 35,
        stdoutBytes: 3,
        stderrBytes: 0,
      }),
    }));
    expect(graph.events).toContainEqual(expect.objectContaining({
      kind: 'verification-result',
      nodeId: context.node.id,
      payload: expect.objectContaining({
        status: 'passed',
        requiredFailed: 0,
        optionalFailed: 0,
      }),
    }));
  });

  it('keeps optional check failures visible without failing the summary', async () => {
    const context = createContext();
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: commandRunner([
        { exitCode: 1, stdout: '', stderr: 'lint failed', timedOut: false, error: 'Command failed' },
      ]),
      now: steppedNow(1, 11),
    });

    const summary = await executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: verificationPlan('/work/app', [
        { label: 'lint', command: 'npm', args: ['run', 'lint'], required: false, timeoutMs: 5000 },
      ]),
    });

    expect(summary).toMatchObject({
      status: 'passed',
      requiredFailed: 0,
      optionalFailed: 1,
    });
    expect(summary.checks[0]).toMatchObject({
      status: 'failed',
      required: false,
      exitCode: 1,
      stderrExcerpt: 'lint failed',
      error: 'Command failed',
    });
  });

  it('fails the summary when a required check fails', async () => {
    const context = createContext();
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: commandRunner([
        { exitCode: 2, stdout: 'build output', stderr: 'type error', timedOut: false, error: 'Command failed' },
      ]),
    });

    const summary = await executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: verificationPlan('/work/app', [
        { label: 'typecheck', command: 'npx', args: ['tsc', '--noEmit'], required: true, timeoutMs: 5000 },
      ]),
    });

    expect(summary).toMatchObject({
      status: 'failed',
      requiredFailed: 1,
      optionalFailed: 0,
    });
    expect(summary.checks[0]).toMatchObject({
      status: 'failed',
      exitCode: 2,
      timedOut: false,
      error: 'Command failed',
    });
  });

  it('maps command timeouts to failed checks with timeout evidence', async () => {
    const context = createContext();
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: commandRunner([
        {
          exitCode: null,
          stdout: 'partial',
          stderr: '',
          timedOut: true,
          error: 'Process timed out after 5000ms',
        },
      ]),
    });

    const summary = await executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: verificationPlan('/work/app', [
        { label: 'test', command: 'npm', args: ['test'], required: true, timeoutMs: 5000 },
      ]),
    });

    expect(summary).toMatchObject({
      status: 'failed',
      requiredFailed: 1,
    });
    expect(summary.checks[0]).toMatchObject({
      status: 'failed',
      exitCode: null,
      timedOut: true,
      error: 'Process timed out after 5000ms',
    });
  });

  it('creates skipped verification summaries when the planner finds no checks', async () => {
    const context = createContext();
    const runner = commandRunner([]);
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: runner,
    });

    const summary = await executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: {
        projectPath: '/work/app',
        kinds: ['unknown'],
        checks: [],
        fallbackReason: 'No recognized project manifest found',
      },
    });

    expect(summary).toEqual({
      status: 'skipped',
      projectPath: '/work/app',
      kinds: ['unknown'],
      requiredFailed: 0,
      optionalFailed: 0,
      checks: [],
      fallbackReason: 'No recognized project manifest found',
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(context.runStore.getRunGraph(context.run.id)?.events).toContainEqual(expect.objectContaining({
      kind: 'verification-result',
      payload: expect.objectContaining({
        status: 'skipped',
        fallbackReason: 'No recognized project manifest found',
      }),
    }));
  });

  it('emits heartbeat progress while a command remains active', async () => {
    vi.useFakeTimers();
    const context = createContext();
    const deferred = defer<OperatorVerificationCommandResult>();
    const runner: OperatorVerificationCommandRunner = {
      run: vi.fn(() => deferred.promise),
    };
    const executor = new OperatorVerificationExecutor({
      runStore: context.runStore,
      commandRunner: runner,
      heartbeatIntervalMs: 50,
    });

    const executePromise = executor.execute({
      run: context.run,
      node: context.node,
      project: context.project,
      plan: verificationPlan('/work/app', [
        { label: 'test', command: 'npm', args: ['test'], required: true, timeoutMs: 5000 },
      ]),
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(51);

    const progressMessages = context.runStore.getRunGraph(context.run.id)!.events
      .filter((event) => event.kind === 'progress')
      .map((event) => String(event.payload['message'] ?? ''));
    expect(progressMessages).toContain('Verification command still running: test');

    deferred.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, error: null });
    await executePromise;
  });
});

function createContext(): {
  runStore: OperatorRunStore;
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  project: OperatorProjectRecord;
} {
  const db = defaultDriverFactory(':memory:');
  createOperatorTables(db);
  const runStore = new OperatorRunStore(db);
  const run = runStore.createRun({
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    title: 'Verify project',
    goal: 'Implement a feature',
  });
  const node = runStore.createNode({
    runId: run.id,
    type: 'verification',
    title: 'Verify AI Orchestrator',
    targetProjectId: 'project-1',
    targetPath: '/work/app',
  });
  return {
    runStore,
    run,
    node,
    project: {
      id: 'project-1',
      canonicalPath: '/work/app',
      displayName: 'AI Orchestrator',
      aliases: ['AI Orchestrator'],
      source: 'scan',
      gitRoot: '/work/app',
      remotes: [],
      currentBranch: 'main',
      isPinned: false,
      lastSeenAt: 1,
      lastAccessedAt: 1,
      metadata: {},
    },
  };
}

function verificationPlan(
  projectPath: string,
  checks: OperatorVerificationPlan['checks'],
): OperatorVerificationPlan {
  return {
    projectPath,
    kinds: ['node', 'typescript'],
    checks,
  };
}

function commandRunner(results: OperatorVerificationCommandResult[]): OperatorVerificationCommandRunner & {
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => {
      const result = results.shift();
      if (!result) {
        throw new Error('Unexpected command execution');
      }
      return result;
    }),
  };
}

function steppedNow(...values: number[]): () => number {
  return () => values.shift() ?? values.at(-1) ?? 0;
}

function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
