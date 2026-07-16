/**
 * Regression tests for the Loop Mode invoker plumbing in default-invokers.ts.
 *
 * These specifically cover the recent fixes flagged by cross-model review:
 * - workspaceCwd flows through to the spawn options as `workingDirectory`
 *   (not process.cwd())
 * - iterationTimeoutMs override flows through to the spawn options as `timeout`
 * - streamIdleTimeoutMs override calls the adapter's setStreamIdleTimeoutMs
 * - stream:idle event is advisory and does not abort a valid long iteration
 * - loop child invocations run in YOLO mode because hidden child processes
 *   cannot surface permission prompts
 */

import { EventEmitter } from 'events';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopChildResult } from './loop-coordinator';

// `vi.hoisted` must not reference any imports — it runs before module
// imports resolve. Mock-state is created here and the EventEmitter for the
// loop coordinator is constructed inside beforeEach instead.
const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendRaw: vi.fn(),
  terminate: vi.fn(),
  setStreamIdleTimeoutMs: vi.fn(),
  setDisallowedToolsOverride: vi.fn(),
  setResume: vi.fn(),
  createAdapter: vi.fn(),
  createAutomationWithScheduling: vi.fn(),
  deleteAutomation: vi.fn(),
  resolveCliType: vi.fn(),
  getBreaker: vi.fn(),
  setProviderLimitLedger: vi.fn(),
  providerLimitSchedulerRef: { current: null as unknown as ((request: {
    loopRunId: string;
    chatId: string;
    workspaceCwd: string;
    provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
    resumeAt: number;
    reason: string;
    source: 'quota' | 'notice' | 'wakeup';
    action: string;
    windowId?: string;
  }) => (() => void) | void) | null },
  maybeExternalizeLoopOutput: vi.fn(),
  loopCoordinatorRef: { current: null as unknown as EventEmitter },
  adapterRef: { current: null as unknown as EventEmitter & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendRaw: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    setStreamIdleTimeoutMs: ReturnType<typeof vi.fn>;
    setDisallowedToolsOverride: ReturnType<typeof vi.fn>;
    setResume: ReturnType<typeof vi.fn>;
  } },
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('./loop-coordinator', () => ({
  getLoopCoordinator: vi.fn(() => hoisted.loopCoordinatorRef.current),
}));

vi.mock('./multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('../agents/review-coordinator', () => ({ getReviewCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('./debate-coordinator', () => ({ getDebateCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('../workflows/workflow-manager', () => ({
  getWorkflowManager: vi.fn(() => Object.assign(new EventEmitter(), {
    getExecutionByInstance: vi.fn(() => undefined),
  })),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(),
  resolveCliType: hoisted.resolveCliType,
}));

vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: hoisted.createAdapter })),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: (key: string) => (key === 'rtkEnabled' ? true : key === 'rtkBundledOnly' ? false : undefined),
    getAll: () => ({ defaultCli: 'claude' }),
  })),
}));

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: vi.fn(() => ({ getBreaker: hoisted.getBreaker })),
}));

vi.mock('../core/failover-error', () => ({ coerceToFailoverError: vi.fn(() => null) }));
vi.mock('../../shared/types/provider.types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/types/provider.types')>()),
  getDefaultModelForCli: vi.fn(() => 'default-model'),
}));
vi.mock('./loop-output-externalize', () => ({
  maybeExternalizeLoopOutput: hoisted.maybeExternalizeLoopOutput,
}));
vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: hoisted.createAutomationWithScheduling,
}));
vi.mock('../automations', () => ({
  getAutomationStore: vi.fn(() => ({ delete: hoisted.deleteAutomation })),
}));

import { registerDefaultLoopInvoker, buildLoopBranchSelectorDeps } from './default-invokers';
import type { BranchSelectInput } from './loop-branch-select';

describe('LF-5 branch-select deps', () => {
  function input(over: Partial<BranchSelectInput> = {}): BranchSelectInput {
    return {
      loopRunId: 'loop-1', workspaceCwd: '/ws', goal: 'g',
      exploration: { enabled: true, fanout: 3, crossModel: false, selector: 'verify+listwise' },
      caps: { maxIterations: 50, maxWallTimeMs: 1, maxTokens: 1_000_000, maxCostCents: 1000, maxToolCallsPerIteration: 200 },
      spentTokens: 0, spentCents: 0, prompt: 'p', provider: 'claude',
      verifyCommand: '', verifyTimeoutMs: 1000, iterationTimeoutMs: 1000, ...over,
    };
  }

  it('exposes fanout/adopt/cleanup/listwiseScore', () => {
    const deps = buildLoopBranchSelectorDeps({} as never);
    expect(typeof deps.fanout).toBe('function');
    expect(typeof deps.adopt).toBe('function');
    expect(typeof deps.cleanup).toBe('function');
    expect(typeof deps.listwiseScore).toBe('function');
  });

  it('fanout short-circuits to [] when there is no verify command (cannot rank)', async () => {
    const deps = buildLoopBranchSelectorDeps({} as never);
    await expect(deps.fanout(input({ verifyCommand: '' }))).resolves.toEqual([]);
  });
});

