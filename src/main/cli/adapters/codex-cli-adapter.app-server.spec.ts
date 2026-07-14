import { afterEach, describe, expect, it, vi } from 'vitest';

const listBrowserApprovalRequestsMock = vi.hoisted(() => vi.fn(() => []));

// Keep all real exports; only stub the process-tree killer so idle-timeout
// tests don't signal real PIDs.
vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

vi.mock('../../browser-gateway/browser-approval-store', () => ({
  getBrowserApprovalStore: () => ({
    listRequests: listBrowserApprovalRequestsMock,
  }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';
import * as codexCliAdapterModule from './codex-cli-adapter';
import { CodexHomeManager } from './codex/codex-home-manager';
import type {
  CodexContextDiagnosticRecord,
  CodexContextDiagnosticSink,
} from './codex/context-pressure-diagnostics';
import { createMockProcess } from './codex-cli-adapter.test-helpers';
import { getLogger } from '../../logging/logger';

// These tests drive the adapter through real PassThrough streams and real
// `setTimeout`-scheduled process output rather than fake timers, so the default
// 5s per-test timeout is borderline on slower/loaded hosts (notably Windows).
// A modest bump gives the event-loop coordination headroom without dragging the
// suite long enough to trip vitest's worker-RPC heartbeat — assertions are
// unchanged, only the deadline is relaxed.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const originalContextDiagnosticsFlag = process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'];

function restoreContextDiagnosticsFlag(): void {
  if (originalContextDiagnosticsFlag === undefined) {
    delete process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'];
  } else {
    process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = originalContextDiagnosticsFlag;
  }
}

function createSyntheticTurnClient(notifications: Array<{ method: string; params: Record<string, unknown> }>) {
  const client = {
    notificationHandler: null as ((notification: { method: string; params: Record<string, unknown> }) => void) | null,
    exitPromise: new Promise<void>(() => {
      // Intentionally pending for the lifetime of the synthetic turn.
    }),
    request: vi.fn(async (method: string) => {
      if (method !== 'turn/start') throw new Error(`Unexpected synthetic RPC: ${method}`);
      for (const notification of notifications) {
        client.notificationHandler?.(notification);
      }
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }),
    setNotificationHandler(handler: typeof client.notificationHandler): void {
      this.notificationHandler = handler;
    },
  };
  return client;
}

async function runCompleteSyntheticTurn(adapter: CodexCliAdapter) {
  const notifications = [
    {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'command-1', type: 'commandExecution', command: 'synthetic-command', aggregatedOutput: 'ok', exitCode: 0 },
      },
    },
    {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        tokenUsage: {
          last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 4 },
          total: { totalTokens: 500, inputTokens: 450, cachedInputTokens: 300, outputTokens: 50, reasoningOutputTokens: 10 },
          modelContextWindow: 1_000,
        },
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'message-1', type: 'agentMessage', phase: 'final_answer', text: 'Synthetic assistant response' },
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    },
  ];
  const client = createSyntheticTurnClient(notifications);
  const outputs: Array<{ content: string; type: string }> = [];
  const contexts: Array<{ total: number; used: number }> = [];
  const completions: Array<{ content: string }> = [];
  adapter.on('output', (output: { content: string; type: string }) => outputs.push(output));
  adapter.on('context', (context: { total: number; used: number }) => contexts.push(context));
  adapter.on('complete', (response: { content: string }) => completions.push(response));
  (adapter as unknown as { appServerClient: typeof client }).appServerClient = client;
  (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';

  await (adapter as unknown as {
    appServerSendMessageInner(message: string): Promise<void>;
  }).appServerSendMessageInner('Synthetic user message');

  return { completions, contexts, outputs };
}

describe('CodexCliAdapter', () => {
  afterEach(() => {
    restoreContextDiagnosticsFlag();
    listBrowserApprovalRequestsMock.mockReset();
    listBrowserApprovalRequestsMock.mockReturnValue([]);
    vi.restoreAllMocks();
  });

  // ─── New tests for app-server hardening (Phase 2/3) ────────────────

  describe('context-pressure diagnostics', () => {
    it('enables diagnostics only for the exact flag value 1', () => {
      const isEnabled = (codexCliAdapterModule as unknown as {
        isCodexContextDiagnosticsEnabled?: (env?: NodeJS.ProcessEnv) => boolean;
      }).isCodexContextDiagnosticsEnabled;

      expect(isEnabled).toBeTypeOf('function');
      expect(isEnabled?.({ AIO_CODEX_CONTEXT_DIAGNOSTICS: '1' })).toBe(true);
      expect(isEnabled?.({ AIO_CODEX_CONTEXT_DIAGNOSTICS: 'true' })).toBe(false);
      expect(isEnabled?.({ AIO_CODEX_CONTEXT_DIAGNOSTICS: '01' })).toBe(false);
      expect(isEnabled?.({})).toBe(false);
    });

    it('is disabled by default and leaves a complete app-server turn unchanged', async () => {
      delete process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'];
      const diagnosticInfo = vi.spyOn(getLogger('CodexContextDiagnostics'), 'info');
      const adapter = new CodexCliAdapter();

      const result = await runCompleteSyntheticTurn(adapter);

      expect(diagnosticInfo).not.toHaveBeenCalled();
      expect((adapter as unknown as { contextDiagnostics: unknown }).contextDiagnostics).toBeNull();
      expect(result.outputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistant', content: 'Synthetic assistant response' }),
      ]));
      expect(result.contexts).toEqual([
        expect.objectContaining({ used: 120, total: 1_000 }),
      ]);
      expect(result.completions).toEqual([
        expect.objectContaining({ content: 'Synthetic assistant response' }),
      ]);
    });

    it('records the enabled root/subagent lifecycle in numeric order', () => {
      process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = '1';
      const records: CodexContextDiagnosticRecord[] = [];
      vi.spyOn(getLogger('CodexContextDiagnostics'), 'info').mockImplementation((message, data) => {
        if (message === 'context-pressure-observation') {
          records.push(data as unknown as CodexContextDiagnosticRecord);
        }
      });
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): unknown;
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');

      for (const notification of [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', aggregatedOutput: 'abc' } } },
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            tokenUsage: {
              last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 4 },
              total: { totalTokens: 500, inputTokens: 450, cachedInputTokens: 300, outputTokens: 50, reasoningOutputTokens: 20 },
              modelContextWindow: 1_000,
            },
          },
        },
        { method: 'item/completed', params: { threadId: 'subagent-1', item: { type: 'dynamicToolCall', output: 'subagent-output' } } },
        { method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'mcpToolCall', output: 'xy' } } },
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            tokenUsage: {
              last: { totalTokens: 140, inputTokens: 125, cachedInputTokens: 70, outputTokens: 15, reasoningOutputTokens: 6 },
              total: { totalTokens: 580, inputTokens: 520, cachedInputTokens: 340, outputTokens: 60, reasoningOutputTokens: 26 },
              modelContextWindow: 1_000,
            },
          },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      ]) {
        internals.handleTurnNotification(state, notification);
      }

      expect(records.map((record) => record.kind)).toEqual([
        'turn-start',
        'item-completed',
        'token-usage',
        'item-completed',
        'item-completed',
        'token-usage',
        'turn-complete',
      ]);
      expect(records.filter((record) => record.kind === 'item-completed')).toEqual([
        expect.objectContaining({ itemSequence: 1, itemClass: 'command', rootThread: true }),
        expect.objectContaining({ itemSequence: 2, itemClass: 'dynamic', rootThread: false }),
        expect.objectContaining({ itemSequence: 3, itemClass: 'mcp', rootThread: true }),
      ]);
      expect(records.filter((record) => record.kind === 'token-usage')).toEqual([
        expect.objectContaining({ requestSequence: 1, rootItemsSincePreviousUsage: 1 }),
        expect.objectContaining({ requestSequence: 2, rootItemsSincePreviousUsage: 1 }),
      ]);
      expect(records.at(-1)).toMatchObject({
        kind: 'turn-complete',
        requestSequence: 2,
        rootItems: 2,
        subagentItems: 1,
        completionStatus: 'completed',
      });
    });

    it.each([
      ['failed', 'failed'],
      ['interrupted', 'interrupted'],
      [null, 'unknown'],
    ] as const)('records %s terminal turns as %s', (turnStatus, expectedStatus) => {
      process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = '1';
      const records: CodexContextDiagnosticRecord[] = [];
      vi.spyOn(getLogger('CodexContextDiagnostics'), 'info').mockImplementation((message, data) => {
        if (message === 'context-pressure-observation') records.push(data as unknown as CodexContextDiagnosticRecord);
      });
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        completeTurn(state: unknown, turn: { id: string; status: string } | null): void;
        createTurnCaptureState(threadId: string): unknown;
        handleTurnNotification(state: unknown, notification: { method: string; params: Record<string, unknown> }): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      internals.handleTurnNotification(state, {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      });

      if (turnStatus === null) {
        internals.completeTurn(state, null);
      } else {
        internals.handleTurnNotification(state, {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: turnStatus } },
        });
      }

      expect(records.at(-1)).toMatchObject({
        kind: 'turn-complete',
        completionStatus: expectedStatus,
      });
    });

    it('finishes an abandoned active diagnostic turn as unknown in capture cleanup', async () => {
      process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = '1';
      const records: CodexContextDiagnosticRecord[] = [];
      vi.spyOn(getLogger('CodexContextDiagnostics'), 'info').mockImplementation((message, data) => {
        if (message === 'context-pressure-observation') records.push(data as unknown as CodexContextDiagnosticRecord);
      });
      const adapter = new CodexCliAdapter({ timeout: 1 });
      const client = createSyntheticTurnClient([{
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      }]);
      (adapter as unknown as { appServerClient: typeof client }).appServerClient = client;
      (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';

      vi.useFakeTimers();
      try {
        const capture = (adapter as unknown as { captureTurn(input: unknown[]): Promise<unknown> })
          .captureTurn([{ type: 'text', text: 'synthetic', text_elements: [] }]);
        const rejection = expect(capture).rejects.toThrow(/no notifications received/i);
        await vi.advanceTimersByTimeAsync(2);
        await rejection;
      } finally {
        vi.useRealTimers();
      }

      expect(records.at(-1)).toMatchObject({
        kind: 'turn-complete',
        completionStatus: 'unknown',
      });
    });

    it('records manual compaction RPC stages without changing the existing return values', async () => {
      process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = '1';
      const records: CodexContextDiagnosticRecord[] = [];
      vi.spyOn(getLogger('CodexContextDiagnostics'), 'info').mockImplementation((message, data) => {
        if (message === 'context-pressure-observation') {
          records.push(data as unknown as CodexContextDiagnosticRecord);
        }
      });
      const adapter = new CodexCliAdapter();
      const request = vi.fn()
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('synthetic compaction failure'));
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';

      await expect(adapter.compactContext()).resolves.toBe(true);
      await expect(adapter.compactContext()).resolves.toBe(false);

      expect(records.filter((record) => record.kind === 'compaction-rpc')).toEqual([
        expect.objectContaining({ stage: 'requested' }),
        expect.objectContaining({ stage: 'accepted' }),
        expect.objectContaining({ stage: 'requested' }),
        expect.objectContaining({ stage: 'failed' }),
      ]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, 'thread/compact/start', { threadId: 'thread-1' });
      expect(request).toHaveBeenNthCalledWith(2, 'thread/compact/start', { threadId: 'thread-1' });
    });

    it('isolates a throwing sink and logs one bounded warning while the turn completes normally', async () => {
      process.env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] = '1';
      const warning = vi.spyOn(getLogger('CodexContextDiagnostics'), 'warn').mockImplementation(() => undefined);
      const adapter = new CodexCliAdapter();
      const throwingSink: CodexContextDiagnosticSink = {
        write: () => {
          throw new Error('synthetic sink failure containing raw notification data');
        },
      };
      (adapter as unknown as { contextDiagnosticsSink: CodexContextDiagnosticSink }).contextDiagnosticsSink = throwingSink;

      const result = await runCompleteSyntheticTurn(adapter);

      expect(result.outputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistant', content: 'Synthetic assistant response' }),
      ]));
      expect(result.contexts).toEqual([
        expect.objectContaining({ used: 120, total: 1_000 }),
      ]);
      expect(result.completions).toHaveLength(1);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith('Context-pressure diagnostic write failed');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic sink failure');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('thread/tokenUsage/updated');
    });
  });

  describe('dual-mode configuration', () => {
    it('reports supportsNativeCompaction=false when not in app-server mode', () => {
      const adapter = new CodexCliAdapter();
      expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(false);
      expect(adapter.getRuntimeCapabilities().selfManagedAutoCompaction).toBe(false);
    });

    it('reports app-server mode as self-managed for automatic compaction', () => {
      const adapter = new CodexCliAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;

      expect(adapter.getRuntimeCapabilities()).toMatchObject({
        supportsNativeCompaction: true,
        selfManagedAutoCompaction: true,
      });
    });

    it('reports isAppServerMode()=false before spawn', () => {
      const adapter = new CodexCliAdapter();
      expect(adapter.isAppServerMode()).toBe(false);
    });

    it('falls back to exec mode when app-server is not available', async () => {
      const adapter = new CodexCliAdapter();
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
        available: true,
        authenticated: true,
        path: 'codex',
        version: '0.107.0',
        metadata: { appServerAvailable: false },
      });

      await adapter.spawn();

      expect(adapter.isAppServerMode()).toBe(false);
      expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(false);
    });

    it('spawn prepares a session-isolated CODEX_HOME so rollouts stay out of ~/.codex', async () => {
      const { mkdirSync, readlinkSync, rmSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const sandboxHome = join(tmpdir(), `codex-adapter-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(sandboxHome, '.codex'), { recursive: true });
      writeFileSync(join(sandboxHome, '.codex', 'config.toml'), 'model = "gpt-5.3-codex"', 'utf-8');
      const originalHome = process.env['HOME'];
      process.env['HOME'] = sandboxHome;

      const adapter = new CodexCliAdapter();
      try {
        vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
          available: true,
          authenticated: true,
          path: 'codex',
          version: '0.107.0',
          metadata: { appServerAvailable: false },
        });

        await adapter.spawn();

        const codexHome = (adapter as unknown as { config: { env?: Record<string, string> } }).config.env?.['CODEX_HOME'];
        expect(codexHome).toBeTruthy();
        expect(readlinkSync(join(codexHome!, 'sessions'))).toBe(
          join(sandboxHome, '.ai-orchestrator', 'codex', 'sessions'),
        );
      } finally {
        (adapter as unknown as { cleanupCodexHome(): void }).cleanupCodexHome();
        process.env['HOME'] = originalHome;
        rmSync(sandboxHome, { recursive: true, force: true });
      }
    });

    it('aborts spawn when an isolated CODEX_HOME cannot be prepared', async () => {
      vi.spyOn(CodexHomeManager.prototype, 'prepareMcpFreeHome').mockReturnValue(null);
      const adapter = new CodexCliAdapter();
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
        available: true,
        authenticated: true,
        path: 'codex',
        version: '0.107.0',
        metadata: { appServerAvailable: false },
      });

      await expect(adapter.spawn()).rejects.toThrow('isolated CODEX_HOME');
    });
  });

  describe('new config options', () => {
    it('accepts outputSchema in config', () => {
      const schema = { type: 'object', properties: { score: { type: 'number' } } };
      const adapter = new CodexCliAdapter({ outputSchema: schema });
      expect(adapter.getCapabilities().outputFormats).toContain('json');
    });

    it('accepts reasoningEffort in config', () => {
      const adapter = new CodexCliAdapter({ reasoningEffort: 'high' });
      expect(adapter.getCapabilities().toolUse).toBe(true);
    });

    it('compactContext returns false when not in app-server mode', async () => {
      const adapter = new CodexCliAdapter();
      const result = await adapter.compactContext();
      expect(result).toBe(false);
    });
  });

  describe('timeout configuration', () => {
    it('uses the configured long-turn timeout for exec-mode follow-up turns', async () => {
      const adapter = new CodexCliAdapter({ timeout: 900_000, workingDir: '/tmp/project' });
      (adapter as unknown as { hasCompletedExecTurn: boolean }).hasCompletedExecTurn = true;

      const executeSpy = vi.spyOn(
        adapter as unknown as {
          executePreparedMessage(
            message: { content: string; role: 'user' },
            options: { timeoutMs: number; phase: 'startup' | 'turn' }
          ): Promise<{
            code: number | null;
            diagnostics: { fatal: boolean }[];
            raw: string;
            response: { content: string; id: string; metadata: Record<string, unknown>; role: 'assistant' };
          }>;
        },
        'executePreparedMessage'
      ).mockResolvedValue({
        code: 0,
        diagnostics: [],
        raw: '',
        response: {
          id: 'resp-long-turn',
          role: 'assistant',
          content: 'done',
          metadata: {},
        },
      });

      await adapter.sendMessage({ role: 'user', content: 'Investigate this deeply' });

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Investigate this deeply', role: 'user' }),
        { timeoutMs: 900_000, phase: 'turn' }
      );
    });

    it('treats the configured timeout as a total deadline and caps idle budgets by it', () => {
      const internals = (a: CodexCliAdapter) => a as unknown as {
        resolveDeadlineMs(): number;
        resolveTurnIdleTimeoutMs(): number;
        resolveNotificationIdleTimeoutMs(activeItems: number): number;
      };

      // Review-style config (120s): the deadline is the configured total; the
      // exec idle budget is the built-in turn constant capped by the deadline
      // (codex's bursty output must NOT be killed for 120s of mid-work silence
      // unless that also exhausts the total budget).
      const review = internals(new CodexCliAdapter({ timeout: 120_000 }));
      expect(review.resolveDeadlineMs()).toBe(120_000);
      expect(review.resolveTurnIdleTimeoutMs()).toBe(120_000);
      expect(review.resolveNotificationIdleTimeoutMs(0)).toBe(90_000);
      expect(review.resolveNotificationIdleTimeoutMs(1)).toBe(120_000);

      // Loop-style config (30 min): idle budgets stay at the built-in
      // constants — the configured timeout no longer inflates them.
      const loop = internals(new CodexCliAdapter({ timeout: 1_800_000 }));
      expect(loop.resolveDeadlineMs()).toBe(1_800_000);
      expect(loop.resolveTurnIdleTimeoutMs()).toBe(900_000);
      expect(loop.resolveNotificationIdleTimeoutMs(0)).toBe(90_000);
      expect(loop.resolveNotificationIdleTimeoutMs(1)).toBe(900_000);

      // Tiny deadline: no idle budget may exceed the total deadline — a 30s
      // budget must not wait 60s/90s of silence to report.
      const tiny = internals(new CodexCliAdapter({ timeout: 30_000 }));
      expect(tiny.resolveTurnIdleTimeoutMs()).toBe(30_000);
      expect(tiny.resolveNotificationIdleTimeoutMs(0)).toBe(30_000);
      expect(tiny.resolveNotificationIdleTimeoutMs(1)).toBe(30_000);

      // Unset / invalid configs fall back to the built-in turn budget.
      const unset = internals(new CodexCliAdapter());
      expect(unset.resolveDeadlineMs()).toBe(900_000);
      expect(unset.resolveTurnIdleTimeoutMs()).toBe(900_000);
      expect(internals(new CodexCliAdapter({ timeout: 0 })).resolveDeadlineMs()).toBe(900_000);
      expect(internals(new CodexCliAdapter({ timeout: Number.NaN })).resolveDeadlineMs()).toBe(900_000);
    });
  });

  describe('app-server assistant streaming', () => {
    it('keeps retrying app-server error notifications as warnings instead of poisoning the turn', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): {
          error: unknown;
        };
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');

      internals.handleTurnNotification(state, {
        method: 'error',
        params: {
          error: { message: 'Reconnecting... 3/5' },
          willRetry: true,
          codex_error_info: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        },
      });

      expect(state.error).toBeNull();
    });

    it('resets cached context usage when Codex reports native thread compaction', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): unknown;
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      const contextEvents: {
        cumulativeTokens?: number;
        isEstimated?: boolean;
        percentage: number;
        total: number;
        used: number;
      }[] = [];

      adapter.on('context', (usage) => contextEvents.push(usage));

      internals.handleTurnNotification(state, {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          tokenUsage: {
            modelContextWindow: 200_000,
            last: { totalTokens: 188_000 },
            total: { totalTokens: 500_000 },
          },
        },
      });
      internals.handleTurnNotification(state, {
        method: 'thread/compacted',
        params: { threadId: 'thread-1' },
      });

      expect(contextEvents).toHaveLength(2);
      expect(contextEvents[0]).toMatchObject({
        used: 188_000,
        total: 200_000,
        percentage: 94,
        cumulativeTokens: 500_000,
      });
      expect(contextEvents[1]).toMatchObject({
        used: 0,
        total: 200_000,
        percentage: 0,
        cumulativeTokens: 500_000,
        isEstimated: true,
      });
    });

    it('maps camelCase incident usage fields to current occupancy and cumulative processing', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): unknown;
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      const contextEvents: { cumulativeTokens?: number; percentage: number; total: number; used: number }[] = [];
      adapter.on('context', (usage) => contextEvents.push(usage));

      internals.handleTurnNotification(state, {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          tokenUsage: {
            last: {
              totalTokens: 242_865,
              inputTokens: 242_356,
              cachedInputTokens: 241_408,
              outputTokens: 509,
              reasoningOutputTokens: 301,
            },
            total: {
              totalTokens: 18_910_442,
              inputTokens: 18_885_729,
              cachedInputTokens: 18_555_136,
              outputTokens: 24_713,
              reasoningOutputTokens: 10_153,
            },
            modelContextWindow: 258_400,
          },
        },
      });

      expect(contextEvents).toHaveLength(1);
      expect(contextEvents[0]).toMatchObject({
        used: 242_865,
        total: 258_400,
        cumulativeTokens: 18_910_442,
      });
      expect(contextEvents[0].percentage).toBeCloseTo(93.9880, 4);
    });

    it('maps snake_case incident usage fields to current occupancy and cumulative processing', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): unknown;
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      const contextEvents: { cumulativeTokens?: number; percentage: number; total: number; used: number }[] = [];
      adapter.on('context', (usage) => contextEvents.push(usage));

      internals.handleTurnNotification(state, {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          token_usage: {
            last_token_usage: {
              total_tokens: 242_865,
              input_tokens: 242_356,
              cached_input_tokens: 241_408,
              output_tokens: 509,
              reasoning_output_tokens: 301,
            },
            total_token_usage: {
              total_tokens: 18_910_442,
              input_tokens: 18_885_729,
              cached_input_tokens: 18_555_136,
              output_tokens: 24_713,
              reasoning_output_tokens: 10_153,
            },
            model_context_window: 258_400,
          },
        },
      });

      expect(contextEvents).toHaveLength(1);
      expect(contextEvents[0]).toMatchObject({
        used: 242_865,
        total: 258_400,
        cumulativeTokens: 18_910_442,
      });
      expect(contextEvents[0].percentage).toBeCloseTo(93.9880, 4);
    });

    it('emits assistant deltas with a stable id and reconciles the final item', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): {
          turnId: string | null;
          lastAgentMessage: string;
          finalAgentOutputId: string | null;
        };
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      state.turnId = 'turn-1';
      const outputs: {
        id: string;
        content: string;
        metadata?: Record<string, unknown>;
        type: string;
      }[] = [];

      adapter.on('output', (message) => outputs.push(message as typeof outputs[number]));

      internals.handleTurnNotification(state, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'Hello ',
        },
      });
      internals.handleTurnNotification(state, {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          item: {
            id: 'item-1',
            type: 'agentMessage',
            text: 'Hello world',
          },
        },
      });

      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toMatchObject({
        type: 'assistant',
        content: 'Hello ',
        metadata: {
          streaming: true,
          accumulatedContent: 'Hello ',
          turnId: 'turn-1',
        },
      });
      expect(outputs[1]).toMatchObject({
        type: 'assistant',
        content: 'world',
        metadata: {
          streaming: true,
          accumulatedContent: 'Hello world',
          turnId: 'turn-1',
        },
      });
      expect(outputs[1].id).toBe(outputs[0].id);
      expect(state.lastAgentMessage).toBe('Hello world');
      expect(state.finalAgentOutputId).toBe(outputs[0].id);
    });

    it('reconciles canonical turn-completed agent items when the streamed item id differs', () => {
      const adapter = new CodexCliAdapter();
      const internals = adapter as unknown as {
        createTurnCaptureState(threadId: string): {
          completed: boolean;
          finalAgentOutputId: string | null;
          lastAgentMessage: string;
          turnId: string | null;
        };
        handleTurnNotification(
          state: unknown,
          notification: { method: string; params: Record<string, unknown> },
        ): void;
      };
      const state = internals.createTurnCaptureState('thread-1');
      state.turnId = 'turn-1';
      const outputs: {
        id: string;
        content: string;
        metadata?: Record<string, unknown>;
        type: string;
      }[] = [];
      const streamedPrefix = 'Moving messages into a database does not achieve that by itself, and I';
      const finalText = `${streamedPrefix} would keep the chat stream append-only.`;

      adapter.on('output', (message) => outputs.push(message as typeof outputs[number]));

      internals.handleTurnNotification(state, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'stream-item',
          delta: streamedPrefix,
        },
      });
      internals.handleTurnNotification(state, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                id: 'final-item',
                type: 'agentMessage',
                phase: 'final_answer',
                text: finalText,
              },
            ],
          },
        },
      });

      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toMatchObject({
        type: 'assistant',
        content: streamedPrefix,
        metadata: {
          streaming: true,
          accumulatedContent: streamedPrefix,
          turnId: 'turn-1',
        },
      });
      expect(outputs[1]).toMatchObject({
        type: 'assistant',
        content: ' would keep the chat stream append-only.',
        metadata: {
          streaming: true,
          accumulatedContent: finalText,
          turnId: 'turn-1',
        },
      });
      expect(outputs[1].id).toBe(outputs[0].id);
      expect(state.completed).toBe(true);
      expect(state.lastAgentMessage).toBe(finalText);
      expect(state.finalAgentOutputId).toBe(outputs[0].id);
    });
  });

  describe('interrupt behavior', () => {
    it('returns already-idle (falls back to SIGINT) when not in app-server mode', () => {
      const adapter = new CodexCliAdapter();
      // No process running, so interrupt reports no active process.
      const result = adapter.interrupt();
      expect(result.status).toBe('already-idle');
    });

    it('arms a pending abort when interrupt fires before turn/start returns (§6.1)', async () => {
      const adapter = new CodexCliAdapter();
      const request = vi.fn().mockResolvedValue({ success: true });
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';
      (adapter as unknown as { turnInProgress: boolean }).turnInProgress = true;
      // currentTurnId is null — turn/start hasn't returned yet
      (adapter as unknown as { currentTurnId: null }).currentTurnId = null;
      (adapter as unknown as { currentTurnCompletion: Promise<unknown> }).currentTurnCompletion =
        Promise.resolve({ status: 'interrupted', turnId: 'turn-1' });

      // Interrupt fires BEFORE turnId is known
      const result = adapter.interrupt();
      expect(result.status).toBe('accepted');
      expect(result.turnId).toBeUndefined();

      // No RPC yet — turnId not known
      expect(request).not.toHaveBeenCalled();

      // Now turn/start resolves: assign currentTurnId
      (adapter as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';
      const interruptFn = (adapter as unknown as {
        interruptActiveAppServerTurn(
          threadId: string,
          turnId: string,
          completion: Promise<unknown> | null,
        ): Promise<unknown>;
      }).interruptActiveAppServerTurn.bind(adapter);
      // Simulate the pending-abort delivery that fires in the code
      const pendingResolve = (adapter as unknown as { pendingAbortResolve: ((r: unknown) => void) | null }).pendingAbortResolve;
      if (pendingResolve) {
        await interruptFn('thread-1', 'turn-1', Promise.resolve({ status: 'interrupted', turnId: 'turn-1' }))
          .then(pendingResolve);
      }

      await expect(result.completion).resolves.toMatchObject({ status: 'interrupted' });
      expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' });
    });

    it('resolves pending abort as unknown when turn ends before turnId is assigned', async () => {
      const adapter = new CodexCliAdapter();
      const request = vi.fn().mockResolvedValue({ success: true });
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';
      (adapter as unknown as { turnInProgress: boolean }).turnInProgress = true;
      (adapter as unknown as { currentTurnId: null }).currentTurnId = null;

      const result = adapter.interrupt();
      expect(result.status).toBe('accepted');

      // Simulate the finally block: turn ended without a turnId ever being set
      const resolve = (adapter as unknown as { pendingAbortResolve: ((r: unknown) => void) | null }).pendingAbortResolve;
      expect(resolve).not.toBeNull();
      resolve?.({ status: 'unknown', reason: 'turn ended before pending interrupt could fire' });
      (adapter as unknown as { pendingAbortResolve: null }).pendingAbortResolve = null;

      await expect(result.completion).resolves.toMatchObject({ status: 'unknown' });
      expect(request).not.toHaveBeenCalled();
    });

    it('waits for app-server interrupt acceptance and turn completion proof', async () => {
      const adapter = new CodexCliAdapter();
      const request = vi.fn().mockResolvedValue({ success: true });
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';
      (adapter as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';
      (adapter as unknown as { turnInProgress: boolean }).turnInProgress = true;
      (adapter as unknown as { currentTurnCompletion: Promise<unknown> }).currentTurnCompletion =
        Promise.resolve({ status: 'interrupted', turnId: 'turn-1' });

      const result = adapter.interrupt();

      expect(result.status).toBe('accepted');
      expect(result.turnId).toBe('turn-1');
      await expect(result.completion).resolves.toEqual({
        status: 'interrupted',
        turnId: 'turn-1',
      });
      expect(request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
    });

    it('treats interrupting an already-ended turn as a no-op without sending the RPC (P3.3)', async () => {
      const adapter = new CodexCliAdapter();
      const request = vi.fn().mockResolvedValue({ success: true });
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      // The turn we want to interrupt is no longer current: it ended and a new
      // turn started.
      (adapter as unknown as { turnInProgress: boolean }).turnInProgress = true;
      (adapter as unknown as { currentTurnId: string }).currentTurnId = 'turn-2';

      const interruptFn = (adapter as unknown as {
        interruptActiveAppServerTurn(
          threadId: string,
          turnId: string,
          completion: Promise<unknown> | null,
        ): Promise<{ status: string }>;
      }).interruptActiveAppServerTurn.bind(adapter);

      const result = await interruptFn('thread-1', 'turn-1', null);
      expect(result.status).toBe('unknown');
      expect(request).not.toHaveBeenCalled();
    });

    it('classifies a turn/interrupt rejection as no-op when the turn moved on (P3.3)', async () => {
      const adapter = new CodexCliAdapter();
      // RPC rejects (turn-id mismatch) and by the time it resolves the turn has ended.
      const request = vi.fn().mockImplementation(async () => {
        (adapter as unknown as { turnInProgress: boolean }).turnInProgress = false;
        return { success: false };
      });
      (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };
      (adapter as unknown as { turnInProgress: boolean }).turnInProgress = true;
      (adapter as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';

      const interruptFn = (adapter as unknown as {
        interruptActiveAppServerTurn(
          threadId: string,
          turnId: string,
          completion: Promise<unknown> | null,
        ): Promise<{ status: string }>;
      }).interruptActiveAppServerTurn.bind(adapter);

      const result = await interruptFn('thread-1', 'turn-1', null);
      expect(request).toHaveBeenCalled();
      expect(result.status).toBe('unknown');
    });
  });

  describe('exec-mode liveness heartbeat', () => {
    it('emits synthetic heartbeats at the configured cadence while a silent codex child is running', async () => {
      const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
      const spawnSpy = vi.spyOn(
        adapter as unknown as { spawnProcess(args: string[]): unknown },
        'spawnProcess'
      );
      const proc = createMockProcess();
      spawnSpy.mockReturnValueOnce(proc as unknown);

      const heartbeats: number[] = [];
      adapter.on('heartbeat', () => heartbeats.push(Date.now()));

      vi.useFakeTimers();
      try {
        const execPromise = (adapter as unknown as {
          executePreparedMessage(
            message: { content: string; role: 'user' },
            options: { timeoutMs: number; phase: 'startup' | 'turn' }
          ): Promise<unknown>;
        }).executePreparedMessage(
          { role: 'user', content: 'silent turn' },
          { timeoutMs: 120_000, phase: 'turn' }
        );

        // Advance past several heartbeat intervals with the mock child
        // producing NO stdout/stderr. Synthetic liveness should still
        // heartbeat at 15s cadence. 40s → at least 2 ticks.
        await vi.advanceTimersByTimeAsync(40_000);
        expect(heartbeats.length).toBeGreaterThanOrEqual(2);

        // Cleanly finish the turn so the promise resolves and timers clear.
        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(0, null);
        await vi.advanceTimersByTimeAsync(1);
        await execPromise.catch(() => {
          // We only care about the heartbeats, not the turn outcome.
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops synthetic heartbeats after the child exits', async () => {
      const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
      const spawnSpy = vi.spyOn(
        adapter as unknown as { spawnProcess(args: string[]): unknown },
        'spawnProcess'
      );
      const proc = createMockProcess();
      spawnSpy.mockReturnValueOnce(proc as unknown);

      const heartbeats: number[] = [];
      adapter.on('heartbeat', () => heartbeats.push(Date.now()));

      vi.useFakeTimers();
      try {
        const execPromise = (adapter as unknown as {
          executePreparedMessage(
            message: { content: string; role: 'user' },
            options: { timeoutMs: number; phase: 'startup' | 'turn' }
          ): Promise<unknown>;
        }).executePreparedMessage(
          { role: 'user', content: 'short turn' },
          { timeoutMs: 120_000, phase: 'turn' }
        );

        // Fire one heartbeat, then close.
        await vi.advanceTimersByTimeAsync(16_000);
        const countAtClose = heartbeats.length;
        expect(countAtClose).toBeGreaterThanOrEqual(1);

        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(0, null);
        await execPromise.catch(() => { /* outcome not asserted */ });

        // Advance past multiple further heartbeat intervals — none should fire
        // because the interval was cleared on close.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(heartbeats.length).toBe(countAtClose);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('app-server init timeout', () => {
    it('falls back to exec mode when app-server init times out', async () => {
      const adapter = new CodexCliAdapter();

      // Mock checkStatus to report app-server available
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
        available: true,
        metadata: { appServerAvailable: true },
      });

      // Mock initAppServerMode to hang forever (never resolve)
      vi.spyOn(
        adapter as unknown as { initAppServerMode(): Promise<void> },
        'initAppServerMode'
      ).mockReturnValue(new Promise<void>(() => {
        // Intentionally pending.
      }));

      // Mock Codex home preparation for exec fallback.
      vi.spyOn(
        adapter as unknown as { prepareCodexHome(): void },
        'prepareCodexHome'
      ).mockReturnValue(undefined);

      // Use fake timers to advance past the 30s timeout
      vi.useFakeTimers();
      const spawnPromise = adapter.spawn();
      await vi.advanceTimersByTimeAsync(31_000);
      const pid = await spawnPromise;
      vi.useRealTimers();

      expect(pid).toBeGreaterThan(0);
      expect((adapter as unknown as { useAppServer: boolean }).useAppServer).toBe(false);
    });
  });

  describe('enhanced checkStatus', () => {
    it('includes appServerAvailable in status metadata', async () => {
      const adapter = new CodexCliAdapter();
      const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): unknown }, 'spawnProcess');

      const proc = createMockProcess();
      spawnSpy.mockReturnValueOnce(proc as unknown);

      setTimeout(() => {
        proc.stdout.write('codex 0.107.0\n');
        proc.emitClose(0, null);
      }, 0);

      const status = await adapter.checkStatus();
      // The metadata field should exist (appServerAvailable is determined separately)
      expect(status.available).toBe(true);
      expect(status).toHaveProperty('metadata');
    });
  });

  describe('sendInput failure recovery', () => {
    // Regression: in exec mode the child has already exited when sendInput
    // rejects — there is no persistent state to recover, so the adapter must
    // emit status='idle' (not 'error') so the renderer can auto-retry instead
    // of showing "restart the instance to send it."
    async function spawnExecAdapter(): Promise<CodexCliAdapter> {
      const adapter = new CodexCliAdapter();
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
        available: true,
        authenticated: true,
        path: 'codex',
        version: '0.107.0',
        metadata: { appServerAvailable: false },
      });
      await adapter.spawn();
      return adapter;
    }

    function collectStatuses(adapter: CodexCliAdapter): string[] {
      const statuses: string[] = [];
      adapter.on('status', (status: string) => statuses.push(status));
      return statuses;
    }

    it('emits status=idle in exec mode after a transient HTTP 500 failure', async () => {
      const adapter = await spawnExecAdapter();
      vi.spyOn(adapter, 'sendMessage').mockRejectedValue(
        new Error('Codex exec failed: http 500 Internal Server Error')
      );

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/http 500/i);

      // busy during the turn, idle after (not 'error')
      expect(statuses).toEqual(['busy', 'idle']);
    });

    it('emits status=idle in exec mode even for auth errors (the child has already exited)', async () => {
      const adapter = await spawnExecAdapter();
      vi.spyOn(adapter, 'sendMessage').mockRejectedValue(
        new Error('Codex exec failed: unauthorized')
      );

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/unauthorized/i);

      // Exec mode is always recoverable — a fresh process spawns on the next
      // turn and will surface the auth error directly to the user.
      expect(statuses).toEqual(['busy', 'idle']);
    });

    it('emits status=idle in app-server mode for transient backend errors', async () => {
      const adapter = await spawnExecAdapter();
      // Flip the adapter into app-server mode and stub the RPC path.
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
      vi.spyOn(
        adapter as unknown as { appServerSendMessage(m: string, a?: unknown): Promise<void> },
        'appServerSendMessage'
      ).mockRejectedValue(new Error('Codex error: connection reset by peer'));

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/connection reset/i);

      expect(statuses).toEqual(['busy', 'idle']);
    });

    it('emits status=idle in app-server mode for response stream disconnect failures', async () => {
      const adapter = await spawnExecAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
      vi.spyOn(
        adapter as unknown as { appServerSendMessage(m: string, a?: unknown): Promise<void> },
        'appServerSendMessage'
      ).mockRejectedValue(
        new Error(
          'stream disconnected before completion: Incomplete response returned, reason: content_filter - [codex_error_info: {"responseStreamDisconnected":{"httpStatusCode":null}}]'
        )
      );

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/responseStreamDisconnected/i);

      expect(statuses).toEqual(['busy', 'idle']);
    });

    it('emits status=idle (not error) in app-server mode for a usage-limit rejection', async () => {
      // Regression for the 2026-07-11 park-fix incident: a Codex usage-limit
      // turn rejects sendInput() directly rather than emitting 'error', so it
      // never reached the on('error') park hook and instead dropped the
      // instance to 'error' status, wiping the message queue.
      const adapter = await spawnExecAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
      vi.spyOn(
        adapter as unknown as { appServerSendMessage(m: string, a?: unknown): Promise<void> },
        'appServerSendMessage'
      ).mockRejectedValue(
        new Error(
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:01 PM. - [codex_error_info: usageLimitExceeded]"
        )
      );

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/usage limit/i);

      // The thread is alive — the account is throttled, not the session — so
      // this stays idle (and rethrows, letting instance-communication.ts's
      // tryParkOnProviderLimit park the session instead of erroring it).
      expect(statuses).toEqual(['busy', 'idle']);
    });

    it('emits status=error in app-server mode for fatal auth errors', async () => {
      const adapter = await spawnExecAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
      vi.spyOn(
        adapter as unknown as { appServerSendMessage(m: string, a?: unknown): Promise<void> },
        'appServerSendMessage'
      ).mockRejectedValue(new Error('unauthorized: authentication required'));

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/unauthorized/i);

      // App-server mode keeps the stricter behavior because a failed turn
      // there may have broken the persistent thread/client; auth/session/model
      // errors require a fresh instance.
      expect(statuses).toEqual(['busy', 'error']);
    });

    it('emits status=error in app-server mode for session-not-found errors', async () => {
      const adapter = await spawnExecAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
      vi.spyOn(
        adapter as unknown as { appServerSendMessage(m: string, a?: unknown): Promise<void> },
        'appServerSendMessage'
      ).mockRejectedValue(new Error('thread not found: thread-abc'));

      const statuses = collectStatuses(adapter);
      await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread not found/i);

      expect(statuses).toEqual(['busy', 'error']);
    });

    it('emits an error output message with the underlying Codex error text', async () => {
      const adapter = await spawnExecAdapter();
      vi.spyOn(adapter, 'sendMessage').mockRejectedValue(
        new Error('Codex exec failed: http 500 Internal Server Error')
      );

      const outputs: { content: string; type: string }[] = [];
      adapter.on('output', (msg: { content: string; type: string }) => {
        outputs.push({ content: msg.content, type: msg.type });
      });

      await expect(adapter.sendInput('boom')).rejects.toThrow();
      const errorMessages = outputs.filter((o) => o.type === 'error');
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
      expect(errorMessages[0].content).toContain('http 500');
    });
  });
});
