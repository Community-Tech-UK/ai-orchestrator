import type { ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
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

import { CodexCliAdapter, CodexTimeoutError } from './codex-cli-adapter';
import { isRecoverableThreadResumeError } from './codex/exec-error-classifier';

// These tests drive the adapter through real PassThrough streams and real
// `setTimeout`-scheduled process output rather than fake timers, so the default
// 5s per-test timeout is borderline on slower/loaded hosts (notably Windows).
// A modest bump gives the event-loop coordination headroom without dragging the
// suite long enough to trip vitest's worker-RPC heartbeat — assertions are
// unchanged, only the deadline is relaxed.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

type MockChildProcess = Omit<ChildProcess, 'killed'> & EventEmitter & {
  emitClose: (code?: number | null, signal?: string | null) => void;
  killed: boolean;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
};

function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  // Real ChildProcess.exitCode is `null` until exit; not `undefined`.
  // Liveness checks in adapters depend on this distinction.
  (proc as unknown as { exitCode: number | null }).exitCode = null;
  (proc as unknown as { pid: number }).pid = 99999;
  proc.kill = vi.fn().mockImplementation(() => {
    proc.killed = true;
    return true;
  }) as ChildProcess['kill'];
  proc.emitClose = (code = 0, signal = null) => {
    (proc as unknown as { exitCode: number | null }).exitCode = code;
    proc.emit('close', code, signal);
  };
  return proc;
}

function queueCodexRun(
  spawnSpy: { mockReturnValueOnce(value: ChildProcess): unknown },
  options: {
    code?: number;
    stderrLines?: string[];
    stdoutLines?: string[];
  }
): MockChildProcess {
  const proc = createMockProcess();
  spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);
  setTimeout(() => {
    for (const line of options.stdoutLines || []) {
      proc.stdout.write(`${line}\n`);
    }
    proc.stdout.end();

    for (const line of options.stderrLines || []) {
      proc.stderr.write(`${line}\n`);
    }
    proc.stderr.end();

    proc.emitClose(options.code ?? 0, null);
  }, 0);
  return proc;
}

/** Collect all data written to a PassThrough stream. */
function collectStdin(proc: MockChildProcess): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