describe('Loop Mode invoker plumbing', () => {
  beforeEach(() => {
    // Fresh emitter per test; registerDefaultLoopInvoker bails if a listener
    // already exists, so we must reset both the coordinator mock and the
    // listener registry. The fake also implements `registerIterationHook`
    // (used by the #20 safety advisor) to match the real coordinator contract.
    hoisted.loopCoordinatorRef.current = Object.assign(new EventEmitter(), {
      registerIterationHook: vi.fn(() => () => undefined),
      setProviderLimitLedger: hoisted.setProviderLimitLedger,
      setProviderLimitResumeScheduler: vi.fn((fn) => {
        hoisted.providerLimitSchedulerRef.current = fn;
      }),
      resumeLoop: vi.fn(() => true),
    });
    hoisted.sendMessage.mockReset();
    hoisted.sendRaw.mockReset().mockResolvedValue(undefined);
    hoisted.terminate.mockReset().mockResolvedValue(undefined);
    hoisted.setStreamIdleTimeoutMs.mockReset();
    hoisted.setDisallowedToolsOverride.mockReset();
    hoisted.setResume.mockReset();
    hoisted.createAdapter.mockReset();
    hoisted.createAutomationWithScheduling.mockReset().mockResolvedValue({ id: 'automation-1' });
    hoisted.deleteAutomation.mockReset().mockResolvedValue({ runningInstanceIds: [] });
    hoisted.maybeExternalizeLoopOutput.mockReset().mockImplementation(async (output: string) => output);
    hoisted.providerLimitSchedulerRef.current = null;
    hoisted.resolveCliType.mockReset().mockResolvedValue('claude');
    hoisted.getBreaker.mockImplementation(() => ({
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    }));
    hoisted.setProviderLimitLedger.mockReset();
    // Build a fresh adapter object that's also an EventEmitter so we can
    // simulate stream:idle events.
    const adapterEmitter = new EventEmitter() as unknown as EventEmitter & {
      sendMessage: typeof hoisted.sendMessage;
      sendRaw: typeof hoisted.sendRaw;
      terminate: typeof hoisted.terminate;
      setStreamIdleTimeoutMs: typeof hoisted.setStreamIdleTimeoutMs;
      setDisallowedToolsOverride: typeof hoisted.setDisallowedToolsOverride;
      setResume: typeof hoisted.setResume;
    };
    adapterEmitter.sendMessage = hoisted.sendMessage;
    adapterEmitter.sendRaw = hoisted.sendRaw;
    adapterEmitter.terminate = hoisted.terminate;
    adapterEmitter.setStreamIdleTimeoutMs = hoisted.setStreamIdleTimeoutMs;
    adapterEmitter.setDisallowedToolsOverride = hoisted.setDisallowedToolsOverride;
    adapterEmitter.setResume = hoisted.setResume;
    hoisted.adapterRef.current = adapterEmitter;
    hoisted.createAdapter.mockReturnValue(adapterEmitter);
  });

  function emitIteration(extras: Record<string, unknown> = {}): Promise<LoopChildResult | { error: string }> {
    return new Promise((resolve) => {
      hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
        correlationId: 'loop-1::0',
        loopRunId: 'loop-1',
        chatId: 'chat-1',
        provider: 'claude',
        workspaceCwd: '/tmp/loop-workspace',
        stage: 'PLAN',
        seq: 0,
        idempotencyKey: 'loop-1:0:output',
        prompt: 'do the thing',
        callback: resolve,
        ...extras,
      });
    });
  }

  it('wires the durable provider-limit ledger into the loop coordinator', () => {
    registerDefaultLoopInvoker({} as never);

    expect(hoisted.setProviderLimitLedger).toHaveBeenCalledTimes(1);
    expect(hoisted.setProviderLimitLedger).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.any(Function),
      getActive: expect.any(Function),
    }));
  });

  it('forwards workspaceCwd to the adapter spawn options as workingDirectory', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 10 } });

    const result = emitIteration({ workspaceCwd: '/Users/test/project' });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
    const callArg = hoisted.createAdapter.mock.calls[0][0];
    expect(callArg.options.workingDirectory).toBe('/Users/test/project');
    // Sanity: it's NOT process.cwd() (which used to be the bug).
    expect(callArg.options.workingDirectory).not.toBe(process.cwd());
  });

  // P2 isolation acceptance: when executionCwd is set, the CLI must spawn
  // inside the per-session worktree, not in the repo root (workspaceCwd).
  it('when executionCwd is set, uses it as workingDirectory instead of workspaceCwd (P2 isolation)', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 10 } });

    const result = emitIteration({
      workspaceCwd: '/repo/root',
      executionCwd: '/repo/root/.worktrees/task-abc-1n5w3f',
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
    const callArg = hoisted.createAdapter.mock.calls[0][0];
    // executionCwd takes precedence: agent spawns in the worktree, not the repo root
    expect(callArg.options.workingDirectory).toBe('/repo/root/.worktrees/task-abc-1n5w3f');
    expect(callArg.options.workingDirectory).not.toBe('/repo/root');
  });

  // P2 isolation acceptance: the iteration's file-change delta must be computed
  // against executionCwd (the worktree), not workspaceCwd (the repo root). If a
  // regression snapshotted the root instead, an agent that edits only the
  // worktree would report ZERO changes — corrupting no-progress detection and
  // reviewer context. This drives the real invoker with real temp dirs and a
  // mock "agent" that writes into the worktree.
  it('computes filesChanged from executionCwd (the worktree), not the repo root (P2 isolation)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-root-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-wt-'));
    try {
      registerDefaultLoopInvoker({} as never);
      // The "agent" runs during sendMessage: it writes a NEW file into the
      // worktree (and a decoy into the repo root, which must be ignored).
      hoisted.sendMessage.mockImplementation(async () => {
        fs.writeFileSync(path.join(worktree, 'feature.ts'), 'export const added = true;\n');
        fs.writeFileSync(path.join(repoRoot, 'root-decoy.ts'), 'should not be counted\n');
        return { content: 'ok', usage: { totalTokens: 10 } };
      });

      const result = await emitIteration({
        workspaceCwd: repoRoot,
        executionCwd: worktree,
      });

      const changedPaths = (result as LoopChildResult).filesChanged.map((c) => c.path);
      // The worktree edit is detected...
      expect(changedPaths).toContain('feature.ts');
      // ...and the repo-root decoy is NOT (the root was never snapshotted).
      expect(changedPaths).not.toContain('root-decoy.ts');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('WS5: a FAILED attempt still reports its observed workspace delta (writes-observed evidence)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-ws5-'));
    try {
      registerDefaultLoopInvoker({} as never);
      // The "agent" writes a file, THEN the invocation blows up — the error
      // path must still observe the write and refuse to call it clean.
      hoisted.sendMessage.mockImplementation(async () => {
        fs.writeFileSync(path.join(repoRoot, 'half-written.ts'), 'export const partial = true;\n');
        throw new Error('stream cut mid-write');
      });

      const callbackResult = await emitIteration({ workspaceCwd: repoRoot });

      const failure = callbackResult as { error: string; attemptEvidence?: {
        outcome: string; workspaceEffect: string; filesChanged: { path: string }[];
      } };
      expect(failure.error).toContain('stream cut mid-write');
      expect(failure.attemptEvidence?.outcome).toBe('failed');
      expect(failure.attemptEvidence?.workspaceEffect).toBe('writes-observed');
      expect(failure.attemptEvidence?.filesChanged.map((c) => c.path)).toContain('half-written.ts');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('WS5: a failed attempt with NO writes reports none-observed evidence (safe to replay)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-ws5-clean-'));
    try {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockRejectedValue(new Error('transient RPC failure'));

      const callbackResult = await emitIteration({ workspaceCwd: repoRoot });

      const failure = callbackResult as { error: string; attemptEvidence?: { workspaceEffect: string } };
      expect(failure.attemptEvidence?.workspaceEffect).toBe('none-observed');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('resolves and creates loop child adapters for non-Claude chat providers', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.resolveCliType.mockResolvedValueOnce('gemini');
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 10 } });

    const result = emitIteration({
      provider: 'gemini',
      config: { contextStrategy: 'fresh-child' },
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.resolveCliType).toHaveBeenCalledWith('gemini', 'claude');
    const callArg = hoisted.createAdapter.mock.calls[0][0];
    expect(callArg.cliType).toBe('gemini');
  });

  it('forwards iterationTimeoutMs to the adapter spawn options as timeout', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration({ iterationTimeoutMs: 7 * 60 * 1000 });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    const callArg = hoisted.createAdapter.mock.calls[0][0];
    expect(callArg.options.timeout).toBe(7 * 60 * 1000);
  });

  it('propagates provider-reported usage cost to the loop child result', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({
      content: 'ok',
      usage: { totalTokens: 1_000_000, cost: 0.42 },
    });

    const callbackResult = await emitIteration({});

    expect(callbackResult).toMatchObject({
      output: 'ok',
      tokens: 1_000_000,
      costUsd: 0.42,
    });
  });

  it('surfaces structured provider error metadata on loop invocation failures', async () => {
    registerDefaultLoopInvoker({} as never);
    const providerError = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: {
        'retry-after': '120',
        authorization: 'Bearer should-not-cross-the-loop-boundary',
      },
      body: { error: { message: 'quota exhausted; retry later', access_token: 'visible-by-key-only' } },
    });
    hoisted.sendMessage.mockRejectedValue(providerError);

    const callbackResult = await emitIteration({});

    expect(callbackResult).toMatchObject({
      error: 'Too many requests',
      status: 429,
      provider: 'claude',
      headers: { 'retry-after': '120' },
      body: { error: { message: 'quota exhausted; retry later', access_token: '[REDACTED]' } },
    });
    expect((callbackResult as { headers?: Record<string, string> }).headers?.['authorization']).toBeUndefined();
  });

  it('enables delegated large-output retrieval hints when branch exploration is enabled', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({
      content: 'big loop output',
      usage: { totalTokens: 1 },
    });

    await emitIteration({
      config: {
        contextStrategy: 'fresh-child',
        context: { compaction: { enabled: true, resetAtUtilization: 0.6, clearToolResults: true } },
        exploration: { enabled: true, fanout: 3, crossModel: false, selector: 'verify+listwise' },
      },
    });

    expect(hoisted.maybeExternalizeLoopOutput).toHaveBeenCalledWith(
      'big loop output',
      true,
      {
        delegateInspectionHint: true,
        captureContext: expect.objectContaining({
          provider: 'claude',
          turnRef: 'loop:loop-1:iteration:0',
          logicalCallId: 'loop-1:0:output',
        }),
      },
    );
  });

  it('leaves delegated large-output retrieval hints disabled when branch exploration is disabled', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({
      content: 'ordinary loop output',
      usage: { totalTokens: 1 },
    });

    await emitIteration({
      config: {
        contextStrategy: 'fresh-child',
        context: { compaction: { enabled: true, resetAtUtilization: 0.6, clearToolResults: true } },
        exploration: { enabled: false, fanout: 3, crossModel: false, selector: 'verify+listwise' },
      },
    });

    expect(hoisted.maybeExternalizeLoopOutput).toHaveBeenCalledWith(
      'ordinary loop output',
      true,
      {
        captureContext: expect.objectContaining({
          provider: 'claude',
          turnRef: 'loop:loop-1:iteration:0',
          logicalCallId: 'loop-1:0:output',
        }),
      },
    );
  });

  it('marks loop sendMessage calls as activity-aware timeout eligible', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration({});
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('do the thing'),
        metadata: {
          allowPartialOnTimeout: true,
          continueWhileActiveOnTimeout: true,
          activeTimeoutMs: 300_000,
        },
      }),
    );
  });

  it('runs loop child adapters in YOLO mode without hidden permission hooks', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration({});
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    const callArg = hoisted.createAdapter.mock.calls[0][0];
    expect(callArg.options.yoloMode).toBe(true);
    expect(callArg.options.permissionHookPath).toBeUndefined();
    expect(callArg.options.rtk).toBeUndefined();
  });

  it('registers a provider-limit resume scheduler that creates a one-time automation', async () => {
    registerDefaultLoopInvoker({} as never);
    expect(hoisted.providerLimitSchedulerRef.current).toBeTypeOf('function');

    const cancel = hoisted.providerLimitSchedulerRef.current!({
      loopRunId: 'loop-quota',
      chatId: 'chat-quota',
      workspaceCwd: '/tmp/ws',
      provider: 'claude',
      resumeAt: Date.now() + 60_000,
      reason: '5-hour session at 95%',
      source: 'quota',
      action: 'throttle',
      windowId: 'claude.5h',
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(hoisted.createAutomationWithScheduling).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Resume loop after claude quota reset',
      schedule: expect.objectContaining({ type: 'oneTime' }),
      destination: expect.objectContaining({ kind: 'thread', instanceId: 'chat-quota' }),
      action: expect.objectContaining({
        workingDirectory: '/tmp/ws',
        provider: 'claude',
        systemAction: {
          type: 'loopProviderLimitResume',
          loopRunId: 'loop-quota',
        },
        prompt: expect.stringContaining('loop-quota'),
      }),
    }));
    cancel?.();
  });

  it('preserves concrete non-Claude providers in provider-limit resume automations', async () => {
    registerDefaultLoopInvoker({} as never);
    expect(hoisted.providerLimitSchedulerRef.current).toBeTypeOf('function');

    const cancel = hoisted.providerLimitSchedulerRef.current!({
      loopRunId: 'loop-gemini-quota',
      chatId: 'chat-gemini',
      workspaceCwd: '/tmp/ws',
      provider: 'gemini',
      resumeAt: Date.now() + 60_000,
      reason: 'daily window exhausted',
      source: 'quota',
      action: 'throttle',
      windowId: 'gemini.daily',
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(hoisted.createAutomationWithScheduling).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Resume loop after gemini quota reset',
      action: expect.objectContaining({
        workingDirectory: '/tmp/ws',
        provider: 'gemini',
      }),
    }));
    cancel?.();
  });

  it('falls back to a generous 30-minute default when iterationTimeoutMs is unset', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration({});
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    const callArg = hoisted.createAdapter.mock.calls[0][0];
    expect(callArg.options.timeout).toBe(30 * 60 * 1000);
  });

  it('applies streamIdleTimeoutMs to the adapter via setStreamIdleTimeoutMs', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration({ streamIdleTimeoutMs: 240_000 });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.setStreamIdleTimeoutMs).toHaveBeenCalledWith(240_000);
  });

  it('E2 (#12): widens the stream-idle threshold for a tool call with a declared timeout, then reverts', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockImplementation(async () => {
      // A 20-minute declared Bash build timeout, well past the 240s base.
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'build-1',
        name: 'Bash',
        arguments: { command: 'make', timeout: 20 * 60 * 1000 },
      });
      hoisted.adapterRef.current.emit('tool_result', {
        id: 'build-1',
        name: 'Bash',
        arguments: { command: 'make', timeout: 20 * 60 * 1000 },
        result: 'build ok',
      });
      return { content: 'ok', usage: { totalTokens: 1 } };
    });

    const result = emitIteration({ streamIdleTimeoutMs: 240_000 });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    const calls = hoisted.setStreamIdleTimeoutMs.mock.calls.map((call) => call[0]);
    // Initial apply from the streamIdleTimeoutMs override, then widen to
    // declared+grace when the build tool_use fires, then revert to the base
    // 240s once its tool_result arrives.
    expect(calls).toContain(20 * 60 * 1000 + 30_000);
    expect(calls[calls.length - 1]).toBe(240_000);
  });

  it('E2 (#12): does not widen the stream-idle threshold when no tool declares a timeout', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'bash-1',
        name: 'Bash',
        arguments: { command: 'npm test' },
      });
      hoisted.adapterRef.current.emit('tool_result', {
        id: 'bash-1',
        name: 'Bash',
        arguments: { command: 'npm test' },
        result: 'ok',
      });
      return { content: 'ok', usage: { totalTokens: 1 } };
    });

    const result = emitIteration({ streamIdleTimeoutMs: 240_000 });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    // No tool declared a timeout, so the watchdog seam never fires: every
    // call to setStreamIdleTimeoutMs (there may be more than one from
    // unrelated same-session adapter-creation plumbing) uses the configured
    // base — undeclared timeout means byte-identical behavior to before.
    const calls = hoisted.setStreamIdleTimeoutMs.mock.calls.map((call) => call[0]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((value) => value === 240_000)).toBe(true);
  });

  it('D2 (#6): disableTools applies the tools-disable override before the send and clears it after', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockImplementation(async () => {
      // The override must already be active while the CLI turn runs.
      const calls = hoisted.setDisallowedToolsOverride.mock.calls;
      expect(calls.length).toBe(1);
      expect(Array.isArray(calls[0][0])).toBe(true);
      expect(calls[0][0].length).toBeGreaterThan(0);
      expect(calls[0][0]).toContain('Bash');
      return { content: 'wrap-up summary', usage: { totalTokens: 1 } };
    });

    const result = emitIteration({ disableTools: true });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    // Restored after the send so a reused/borrowed adapter regains its tools.
    const calls = hoisted.setDisallowedToolsOverride.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toBeNull();
  });

  it('D2 (#6): ordinary iterations never touch the tools-disable override', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

    const result = emitIteration();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.setDisallowedToolsOverride).not.toHaveBeenCalled();
  });

  it('does not abort the iteration when adapter emits stream:idle before the CLI finishes', async () => {
    registerDefaultLoopInvoker({} as never);
    let resolveSend!: (value: { content: string; usage: { totalTokens: number } }) => void;
    hoisted.sendMessage.mockImplementation(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const finished = emitIteration({ config: { contextStrategy: 'fresh-child' } });

    // Wait long enough for the listener to wire up the once('stream:idle', ...).
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    hoisted.adapterRef.current.emit('stream:idle', { adapter: 'claude', timeoutMs: 90_000, pid: 1234 });

    let settled = false;
    void finished.then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);

    resolveSend({ content: 'ok after quiet thinking', usage: { totalTokens: 7 } });
    const callbackResult = await finished;
    expect(callbackResult).toMatchObject({
      output: 'ok after quiet thinking',
      tokens: 7,
      exitedCleanly: true,
    });
    expect(hoisted.terminate).toHaveBeenCalled();
  });

  it('emits live loop activity from child adapter output while an iteration is running', async () => {
    registerDefaultLoopInvoker({} as never);
    const activities: { kind: string; message: string; loopRunId: string; seq: number }[] = [];
    hoisted.loopCoordinatorRef.current.on('loop:activity', (activity) => {
      activities.push(activity as { kind: string; message: string; loopRunId: string; seq: number });
    });
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('output', {
        type: 'tool_use',
        content: 'Using tool: Read',
        metadata: { name: 'Read' },
      });
      hoisted.adapterRef.current.emit('output', {
        type: 'assistant',
        content: 'I am reading the project files before changing code.',
      });
      return { content: 'ok', usage: { totalTokens: 3 } };
    });

    const result = emitIteration({ workspaceCwd: '/Users/test/Minecraft' });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loopRunId: 'loop-1',
          seq: 0,
          kind: 'tool_use',
          message: 'Using tool: Read',
        }),
        expect.objectContaining({
          loopRunId: 'loop-1',
          seq: 0,
          kind: 'assistant',
          message: 'I am reading the project files before changing code.',
        }),
      ]),
    );
  });

  it('captures loop child finish reason, unresolved tool calls, result hashes, and read files from live adapter events', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'read-1',
        name: 'Read',
        arguments: { file_path: 'src/input.ts' },
      });
      hoisted.adapterRef.current.emit('tool_result', {
        id: 'read-1',
        name: 'Read',
        arguments: { file_path: 'src/input.ts' },
        result: 'export const input = true;\n',
      });
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'bash-1',
        name: 'Bash',
        arguments: { command: 'npm test', timeout: 600_000 },
      });
      return {
        content: 'stopped after asking for another tool',
        usage: { totalTokens: 5 },
        metadata: { stopReason: 'tool_use' },
      };
    });

    const callbackResult = await emitIteration({ workspaceCwd: '/Users/test/project' });

    expect(callbackResult).toMatchObject({
      finishReason: 'tool_use',
      unresolvedToolCalls: true,
      filesRead: ['src/input.ts'],
    });
    const result = callbackResult as LoopChildResult;
    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'Read',
          success: true,
          resultHash: expect.any(String),
        }),
        expect.objectContaining({
          toolName: 'Bash',
          success: true,
          // E2 (#12) capture half: agent-declared timeout persisted on the record.
          declaredTimeoutMs: 600_000,
        }),
      ]),
    );
    expect(result.toolCalls.find((call) => call.toolName === 'Bash')).not.toHaveProperty('resultHash');
  });

  it('records Phase 4 tool rw-lock conflicts from overlapping live write tool events', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'edit-1',
        name: 'Edit',
        arguments: { file_path: 'src' },
      });
      hoisted.adapterRef.current.emit('tool_use', {
        id: 'write-1',
        name: 'Write',
        arguments: { file_path: 'src/app.ts' },
      });
      return { content: 'ok', usage: { totalTokens: 1 } };
    });

    const callbackResult = await emitIteration({
      workspaceCwd: '/Users/test/project',
      config: {
        contextStrategy: 'fresh-child',
        phase4: { toolRwLocks: { enabled: true } },
      },
    });

    expect((callbackResult as LoopChildResult).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 'tool-rw-lock-conflict',
          excerpt: expect.stringContaining('Overlapping write tools'),
        }),
      ]),
    );
    expect((callbackResult as LoopChildResult).exitedCleanly).toBe(false);
    expect((callbackResult as LoopChildResult).output).toContain('Safety violation');
  });

  it('captures file changes from non-git loop workspaces', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-invoker-'));
    try {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockImplementation(async () => {
        fs.writeFileSync(path.join(workspace, 'notes.txt'), 'created during loop iteration\n');
        return { content: 'ok', usage: { totalTokens: 1 } };
      });

      const callbackResult = await emitIteration({ workspaceCwd: workspace });

      expect(callbackResult).not.toHaveProperty('error');
      expect((callbackResult as LoopChildResult).filesChanged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'notes.txt',
            contentHash: expect.any(String),
          }),
        ]),
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not report pre-existing git dirt as files changed by an idle iteration', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-invoker-dirty-'));
    const git = (...args: string[]) =>
      fs.existsSync(workspace)
        ? spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
        : { status: 1 };
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(workspace, 'existing.txt'), 'committed\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(workspace, 'existing.txt'), 'dirty before loop\n');

      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'no file work this turn', usage: { totalTokens: 1 } });

      const callbackResult = await emitIteration({ workspaceCwd: workspace });

      expect(callbackResult).not.toHaveProperty('error');
      expect((callbackResult as LoopChildResult).filesChanged).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('surfaces hidden input_required prompts and auto-answers ordinary loop questions', async () => {
    registerDefaultLoopInvoker({} as never);
    const activities: { kind: string; message: string; loopRunId: string; seq: number }[] = [];
    hoisted.loopCoordinatorRef.current.on('loop:activity', (activity) => {
      activities.push(activity as { kind: string; message: string; loopRunId: string; seq: number });
    });
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('input_required', {
        id: 'ask-1',
        prompt: 'Which enemy should be implemented next?',
        metadata: { type: 'ask_user_question' },
      });
      return { content: 'ok', usage: { totalTokens: 3 } };
    });

    const result = emitIteration({ workspaceCwd: '/Users/test/Minecraft' });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'input_required',
          message: expect.stringContaining('Which enemy should be implemented next?'),
        }),
        expect.objectContaining({
          kind: 'status',
          message: 'Auto-answering hidden loop question with autonomous-mode guidance',
        }),
      ]),
    );
    expect(hoisted.sendRaw).toHaveBeenCalledWith(
      expect.stringContaining('Loop Mode is unattended'),
    );
  });

  it('does not auto-answer hidden permission prompts', async () => {
    registerDefaultLoopInvoker({} as never);
    const activities: { kind: string; message: string }[] = [];
    hoisted.loopCoordinatorRef.current.on('loop:activity', (activity) => {
      activities.push(activity as { kind: string; message: string });
    });
    hoisted.sendMessage.mockImplementation(async () => {
      hoisted.adapterRef.current.emit('input_required', {
        id: 'perm-1',
        prompt: 'Permission required',
        metadata: { type: 'deferred_permission' },
      });
      return { content: 'ok', usage: { totalTokens: 3 } };
    });

    const result = emitIteration({});
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await result;

    expect(hoisted.sendRaw).not.toHaveBeenCalled();
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('cannot auto-answer'),
        }),
        expect.objectContaining({
          kind: 'status',
          message: expect.stringContaining('Terminating hidden loop child after input request'),
        }),
      ]),
    );
  });

  it('terminates hidden loop children when an ordinary question cannot be auto-answered', async () => {
    registerDefaultLoopInvoker({} as never);
    hoisted.sendRaw.mockRejectedValueOnce(new Error('stdin closed'));
    const activities: { kind: string; message: string }[] = [];
    hoisted.loopCoordinatorRef.current.on('loop:activity', (activity) => {
      activities.push(activity as { kind: string; message: string });
    });
    let resolveSend!: (value: { content: string; usage: { totalTokens: number } }) => void;
    hoisted.sendMessage.mockImplementation(() => {
      hoisted.adapterRef.current.emit('input_required', {
        id: 'ask-1',
        prompt: 'Which enemy should be implemented next?',
        metadata: { type: 'ask_user_question' },
      });
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    });

    const result = emitIteration({});
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Failed to auto-answer hidden loop question: stdin closed'),
        }),
        expect.objectContaining({
          kind: 'status',
          message: expect.stringContaining('Terminating hidden loop child after input request'),
        }),
      ]),
    );
    expect(hoisted.terminate).toHaveBeenCalledWith(false);

    resolveSend({ content: 'partial output after question', usage: { totalTokens: 2 } });
    await result;
  });

  it('terminates an in-flight fresh child when the loop enters a terminal state', async () => {
    registerDefaultLoopInvoker({} as never);
    let resolveSend!: (value: { content: string; usage: { totalTokens: number } }) => void;
    hoisted.sendMessage.mockImplementation(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const finished = emitIteration({ config: { contextStrategy: 'fresh-child' } });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    hoisted.loopCoordinatorRef.current.emit('loop:state-changed', {
      loopRunId: 'loop-1',
      state: { status: 'cancelled' },
    });
    await new Promise<void>((r) => setImmediate(r));

    expect(hoisted.terminate).toHaveBeenCalledWith(false);

    resolveSend({ content: 'late result after cancellation', usage: { totalTokens: 1 } });
    await finished;
  });

  it('does not terminate a child for resumable provider-limit state changes', async () => {
    registerDefaultLoopInvoker({} as never);
    let resolveSend!: (value: { content: string; usage: { totalTokens: number } }) => void;
    hoisted.sendMessage.mockImplementation(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const finished = emitIteration({ config: { contextStrategy: 'fresh-child' } });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    hoisted.loopCoordinatorRef.current.emit('loop:state-changed', {
      loopRunId: 'loop-1',
      state: { status: 'provider-limit', endedAt: null },
    });
    await new Promise<void>((r) => setImmediate(r));

    expect(hoisted.terminate).not.toHaveBeenCalled();

    hoisted.loopCoordinatorRef.current.emit('loop:state-changed', {
      loopRunId: 'loop-1',
      state: { status: 'provider-limit', endedAt: 1_778_310_600_000 },
    });
    await new Promise<void>((r) => setImmediate(r));

    expect(hoisted.terminate).toHaveBeenCalledWith(false);

    resolveSend({ content: 'late result after provider limit', usage: { totalTokens: 1 } });
    await finished;
  });

  describe('contextStrategy: same-session', () => {
    it('switches a borrowed parent Claude adapter into resume mode after the first same-session iteration', async () => {
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
        })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-borrowed::0',
          loopRunId: 'loop-borrowed',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      expect(hoisted.createAdapter).not.toHaveBeenCalled();
      expect(hoisted.terminate).not.toHaveBeenCalled();
      expect(hoisted.setResume).toHaveBeenCalledWith(true);
      hoisted.setResume.mockClear();

      const iter1 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-borrowed::1',
          loopRunId: 'loop-borrowed',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 1,
          prompt: 'iter 1',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      expect(hoisted.sendMessage).toHaveBeenCalledTimes(2);
      expect(hoisted.setResume).not.toHaveBeenCalledWith(false);
    });

    it('2026-07-11 park-fix Phase 5 regression: a same-session iteration on a borrowed live chat adapter never routes through InstanceManager.sendInput (which is what would double-park it alongside LoopProviderLimitHandler)', async () => {
      const sendInput = vi.fn();
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
        })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
        sendInput,
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-borrowed-guard::0',
          loopRunId: 'loop-borrowed-guard',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter;

      // The turn went through the adapter directly (bypassing
      // InstanceCommunicationManager and its onProviderLimitTurn hook)...
      expect(hoisted.sendMessage).toHaveBeenCalledTimes(1);
      // ...never through the regular-session send path that would let the
      // instance-level InstanceProviderLimitHandler park it too.
      expect(sendInput).not.toHaveBeenCalled();
    });

    it('D6: pauses the loop when the borrowed parent instance was interrupted mid-iteration', async () => {
      const pauseLoop = vi.fn(() => true);
      (hoisted.loopCoordinatorRef.current as unknown as { pauseLoop: typeof pauseLoop }).pauseLoop = pauseLoop;
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
          status: 'idle',
          lastTurnOutcome: 'interrupted',
        })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'partial', usage: { totalTokens: 5 } });

      const result = await new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-int::0',
          loopRunId: 'loop-int',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });

      expect(result).toEqual({ error: 'instance-interrupted' });
      expect(pauseLoop).toHaveBeenCalledWith('loop-int');
    });

    it('D6: does NOT pause when the borrowed parent finished normally', async () => {
      const pauseLoop = vi.fn(() => true);
      (hoisted.loopCoordinatorRef.current as unknown as { pauseLoop: typeof pauseLoop }).pauseLoop = pauseLoop;
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
          status: 'idle',
          lastTurnOutcome: 'completed',
        })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'done', usage: { totalTokens: 5 } });

      const result = await new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-ok::0',
          loopRunId: 'loop-ok',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });

      expect((result as { error?: string }).error).not.toBe('instance-interrupted');
      expect(pauseLoop).not.toHaveBeenCalled();
    });

    it('borrows the live Claude adapter even when loop control is active (control reaches it via the self-locating shim, not spawn env)', async () => {
      const instanceManager = {
        getInstance: vi.fn(() => ({ id: 'chat-live', provider: 'claude', workingDirectory: '/tmp/ws' })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-ctrl::0',
          loopRunId: 'loop-ctrl',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          loopControlEnv: {
            ORCHESTRATOR_LOOP_RUN_ID: 'loop-ctrl',
            ORCHESTRATOR_LOOP_CONTROL_FILE: '/tmp/ws/.aio-loop-control/loop-ctrl/control.json',
            ORCHESTRATOR_LOOP_CONTROL_SECRET: 'secret',
            ORCHESTRATOR_LOOP_CLI: '/tmp/ws/.aio-loop-control/loop-ctrl/aio-loop-control',
          },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter;

      // Borrowed: no loop-owned adapter created; the chat's adapter ran the turn.
      expect(hoisted.createAdapter).not.toHaveBeenCalled();
      expect(hoisted.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('B8: does not borrow a live Claude adapter when an explicit downshift model differs from the chat model', async () => {
      const parentSendMessage = vi.fn().mockResolvedValue({ content: 'wrong model', usage: { totalTokens: 1 } });
      const parentAdapter = Object.assign(new EventEmitter(), {
        sendMessage: parentSendMessage,
        terminate: vi.fn(),
        setStreamIdleTimeoutMs: vi.fn(),
        setResume: vi.fn(),
      });
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
          currentModel: 'claude-opus-current',
        })),
        getAdapter: vi.fn(() => parentAdapter),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'downshifted', usage: { totalTokens: 5 } });

      const iter = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-borrow-model-switch::0',
          loopRunId: 'loop-borrow-model-switch',
          chatId: 'chat-live',
          provider: 'claude',
          model: 'claude-sonnet-downshift',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter;

      expect(parentSendMessage).not.toHaveBeenCalled();
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      expect(hoisted.createAdapter.mock.calls[0][0].options.model).toBe('claude-sonnet-downshift');
    });

    it('does not borrow when the loop is worktree-isolated — creates a loop-owned adapter pinned to the worktree', async () => {
      const instanceManager = {
        getInstance: vi.fn(() => ({ id: 'chat-live', provider: 'claude', workingDirectory: '/tmp/ws' })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-iso::0',
          loopRunId: 'loop-iso',
          chatId: 'chat-live',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          executionCwd: '/tmp/ws-worktree',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter;

      // Isolated: borrowed chat adapter would run in the repo root, so a
      // loop-owned adapter is created and pinned to the worktree instead.
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      expect(hoisted.createAdapter.mock.calls[0][0].options.workingDirectory).toBe('/tmp/ws-worktree');
    });

    it('creates a loop-owned Codex adapter instead of borrowing the live Codex chat adapter', async () => {
      const parentSendMessage = vi.fn().mockResolvedValue({ content: 'wrong adapter', usage: { totalTokens: 1 } });
      const parentAdapter = Object.assign(new EventEmitter(), {
        sendMessage: parentSendMessage,
        terminate: vi.fn(),
        setStreamIdleTimeoutMs: vi.fn(),
        setResume: vi.fn(),
      });
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-codex',
          provider: 'codex',
          workingDirectory: '/tmp/ws',
        })),
        getAdapter: vi.fn(() => parentAdapter),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.resolveCliType.mockResolvedValue('codex');
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-codex::0',
          loopRunId: 'loop-codex',
          chatId: 'chat-codex',
          provider: 'codex',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      expect(instanceManager.getAdapter).toHaveBeenCalledWith('chat-codex');
      expect(parentSendMessage).not.toHaveBeenCalled();
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      expect(hoisted.createAdapter.mock.calls[0][0]).toMatchObject({
        cliType: 'codex',
        options: {
          workingDirectory: '/tmp/ws',
          yoloMode: true,
        },
      });
      expect(hoisted.sendMessage).toHaveBeenCalledTimes(1);
      expect(hoisted.terminate).not.toHaveBeenCalled();
    });

    it('reuses the same adapter across iterations and skips per-iteration termination', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      // Iteration 0 — adapter is created.
      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-2::0',
          loopRunId: 'loop-2',
          chatId: 'chat-2',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      // Iteration 1 — same loopRunId — adapter must be reused, not recreated.
      const iter1 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-2::1',
          loopRunId: 'loop-2',
          chatId: 'chat-2',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 1,
          prompt: 'iter 1',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      // Adapter should have been created only once across both iterations.
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      // sendMessage fires once per iteration.
      expect(hoisted.sendMessage).toHaveBeenCalledTimes(2);
      // Adapter is NOT torn down between iterations — it's reused.
      expect(hoisted.terminate).not.toHaveBeenCalled();
    });

    it('B6: uses calibrated context-window tokens before recycling a same-session adapter', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 150_000 } });

      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-context-calibration::0',
          loopRunId: 'loop-context-calibration',
          chatId: 'chat-context-calibration',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: {
            contextStrategy: 'same-session',
            context: { compaction: { enabled: true, resetAtUtilization: 0.6, clearToolResults: true } },
          },
          contextWindowTokens: 1_000_000,
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      const result = await iter0;

      expect((result as LoopChildResult).contextCompacted).toBeUndefined();
      expect(hoisted.terminate).not.toHaveBeenCalled();
    });

    const sameSessionContextConfig = {
      contextStrategy: 'same-session',
      context: { compaction: { enabled: true, resetAtUtilization: 0.6, clearToolResults: true } },
    };

    async function runSameSessionIteration(loopRunId: string, tokens: number): Promise<LoopChildResult | { error: string }> {
      const iteration = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: `${loopRunId}::0`,
          loopRunId,
          chatId: `chat-${loopRunId}`,
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 0,
          prompt: 'iter 0',
          config: sameSessionContextConfig,
          callback: resolve,
        });
      });
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: tokens } });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      return iteration;
    }

    it('WS4 REGRESSION: 7M aggregate tokens + a known 60k/200k observation (30%) must NOT recycle at 60%', async () => {
      registerDefaultLoopInvoker({} as never);
      (hoisted.adapterRef.current as unknown as { getLastContextUsage: () => unknown }).getLastContextUsage =
        () => ({ status: 'known', used: 60_000, total: 200_000, source: 'provider-turn' });

      const result = await runSameSessionIteration('loop-ws4-known-low', 7_000_000);

      // The old aggregate/synthetic-window fallback would have recycled at
      // "3500%"; truthful occupancy (30%) must not.
      expect((result as LoopChildResult).contextCompacted).toBeUndefined();
      expect(hoisted.terminate).not.toHaveBeenCalled();
    });

    it('WS4: a known observation over the threshold recycles with the occupancy reason', async () => {
      registerDefaultLoopInvoker({} as never);
      (hoisted.adapterRef.current as unknown as { getLastContextUsage: () => unknown }).getLastContextUsage =
        () => ({ status: 'known', used: 130_000, total: 200_000, source: 'provider-turn' });

      const result = await runSameSessionIteration('loop-ws4-known-high', 10_000);

      const compacted = (result as LoopChildResult).contextCompacted;
      expect(compacted).toBeDefined();
      expect(compacted?.previousUtilization).toBeCloseTo(0.65, 5);
      expect(compacted?.reason).toContain('context occupancy');
    });

    it('WS4 REGRESSION: 7M aggregate tokens + unknown (aggregate-only) occupancy must NOT recycle', async () => {
      registerDefaultLoopInvoker({} as never);
      (hoisted.adapterRef.current as unknown as { getLastContextUsage: () => unknown }).getLastContextUsage =
        () => ({ status: 'unknown', reason: 'aggregate-only' });

      const result = await runSameSessionIteration('loop-ws4-unknown', 7_000_000);

      // The deleted fallback divided 7M by the synthetic window and recycled;
      // an unproven occupancy must never recycle.
      expect((result as LoopChildResult).contextCompacted).toBeUndefined();
      expect(hoisted.terminate).not.toHaveBeenCalled();
    });

    it('B8: recycles a same-session loop adapter when the requested model changes', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-model-switch::0',
          loopRunId: 'loop-model-switch',
          chatId: 'chat-model-switch',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      const iter1 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-model-switch::1',
          loopRunId: 'loop-model-switch',
          chatId: 'chat-model-switch',
          provider: 'claude',
          model: 'claude-sonnet-downshift',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 1,
          prompt: 'iter 1',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      expect(hoisted.createAdapter).toHaveBeenCalledTimes(2);
      const firstModel = hoisted.createAdapter.mock.calls[0][0].options.model;
      const secondModel = hoisted.createAdapter.mock.calls[1][0].options.model;
      expect(secondModel).toBe('claude-sonnet-downshift');
      expect(secondModel).not.toBe(firstModel);
      expect(hoisted.terminate).toHaveBeenCalledTimes(1);
      expect(hoisted.terminate).toHaveBeenCalledWith(true);
    });

    it('uses configured timeout when creating a same-session adapter', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const result = emitIteration({
        config: { contextStrategy: 'same-session' },
        iterationTimeoutMs: 12 * 60 * 1000,
        streamIdleTimeoutMs: 123_000,
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await result;

      const callArg = hoisted.createAdapter.mock.calls[0][0];
      expect(callArg.options.timeout).toBe(12 * 60 * 1000);
      expect(hoisted.setStreamIdleTimeoutMs).toHaveBeenCalledWith(123_000);
    });

    it('switches a reused Claude adapter into resume mode after the first same-session iteration', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 5 } });

      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-resume::0',
          loopRunId: 'loop-resume',
          chatId: 'chat-resume',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      expect(hoisted.setResume).toHaveBeenCalledWith(true);
      hoisted.setResume.mockClear();

      const iter1 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-resume::1',
          loopRunId: 'loop-resume',
          chatId: 'chat-resume',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'IMPLEMENT',
          seq: 1,
          prompt: 'iter 1',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      expect(hoisted.setResume).not.toHaveBeenCalledWith(false);
    });

    it('tears down the persistent adapter when the loop reaches a terminal state', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

      // Run one iteration to spin up the persistent adapter.
      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-3::0',
          loopRunId: 'loop-3',
          chatId: 'chat-3',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      expect(hoisted.terminate).not.toHaveBeenCalled();

      // Coordinator broadcasts a terminal state — the invoker must tear
      // the persistent adapter down so we don't leak orphaned CLI processes.
      hoisted.loopCoordinatorRef.current.emit('loop:state-changed', {
        loopRunId: 'loop-3',
        state: { status: 'completed' },
      });
      await new Promise<void>((r) => setImmediate(r));

      expect(hoisted.terminate).toHaveBeenCalledTimes(1);
    });

    it('FU-8: the registered cleanup hook returns the SAME promise as the state-changed listener (dedupe)', async () => {
      // Capture the cleanup hook the invoker registers on the coordinator.
      let registeredHook: ((id: string) => Promise<void>) | undefined;
      (hoisted.loopCoordinatorRef.current as unknown as { setAdapterCleanupHook?: (h: (id: string) => Promise<void>) => void })
        .setAdapterCleanupHook = (hook) => { registeredHook = hook; };

      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

      // Run one iteration so the adapter is tracked.
      const iter0 = new Promise<LoopChildResult | { error: string }>((resolve) => {
        hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
          correlationId: 'loop-dedupe::0',
          loopRunId: 'loop-dedupe',
          chatId: 'chat-dedupe',
          provider: 'claude',
          workspaceCwd: '/tmp/ws',
          stage: 'PLAN',
          seq: 0,
          prompt: 'iter 0',
          config: { contextStrategy: 'same-session' },
          callback: resolve,
        });
      });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      expect(registeredHook).toBeDefined();
      // Hold the adapter terminate so we can prove the dedupe is real.
      let resolveTerminate: (() => void) | undefined;
      hoisted.terminate.mockImplementationOnce(() => new Promise<void>((r) => { resolveTerminate = r; }));

      // Fire both triggers: the state-changed listener (defense-in-depth)
      // AND the awaitable hook. They MUST observe the same in-flight cleanup
      // promise — otherwise the hook's promise would resolve before
      // adapters actually finish terminating (the FU-8 bug).
      hoisted.loopCoordinatorRef.current.emit('loop:state-changed', {
        loopRunId: 'loop-dedupe',
        state: { status: 'completed' },
      });
      const hookPromise = registeredHook!('loop-dedupe');
      let hookResolved = false;
      void hookPromise.then(() => { hookResolved = true; });

      // Give the event loop a tick; the hook must NOT have resolved while
      // the adapter's terminate is still in flight.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      expect(hookResolved).toBe(false);
      expect(hoisted.terminate).toHaveBeenCalledTimes(1);

      // Resolve terminate; both the listener cleanup AND the hook promise
      // must resolve together because they share the same in-flight promise.
      resolveTerminate!();
      await expect(hookPromise).resolves.toBeUndefined();
    });

    it('creates fresh adapters per iteration when contextStrategy is fresh-child', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

      // Two iterations in a row with explicit fresh-child context.
      const iter0 = emitIteration({ config: { contextStrategy: 'fresh-child' } });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      const iter1 = emitIteration({ config: { contextStrategy: 'fresh-child' } });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      // Each iteration spawns + tears down its own adapter.
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(2);
      expect(hoisted.terminate).toHaveBeenCalledTimes(2);
    });

    it('does not borrow the parent live adapter when contextStrategy is fresh-child', async () => {
      const instanceManager = {
        getInstance: vi.fn(() => ({
          id: 'chat-live',
          provider: 'claude',
          workingDirectory: '/tmp/ws',
        })),
        getAdapter: vi.fn(() => hoisted.adapterRef.current),
      };
      registerDefaultLoopInvoker(instanceManager as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

      const result = await emitIteration({
        chatId: 'chat-live',
        workspaceCwd: '/tmp/ws',
        config: { contextStrategy: 'fresh-child' },
      });

      expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
      expect(hoisted.terminate).toHaveBeenCalledTimes(1);
      expect((result as LoopChildResult).transcriptBound).toBe(false);
    });
  });
});
