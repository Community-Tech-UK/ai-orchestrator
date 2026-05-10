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
  setResume: vi.fn(),
  createAdapter: vi.fn(),
  resolveCliType: vi.fn(),
  getBreaker: vi.fn(),
  loopCoordinatorRef: { current: null as unknown as EventEmitter },
  adapterRef: { current: null as unknown as EventEmitter & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendRaw: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    setStreamIdleTimeoutMs: ReturnType<typeof vi.fn>;
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
vi.mock('../../shared/types/provider.types', () => ({ getDefaultModelForCli: vi.fn(() => 'default-model') }));

import { registerDefaultLoopInvoker } from './default-invokers';

describe('Loop Mode invoker plumbing', () => {
  beforeEach(() => {
    // Fresh emitter per test; registerDefaultLoopInvoker bails if a listener
    // already exists, so we must reset both the coordinator mock and the
    // listener registry.
    hoisted.loopCoordinatorRef.current = new EventEmitter();
    hoisted.sendMessage.mockReset();
    hoisted.sendRaw.mockReset().mockResolvedValue(undefined);
    hoisted.terminate.mockReset().mockResolvedValue(undefined);
    hoisted.setStreamIdleTimeoutMs.mockReset();
    hoisted.setResume.mockReset();
    hoisted.createAdapter.mockReset();
    hoisted.resolveCliType.mockReset().mockResolvedValue('claude');
    hoisted.getBreaker.mockImplementation(() => ({
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    }));
    // Build a fresh adapter object that's also an EventEmitter so we can
    // simulate stream:idle events.
    const adapterEmitter = new EventEmitter() as unknown as EventEmitter & {
      sendMessage: typeof hoisted.sendMessage;
      terminate: typeof hoisted.terminate;
      setStreamIdleTimeoutMs: typeof hoisted.setStreamIdleTimeoutMs;
      setResume: typeof hoisted.setResume;
    };
    adapterEmitter.sendMessage = hoisted.sendMessage;
    adapterEmitter.sendRaw = hoisted.sendRaw;
    adapterEmitter.terminate = hoisted.terminate;
    adapterEmitter.setStreamIdleTimeoutMs = hoisted.setStreamIdleTimeoutMs;
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
        prompt: 'do the thing',
        callback: resolve,
        ...extras,
      });
    });
  }

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

  it('does not abort the iteration when adapter emits stream:idle before the CLI finishes', async () => {
    registerDefaultLoopInvoker({} as never);
    let resolveSend!: (value: { content: string; usage: { totalTokens: number } }) => void;
    hoisted.sendMessage.mockImplementation(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const finished = emitIteration({});

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
    const activities: Array<{ kind: string; message: string; loopRunId: string; seq: number }> = [];
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

  it('surfaces hidden input_required prompts and auto-answers ordinary loop questions', async () => {
    registerDefaultLoopInvoker({} as never);
    const activities: Array<{ kind: string; message: string; loopRunId: string; seq: number }> = [];
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
    const activities: Array<{ kind: string; message: string }> = [];
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
    const activities: Array<{ kind: string; message: string }> = [];
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

  describe('contextStrategy: same-session', () => {
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

    it('creates fresh adapters per iteration when contextStrategy is fresh-child', async () => {
      registerDefaultLoopInvoker({} as never);
      hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 1 } });

      // Two iterations in a row, no contextStrategy → defaults to fresh-child.
      const iter0 = emitIteration({ config: {} });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter0;

      const iter1 = emitIteration({ config: {} });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await iter1;

      // Each iteration spawns + tears down its own adapter.
      expect(hoisted.createAdapter).toHaveBeenCalledTimes(2);
      expect(hoisted.terminate).toHaveBeenCalledTimes(2);
    });
  });
});
