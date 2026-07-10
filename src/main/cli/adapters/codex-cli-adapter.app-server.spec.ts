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
import { createMockProcess } from './codex-cli-adapter.test-helpers';

// These tests drive the adapter through real PassThrough streams and real
// `setTimeout`-scheduled process output rather than fake timers, so the default
// 5s per-test timeout is borderline on slower/loaded hosts (notably Windows).
// A modest bump gives the event-loop coordination headroom without dragging the
// suite long enough to trip vitest's worker-RPC heartbeat — assertions are
// unchanged, only the deadline is relaxed.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

describe('CodexCliAdapter', () => {
  afterEach(() => {
    listBrowserApprovalRequestsMock.mockReset();
    listBrowserApprovalRequestsMock.mockReturnValue([]);
    vi.restoreAllMocks();
  });

  // ─── New tests for app-server hardening (Phase 2/3) ────────────────

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