describe('CodexCliAdapter', () => {
  afterEach(() => {
    listBrowserApprovalRequestsMock.mockReset();
    listBrowserApprovalRequestsMock.mockReturnValue([]);
    vi.restoreAllMocks();
  });

  it('advertises native resume for all approval modes', () => {
    const readOnlyAdapter = new CodexCliAdapter();
    expect(readOnlyAdapter.getCapabilities().vision).toBe(true);
    expect(readOnlyAdapter.getRuntimeCapabilities().supportsResume).toBe(true);
    expect(readOnlyAdapter.getRuntimeCapabilities().supportsForkSession).toBe(false);

    const fullAutoAdapter = new CodexCliAdapter({
      approvalMode: 'full-auto',
      sandboxMode: 'workspace-write',
    });
    expect(fullAutoAdapter.getRuntimeCapabilities().supportsResume).toBe(true);
  });

  it('parses structured command execution transcripts', () => {
    const adapter = new CodexCliAdapter();
    const response = adapter.parseOutput([
      '{"type":"thread.started","thread_id":"thread-123"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/tmp/work\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"/tmp/work"}}',
      '{"type":"turn.completed","usage":{"input_tokens":42,"output_tokens":7}}',
    ].join('\n'));

    expect(response.content).toBe('/tmp/work');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0].name).toBe('command_execution');
    expect(response.toolCalls?.[0].arguments['command']).toBe('/bin/zsh -lc pwd');
    expect(response.toolCalls?.[0].result).toBe('/tmp/work\n');
    expect(response.usage).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      totalTokens: 49,
    });
    expect(response.metadata?.['threadId']).toBe('thread-123');
  });

  it('attaches a per-turn cost estimate to exec-mode usage', async () => {
    const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
    const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

    queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"thread.started","thread_id":"thread-cost"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"priced"}}',
        '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}',
      ],
    });

    const response = await adapter.sendMessage({ role: 'user', content: 'price this turn' });

    expect(response.content).toBe('priced');
    expect(response.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    });
    expect(response.usage?.cost).toBeCloseTo(0.000096, 10);
  });

  it('uses repaired exec JSONL lines for live tool-use output and keeps the turn running', async () => {
    const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
    const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    const outputs: { content: string; type: string }[] = [];
    adapter.on('output', (message) => {
      outputs.push({ content: message.content, type: message.type });
    });

    queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"item.created","item":{"type":"command_execution","command":"npm test"},}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}',
      ],
    });

    const response = await adapter.sendMessage({ role: 'user', content: 'run tests' });

    expect(response.content).toBe('done');
    expect(outputs).toContainEqual({
      type: 'tool_use',
      content: 'Running command: npm test',
    });
  });

  it('extracts Codex planning text into thinking blocks', () => {
    const adapter = new CodexCliAdapter();
    const planningMessage = `# Crafting a friendly response

I need to respond to the user saying "Hey Codex" in a natural way. I should keep it concise and friendly.
Hey! I'm here. What do you want to tackle?`;

    const response = adapter.parseOutput([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: planningMessage,
        },
      }),
    ].join('\n'));

    expect(response.thinking).toHaveLength(1);
    expect(response.thinking?.[0].content).toContain('Crafting a friendly response');
    expect(response.content).toBe(`Hey! I'm here. What do you want to tackle?`);
  });

  it('updates the native session id and resumes on subsequent turns in full-auto mode', async () => {
    const adapter = new CodexCliAdapter({
      approvalMode: 'full-auto',
      sandboxMode: 'workspace-write',
      workingDir: '/tmp/project',
    });
    const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

    queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"thread.started","thread_id":"thread-abc"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      ],
    });

    const first = await adapter.sendMessage({ role: 'user', content: 'first' });
    expect(first.content).toBe('first');
    expect(adapter.getSessionId()).toBe('thread-abc');

    const secondProc = queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"thread.started","thread_id":"thread-abc"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"second"}}',
        '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
      ],
    });
    const secondStdin = collectStdin(secondProc);

    const second = await adapter.sendMessage({ role: 'user', content: 'second' });
    expect(second.content).toBe('second');

    const firstArgs = spawnSpy.mock.calls[0][0] as string[];
    const secondArgs = spawnSpy.mock.calls[1][0] as string[];
    expect(firstArgs.slice(0, 2)).toEqual(['exec', '--json']);
    expect(firstArgs).not.toContain('resume');
    expect(secondArgs.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(secondArgs).toContain('thread-abc');

    // Prompt is now written to stdin, not passed as a positional CLI arg
    const stdinContent = await secondStdin;
    expect(stdinContent).toBe('second');
  });

  it('uses native resume on subsequent turns in read-only mode when thread id is available', async () => {
    const adapter = new CodexCliAdapter({
      approvalMode: 'suggest',
      sandboxMode: 'read-only',
      workingDir: '/tmp/project',
    });
    const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

    queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"thread.started","thread_id":"thread-readonly"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first answer"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      ],
    });

    const first = await adapter.sendMessage({ role: 'user', content: 'first question' });
    expect(first.content).toBe('first answer');
    expect(adapter.getRuntimeCapabilities().supportsResume).toBe(true);

    const secondProc = queueCodexRun(spawnSpy, {
      stdoutLines: [
        '{"type":"thread.started","thread_id":"thread-readonly"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"second answer"}}',
        '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
      ],
    });
    const secondStdin = collectStdin(secondProc);

    const second = await adapter.sendMessage({ role: 'user', content: 'second question' });
    expect(second.content).toBe('second answer');

    const firstArgs = spawnSpy.mock.calls[0][0] as string[];
    const secondArgs = spawnSpy.mock.calls[1][0] as string[];
    // First turn: regular exec
    expect(firstArgs.slice(0, 2)).toEqual(['exec', '--json']);
    expect(firstArgs).toContain('--sandbox');
    expect(firstArgs).toContain('read-only');
    // Second turn: uses resume with the thread id from the first turn
    expect(secondArgs[0]).toBe('exec');
    expect(secondArgs[1]).toBe('resume');
    expect(secondArgs).toContain('thread-readonly');

    // Prompt is just the raw message (no conversation replay or system prompt)
    const secondPrompt = await secondStdin;
    expect(secondPrompt).toBe('second question');
  });

  it('retries once when a successful run returns no assistant content', async () => {
    const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
    const executeSpy = vi.spyOn(
      adapter as unknown as {
        executePreparedMessage(message: unknown): Promise<{
          code: number | null;
          diagnostics: { fatal: boolean }[];
          raw: string;
          response: { content: string; id: string; metadata: Record<string, unknown>; role: 'assistant'; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } };
        }>;
      },
      'executePreparedMessage'
    );
    executeSpy
      .mockResolvedValueOnce({
        code: 0,
        diagnostics: [{ fatal: false }],
        raw: '',
        response: {
          id: 'resp-empty',
          role: 'assistant',
          content: '',
          metadata: {},
          usage: { inputTokens: 25, outputTokens: 0, totalTokens: 25 },
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        diagnostics: [],
        raw: '',
        response: {
          id: 'resp-recovered',
          role: 'assistant',
          content: 'recovered',
          metadata: {},
          usage: { inputTokens: 25, outputTokens: 8, totalTokens: 33 },
        },
      });

    const response = await adapter.sendMessage({ role: 'user', content: 'recover' });
    expect(response.content).toBe('recovered');
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('prepares image attachments as -i args and file attachments as prompt references', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
    try {
      const adapter = new CodexCliAdapter({ workingDir: tempDir });
      const prepared = await (adapter as unknown as {
        prepareMessage(message: {
          attachments: { content: string; mimeType: string; name: string; type: 'file' | 'image' }[];
          content: string;
          role: 'user';
        }): Promise<{ attachments?: { path?: string; type: string }[]; content: string }>;
      }).prepareMessage({
        role: 'user',
        content: 'Inspect these attachments',
        attachments: [
          {
            type: 'image',
            name: 'diagram.png',
            mimeType: 'image/png',
            content: Buffer.from('fake-image').toString('base64'),
          },
          {
            type: 'file',
            name: 'notes.txt',
            mimeType: 'text/plain',
            content: Buffer.from('hello world', 'utf-8').toString('base64'),
          },
        ],
      });

      const args = (adapter as unknown as {
        buildArgs(message: { attachments?: { path?: string; type: string }[]; content: string }): string[];
      }).buildArgs(prepared);
      expect(args).toContain('-i');

      // File attachment references are embedded in the prepared content (sent via stdin)
      expect(prepared.content).toContain('[Attached file:');
      expect(prepared.content).toContain('notes.txt');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('supports current-turn context usage and emits tool result messages', async () => {
    const adapter = new CodexCliAdapter();
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
      available: true,
      authenticated: true,
      path: 'codex',
      version: '0.107.0',
    });
    vi.spyOn(adapter, 'sendMessage').mockResolvedValue({
      id: 'resp-1',
      role: 'assistant',
      content: 'done',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'command_execution',
          arguments: { command: '/bin/zsh -lc ls' },
          result: 'README.md\n',
        },
      ],
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });

    const outputEvents: { content: string; type: string }[] = [];
    const contextEvents: { cumulativeTokens?: number; percentage: number; total: number; used: number }[] = [];

    adapter.on('output', (message) => {
      outputEvents.push({ content: message.content, type: message.type });
    });
    adapter.on('context', (usage) => {
      contextEvents.push(usage);
    });

    await adapter.spawn();
    await adapter.sendInput('Inspect these attachments');

    expect(outputEvents.some((event) => event.type === 'tool_use' && event.content.includes('Running command'))).toBe(true);
    expect(outputEvents.some((event) => event.type === 'tool_result' && event.content.includes('README.md'))).toBe(true);
    expect(outputEvents.some((event) => event.type === 'assistant' && event.content === 'done')).toBe(true);

    expect(contextEvents).toHaveLength(1);
    // Exec-mode usage from `codex exec` is aggregate across all internal
    // sub-calls — it is NOT real context-window occupancy and must not be
    // shown as such. Without a prior tokenUsage notification we have no
    // accurate occupancy, so `used` stays at 0 and the event is flagged as
    // estimated. Lifetime spend is still tracked via cumulativeTokens.
    expect(contextEvents[0].used).toBe(0);
    expect(contextEvents[0].total).toBe(200000);
    expect(contextEvents[0].percentage).toBe(0);
    expect(contextEvents[0].cumulativeTokens).toBe(100);
    expect((contextEvents[0] as { isEstimated?: boolean }).isEstimated).toBe(true);
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

  describe('silent thread-loss recovery', () => {
    // Codex evicts inactive threads server-side. When the user's next turn
    // fails because the thread is gone, the adapter should transparently
    // reopen a fresh thread and retry once — the user should see their
    // message succeed, not "restart the instance."

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

    describe('isRecoverableThreadResumeError classifier', () => {
      it('matches thread-loss phrases with thread/session context', () => {
        const classify = (msg: string): boolean =>
          isRecoverableThreadResumeError(new Error(msg));

        expect(classify('Thread does not exist')).toBe(true);
        expect(classify('thread not found: thread-abc')).toBe(true);
        expect(classify('no such thread: xyz')).toBe(true);
        expect(classify('unknown thread')).toBe(true);
        expect(classify('session expired')).toBe(true);
        expect(classify('invalid thread id')).toBe(true);
        expect(classify('missing thread')).toBe(true);
        expect(classify('thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10')).toBe(true);
      });

      it('ignores loss phrases that lack thread/session context', () => {
        const classify = (msg: string): boolean =>
          isRecoverableThreadResumeError(new Error(msg));

        // "not found" alone could be a missing file, missing config, etc. —
        // reopening the thread for those would be wrong.
        expect(classify('file not found')).toBe(false);
        expect(classify('config not found')).toBe(false);
        expect(classify('model does not exist')).toBe(false);
        expect(classify('http 500 internal server error')).toBe(false);
        expect(classify('unauthorized')).toBe(false);
      });
    });

    describe('app-server mode', () => {
      it('maps full-auto app-server threads to danger-full-access sandbox', async () => {
        const adapter = new CodexCliAdapter({
          approvalMode: 'full-auto',
          sandboxMode: 'workspace-write',
          workingDir: '/tmp/project',
        });
        const request = vi.fn().mockResolvedValue({ threadId: 'thread-full-auto' });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        }));
      });

      async function prepareAppServerAdapter(): Promise<CodexCliAdapter> {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
        (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
        (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-old';
        return adapter;
      }

      it('silently reopens the thread and retries when mid-turn fails with thread-not-found', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error('Thread does not exist: thread-old'));
        innerSpy.mockResolvedValueOnce(undefined);

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockImplementation(async () => {
          (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-new';
        });

        const statuses: string[] = [];
        adapter.on('status', (s: string) => statuses.push(s));

        // Should NOT throw — silent recovery succeeds
        await adapter.sendInput('retry me');

        expect(innerSpy).toHaveBeenCalledTimes(2);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual(['busy', 'idle']);
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-new');
      });

      it('silently reopens the thread and retries when app-server turn notifications stall', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error('Codex turn stalled: no notifications received for 90000ms'));
        innerSpy.mockResolvedValueOnce(undefined);

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockImplementation(async () => {
          (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-new-after-stall';
        });

        const statuses: string[] = [];
        adapter.on('status', (s: string) => statuses.push(s));

        await adapter.sendInput('retry me');

        expect(innerSpy).toHaveBeenCalledTimes(2);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual(['busy', 'idle']);
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-new-after-stall');
      });

      it('keeps the app-server notification watchdog alive while browser approval is pending', async () => {
        const adapter = new CodexCliAdapter({
          browserGatewayInstanceId: 'instance-1',
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        const client = {
          notificationHandler: null as ((notification: {
            method: string;
            params: Record<string, unknown>;
          }) => void) | null,
          exitPromise: neverExits,
          request: vi.fn().mockResolvedValue({
            turn: { id: 'turn-1', status: 'inProgress' },
          }),
          setNotificationHandler(handler: typeof client.notificationHandler): void {
            this.notificationHandler = handler;
          },
        };
        (adapter as unknown as { appServerClient: typeof client }).appServerClient = client;
        (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';
        listBrowserApprovalRequestsMock.mockReturnValue([
          {
            requestId: 'browser-approval-1',
            status: 'pending',
            expiresAt: Date.now() + 30 * 60 * 1000,
          },
        ]);

        const heartbeats: number[] = [];
        adapter.on('heartbeat', () => heartbeats.push(Date.now()));

        vi.useFakeTimers();
        try {
          const capturePromise = (adapter as unknown as {
            captureTurn(input: unknown[]): Promise<unknown>;
          }).captureTurn([{ type: 'text', text: 'click the button', text_elements: [] }]);
          let settled = false;
          capturePromise.then(
            () => { settled = true; },
            () => { settled = true; },
          );
          await vi.advanceTimersByTimeAsync(90_001);

          expect(settled).toBe(false);
          expect(heartbeats.length).toBeGreaterThanOrEqual(1);

          listBrowserApprovalRequestsMock.mockReturnValue([]);
          client.notificationHandler?.({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          });

          await expect(capturePromise).resolves.toMatchObject({
            completed: true,
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not retry on non-thread-loss errors (e.g. HTTP 500)', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('http 500 Internal Server Error'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );

        await expect(adapter.sendInput('boom')).rejects.toThrow(/http 500/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
      });

      it('propagates the error if reopen itself fails', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockRejectedValue(new Error('app-server crashed during reopen'));

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/app-server crashed/i);

        // We attempted exactly one turn before reopen failure aborted the retry.
        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
      });

      it('does not infinite-loop if the second turn also fails with thread-not-found', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockResolvedValue(undefined);

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread does not exist/i);

        // Exactly 2 inner attempts — no third attempt even though the second
        // also looks like a thread-loss.
        expect(innerSpy).toHaveBeenCalledTimes(2);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
      });

      it('reopenAppServerThread issues thread/start and updates thread state', async () => {
        const adapter = await prepareAppServerAdapter();
        (adapter as unknown as { systemPromptSent: boolean }).systemPromptSent = true;

        const requestSpy = vi.fn().mockResolvedValue({ threadId: 'thread-fresh' });
        (adapter as unknown as { appServerClient: { request: unknown } }).appServerClient = {
          request: requestSpy,
        };

        await (adapter as unknown as { reopenAppServerThread(): Promise<void> }).reopenAppServerThread();

        expect(requestSpy).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: expect.any(String),
          approvalPolicy: 'never',
        }));
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-fresh');
        expect((adapter as unknown as { sessionId: string }).sessionId).toBe('thread-fresh');
        // The new thread has no prior context — system prompt must re-send.
        expect((adapter as unknown as { systemPromptSent: boolean }).systemPromptSent).toBe(false);
      });

      it('records fresh fallback as an unconfirmed resume attempt', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { sessionScanner: { findSessionForWorkspace: () => Promise<null> } }).sessionScanner = {
          findSessionForWorkspace: vi.fn().mockResolvedValue(null),
        };

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            throw new Error('thread not found: thread-old');
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-old',
          actualSessionId: 'thread-fresh',
        });
      });

      it('does not substitute a thread/list candidate when explicit resume session is missing', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';
        const scanSpy = vi.fn().mockResolvedValue({
          threadId: 'thread-scanned',
          sessionFilePath: '/tmp/session.jsonl',
          workspacePath: '/tmp/project',
          timestamp: Date.now(),
        });
        (adapter as unknown as { sessionScanner: { findSessionForWorkspace: typeof scanSpy } }).sessionScanner = {
          findSessionForWorkspace: scanSpy,
        };

        const request = vi.fn().mockImplementation((method: string, params?: { threadId?: string }) => {
          if (method === 'thread/resume' && params?.threadId === 'thread-requested') {
            throw new Error('thread/resume failed: no rollout found for thread id thread-requested');
          }
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: params?.threadId });
          }
          if (method === 'thread/list') {
            return Promise.resolve({ data: [{ id: 'thread-other-workspace-candidate' }] });
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).not.toHaveBeenCalledWith('thread/list', expect.anything());
        expect(scanSpy).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalledWith('thread/resume', expect.objectContaining({
          threadId: 'thread-other-workspace-candidate',
        }));
        expect(request).not.toHaveBeenCalledWith('thread/resume', expect.objectContaining({
          threadId: 'thread-scanned',
        }));
        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: '/tmp/project',
        }));
        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-requested',
          actualSessionId: 'thread-fresh',
        });
      });

      it('starts fresh when exact thread/resume returns a different thread id', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: 'thread-other' });
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: '/tmp/project',
        }));
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-fresh');
        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-requested',
          actualSessionId: 'thread-fresh',
        });
      });

      it('abandoned init (stale epoch) discards the late client and does not clobber live state', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: 'thread-requested' });
          }
          return Promise.resolve({});
        });
        const close = vi.fn().mockResolvedValue(undefined);
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          close,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        // Simulate the live exec-mode session's state that a late init must not touch.
        const liveCursor = {
          provider: 'openai' as const,
          threadId: 'thread-live-exec',
          workspacePath: '/tmp/project',
          capturedAt: 123,
          scanSource: 'native' as const,
        };
        (adapter as unknown as { resumeCursor: unknown }).resumeCursor = liveCursor;

        // Epoch 1 was handed to this attempt, but the adapter has since moved
        // on (spawn's init budget elapsed → exec fallback bumped the epoch).
        (adapter as unknown as { appServerInitEpoch: number }).appServerInitEpoch = 2;

        await (adapter as unknown as { initAppServerMode(epoch: number): Promise<void> }).initAppServerMode(1);

        expect(close).toHaveBeenCalled();
        expect((adapter as unknown as { appServerClient?: unknown }).appServerClient).toBeFalsy();
        expect((adapter as unknown as { appServerThreadId?: unknown }).appServerThreadId).toBeFalsy();
        // Live state untouched: resume flag not consumed, cursor not overwritten,
        // attempt result not committed.
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(true);
        expect(adapter.getResumeCursor()).toEqual(liveCursor);
        expect(adapter.getResumeAttemptResult()).toBeNull();
      });
    });

    describe('exec mode', () => {
      it('maps full-auto fresh exec to danger-full-access sandbox and omits deprecated full-auto on resume', async () => {
        const adapter = new CodexCliAdapter({
          approvalMode: 'full-auto',
          sandboxMode: 'workspace-write',
          workingDir: '/tmp/project',
        });
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-full-auto"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
            '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
          ],
        });

        await adapter.sendMessage({ role: 'user', content: 'first' });

        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-full-auto"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"second"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        await adapter.sendMessage({ role: 'user', content: 'second' });

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];

        expect(firstArgs).not.toContain('--full-auto');
        expect(firstArgs).toEqual(expect.arrayContaining(['--sandbox', 'danger-full-access']));
        expect(secondArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(secondArgs).toContain('thread-full-auto');
        expect(secondArgs).not.toContain('--full-auto');
        expect(secondArgs).not.toContain('--sandbox');
      });

      it('does not retry the same stale resume command when Codex reports no rollout found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = '019de664-fb9c-7ae3-b91c-0893e58c0b10';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stderrLines: [
            'Error: thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10',
          ],
        });
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fresh-after-rollout"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"recovered"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        const outputs: { content: string; type: string }[] = [];
        adapter.on('output', (msg: { content: string; type: string }) => {
          outputs.push({ content: msg.content, type: msg.type });
        });

        await adapter.sendInput('retry me');

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(firstArgs).toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(secondArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect(secondArgs).not.toContain('resume');
        expect(secondArgs).not.toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(outputs.some((output) => output.type === 'assistant' && output.content === 'recovered')).toBe(true);
      });

      it('recovers direct sendMessage callers from stale Codex exec resume ids', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = '019de664-fb9c-7ae3-b91c-0893e58c0b10';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stderrLines: [
            'Reading prompt from stdin...',
            'Error: thread/resume: thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10 (code -32600)',
          ],
        });
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fresh-after-direct-retry"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"direct recovered"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        const response = await adapter.sendMessage({ role: 'user', content: 'retry me directly' });

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(response.content).toBe('direct recovered');
        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(firstArgs).toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(secondArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect(secondArgs).not.toContain('resume');
        expect(secondArgs).not.toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(adapter.getSessionId()).toBe('thread-fresh-after-direct-retry');
      });

      it('does not mark a thread id emitted by a failed fresh exec as resumable', async () => {
        const adapter = await spawnExecAdapter();

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-half-created"}',
          ],
          stderrLines: [
            'Reading prompt from stdin...',
          ],
        });

        await expect(
          (adapter as unknown as {
            executePreparedMessage(
              message: { role: 'user'; content: string },
              options: { timeoutMs: number; phase: 'startup' | 'turn' },
            ): Promise<unknown>;
          }).executePreparedMessage(
            { role: 'user', content: 'fresh attempt' },
            { timeoutMs: 1_000, phase: 'startup' },
          )
        // The benign "Reading prompt from stdin..." stderr notice is filtered
        // out of failure reasons; with no stdout error event the surfaced reason
        // falls back to the exit-code message.
        ).rejects.toThrow(/exited with code 1/);

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect(adapter.getSessionId()).not.toBe('thread-half-created');
      });

      it('surfaces the codex turn.failed error from stdout, not the benign stdin notice', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
          },
        });
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fail"}',
            JSON.stringify({ type: 'turn.failed', error: { message: innerError } }),
          ],
          stderrLines: ['Reading prompt from stdin...'],
        });

        // The real cause is double-encoded inside turn.failed on stdout; the only
        // stderr line is the benign stdin notice. The surfaced error must be the
        // real one, with the nested JSON unwrapped.
        await expect(
          adapter.sendMessage({ role: 'user', content: 'do work' })
        ).rejects.toThrow(/not supported when using Codex with a ChatGPT account/);
      });

      it('falls back to codex default model when the requested model is unavailable', async () => {
        const adapter = new CodexCliAdapter({ model: 'gpt-5.3-codex' });
        vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
          available: true,
          authenticated: true,
          path: 'codex',
          version: '0.137.0',
          metadata: { appServerAvailable: false },
        });
        await adapter.spawn();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: { message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account." },
        });
        // First attempt: codex rejects the routed model.
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-bad-model"}',
            JSON.stringify({ type: 'turn.failed', error: { message: innerError } }),
          ],
          stderrLines: ['Reading prompt from stdin...'],
        });
        // Fallback attempt (no --model → codex default): succeeds.
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-default"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
          ],
        });

        const res = await adapter.sendMessage({ role: 'user', content: 'do work' });
        expect(res.content).toBe('done');
        expect(spawnSpy).toHaveBeenCalledTimes(2);

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(firstArgs).toContain('--model');
        expect(firstArgs).toContain('gpt-5.3-codex');
        // Fallback omits --model so codex uses its own config.toml default.
        expect(secondArgs).not.toContain('--model');
      });

      it('escalates the idle budget startup → turn once codex emits stdout (tolerates long reasoning gaps)', async () => {
        const adapter = await spawnExecAdapter();
        // Turn budget = 2000ms; the startup budget passed below is 80ms.
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 2000;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string } }>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 80, phase: 'startup' });

        // First stdout arrives immediately → budget escalates to the 2000ms turn
        // budget. Then stay silent for 250ms — well past the 80ms startup budget.
        // Without escalation this would have been killed "during startup".
        proc.stdout.write('{"type":"thread.started","thread_id":"t1"}\n');
        await new Promise((resolve) => setTimeout(resolve, 250));
        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\n');
        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(0, null);

        const result = await exec;
        expect(result.response.content).toBe('done');
      });

      it('still fails fast during a cold start that produces no stdout', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60, phase: 'startup' });

        // Only the benign stdin notice on stderr — no stdout ever arrives, so the
        // budget never escalates and the startup watchdog fires.
        proc.stderr.write('Reading prompt from stdin...\n');

        await expect(exec).rejects.toThrow(/produced no output for 60ms during startup \(possible auth or network hang\)/);
      });

      it('returns a partial transcript on idle timeout when allowPartialOnTimeout is set', async () => {
        const adapter = await spawnExecAdapter();
        // Turn budget = 150ms; the 60ms startup budget escalates on first stdout.
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 150;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string; metadata?: Record<string, unknown> },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string; metadata?: Record<string, unknown> } }>;
        }).executePreparedMessage(
          { role: 'user', content: 'go', metadata: { allowPartialOnTimeout: true } },
          { timeoutMs: 60, phase: 'startup' },
        );

        // Codex emits a meaningful message, then stalls (never closes) → the idle
        // watchdog fires. With allowPartialOnTimeout the accumulated transcript is
        // returned instead of being discarded.
        proc.stdout.write('{"type":"thread.started","thread_id":"t1"}\n');
        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"partial progress"}}\n');

        const result = await exec;
        expect(result.response.content).toContain('partial progress');
        expect(result.response.metadata?.['timedOut']).toBe(true);
        expect(result.response.metadata?.['partial']).toBe(true);
      });

      it('still rejects on idle timeout when allowPartialOnTimeout is not set, even with output', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 150;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60, phase: 'startup' });

        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"work"}}\n');

        await expect(exec).rejects.toThrow(CodexTimeoutError);
      });

      it('clears session id and retries with fresh exec when resume fails with thread-not-found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { resumeCursor: unknown }).resumeCursor = {
          provider: 'openai',
          threadId: 'thread-old',
          workspacePath: '/tmp',
          capturedAt: Date.now(),
          scanSource: 'native',
        };

        const executeSpy = vi.spyOn(
          adapter as unknown as {
            executePreparedMessage(): Promise<{
              code: number | null;
              diagnostics: { fatal: boolean }[];
              raw: string;
              response: { content: string; id: string; metadata: Record<string, unknown>; role: 'assistant' };
            }>;
          },
          'executePreparedMessage'
        );
        executeSpy
          .mockImplementationOnce(async () => {
            // At first call, adapter still has the stale resume state.
            throw new Error('Thread does not exist: thread-old');
          })
          .mockImplementationOnce(async () => {
            // Second call: caller has cleared resume state — verify here.
            expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
            expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
            return {
              code: 0,
              diagnostics: [],
              raw: '',
              response: {
                id: 'resp-fresh',
                role: 'assistant',
                content: 'fresh',
                metadata: {},
              },
            };
          });

        const response = await adapter.sendMessage({ role: 'user', content: 'retry me' });

        expect(response.content).toBe('fresh');
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
        expect((adapter as unknown as { resumeCursor: unknown }).resumeCursor).toBeNull();
      });

      it('does not retry fatal spawn errors and surfaces an enriched message', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        setTimeout(() => {
          // Errno-shaped spawn failure as Node emits it for a missing binary.
          const err = Object.assign(new Error('spawn codex ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn codex',
          });
          proc.emit('error', err);
        }, 0);

        await expect(adapter.sendMessage({ role: 'user', content: 'go' }))
          .rejects.toThrow(/CLI binary "codex" not found on PATH/);
        // A spawn failure can never succeed on retry — exactly one attempt.
        expect(spawnSpy).toHaveBeenCalledTimes(1);
      });

      it('propagates a fatal spawn error thrown from the model-unavailable fallback attempt', async () => {
        const adapter = new CodexCliAdapter({ model: 'gpt-5.3-codex' });
        vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
          available: true,
          authenticated: true,
          path: 'codex',
          version: '0.137.0',
          metadata: { appServerAvailable: false },
        });
        await adapter.spawn();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        // First attempt: codex rejects the routed model → sendMessage retries
        // once with --model omitted.
        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: { message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account." },
        });
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [JSON.stringify({ type: 'turn.failed', error: { message: innerError } })],
          stderrLines: ['Reading prompt from stdin...'],
        });
        // Fallback attempt: the spawn itself fails fatally — must propagate
        // enriched, not be swallowed or retried again.
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);
        setTimeout(() => {
          proc.emit('error', Object.assign(new Error('spawn codex ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn codex',
          }));
        }, 0);

        await expect(adapter.sendMessage({ role: 'user', content: 'go' }))
          .rejects.toThrow(/CLI binary "codex" not found on PATH/);
        expect(spawnSpy).toHaveBeenCalledTimes(2);
      });

      it('kills the turn at the absolute deadline even while codex keeps producing output', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 250;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 100, phase: 'startup' });

        // Keep the process chatty so the idle watchdog never fires — only the
        // absolute deadline can kill this turn.
        const writer = setInterval(() => proc.stdout.write('{"type":"item.started"}\n'), 25);
        const err = await exec.then(() => null, (e: unknown) => e);
        clearInterval(writer);

        expect(err).toBeInstanceOf(CodexTimeoutError);
        expect((err as CodexTimeoutError).kind).toBe('deadline');
        expect((err as CodexTimeoutError).message).toMatch(/exceeded its total deadline of 250ms/);
        expect((err as CodexTimeoutError).message).toMatch(/consider raising the configured timeout/);
      });

      it('returns a partial transcript when the deadline fires and allowPartialOnTimeout is set', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 250;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string; metadata?: Record<string, unknown> },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string; metadata?: Record<string, unknown> } }>;
        }).executePreparedMessage(
          { role: 'user', content: 'go', metadata: { allowPartialOnTimeout: true } },
          { timeoutMs: 100, phase: 'startup' },
        );

        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"deadline progress"}}\n');
        const writer = setInterval(() => proc.stdout.write('{"type":"item.started"}\n', () => { /* keep alive */ }), 25);
        const result = await exec;
        clearInterval(writer);

        expect(result.response.content).toContain('deadline progress');
        expect(result.response.metadata?.['timedOut']).toBe(true);
        expect(result.response.metadata?.['partial']).toBe(true);
        expect(result.response.metadata?.['timeoutKind']).toBe('deadline');
      });

      it('clears the idle, deadline, and liveness timers when the process closes cleanly', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 120_000;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        vi.useFakeTimers();
        try {
          const exec = (adapter as unknown as {
            executePreparedMessage(
              message: { role: 'user'; content: string },
              options: { timeoutMs: number; phase: 'startup' | 'turn' },
            ): Promise<{ response: { content: string } }>;
          }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60_000, phase: 'turn' });

          proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\n');
          proc.stdout.end();
          proc.stderr.end();
          proc.emitClose(0, null);
          await vi.advanceTimersByTimeAsync(1);

          const result = await exec;
          expect(result.response.content).toBe('done');
          // Idle, deadline, and liveness timers must all be gone — a stale
          // watchdog would terminate an unrelated successor process.
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('surfaces the real error from an unterminated final stderr chunk, not the stdin banner', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 5_000, phase: 'startup' });

        // Banner + real error in one chunk, with NO trailing newline — the
        // error line lands in the unterminated remainder processed at close.
        proc.stderr.write('Reading prompt from stdin...\nError: thread/resume failed: no rollout found for thread id abc');
        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(1, null);

        const err = await exec.then(() => null, (e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('no rollout found for thread id abc');
        expect((err as Error).message).not.toContain('Reading prompt from stdin');
      });

      it('does not retry on non-thread-loss errors in exec mode', async () => {
        const adapter = await spawnExecAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { execSendMessageInner(m: string, a?: unknown): Promise<void> },
          'execSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('http 500 Internal Server Error'));

        await expect(adapter.sendInput('boom')).rejects.toThrow(/http 500/i);
        expect(innerSpy).toHaveBeenCalledTimes(1);
      });

      it('does not infinite-loop if fresh exec also fails with thread-not-found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const executeSpy = vi.spyOn(
          adapter as unknown as { executePreparedMessage(): Promise<unknown> },
          'executePreparedMessage'
        );
        executeSpy.mockRejectedValue(new Error('Thread does not exist'));

        await expect(adapter.sendMessage({ role: 'user', content: 'retry me' })).rejects.toThrow(/thread does not exist/i);

        expect(executeSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('getAdapterCapabilities (AdapterCapabilities)', () => {
    it('returns non-resident capabilities in exec (one-shot) mode', () => {
      const adapter = new CodexCliAdapter();
      const caps = adapter.getAdapterCapabilities();
      expect(caps.residentSession).toBe(false);
      expect(caps.liveInterrupt).toBe(false);
      expect(caps.liveSteer).toBe(false);
    });

    it('returns resident capabilities when in app-server mode', () => {
      const adapter = new CodexCliAdapter();
      (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
      const caps = adapter.getAdapterCapabilities();
      expect(caps.residentSession).toBe(true);
      expect(caps.liveInterrupt).toBe(true);
      expect(caps.liveSteer).toBe(true);
    });
  });
});
