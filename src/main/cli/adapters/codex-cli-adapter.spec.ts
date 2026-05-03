import type { ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';

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

    it('extends app-server active-item idle watchdog to the configured turn timeout', () => {
      const adapter = new CodexCliAdapter({ timeout: 900_000 });

      expect((adapter as unknown as {
        resolveNotificationIdleTimeoutMs(activeItems: number): number;
        resolveTurnIdleTimeoutMs(): number;
      }).resolveTurnIdleTimeoutMs()).toBe(900_000);
      expect((adapter as unknown as {
        resolveNotificationIdleTimeoutMs(activeItems: number): number;
      }).resolveNotificationIdleTimeoutMs(0)).toBe(900_000);
      expect((adapter as unknown as {
        resolveNotificationIdleTimeoutMs(activeItems: number): number;
      }).resolveNotificationIdleTimeoutMs(1)).toBe(900_000);
    });
  });

  describe('interrupt behavior', () => {
    it('returns already-idle (falls back to SIGINT) when not in app-server mode', () => {
      const adapter = new CodexCliAdapter();
      // No process running, so interrupt reports no active process.
      const result = adapter.interrupt();
      expect(result.status).toBe('already-idle');
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

      // Mock prepareCleanCodexHome for exec fallback
      vi.spyOn(
        adapter as unknown as { prepareCleanCodexHome(): void },
        'prepareCleanCodexHome'
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
        const adapter = new CodexCliAdapter();
        const classify = (msg: string): boolean =>
          (adapter as unknown as { isRecoverableThreadResumeError(e: unknown): boolean })
            .isRecoverableThreadResumeError(new Error(msg));

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
        const adapter = new CodexCliAdapter();
        const classify = (msg: string): boolean =>
          (adapter as unknown as { isRecoverableThreadResumeError(e: unknown): boolean })
            .isRecoverableThreadResumeError(new Error(msg));

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
    });

    describe('exec mode', () => {
      it('maps full-auto fresh exec to workspace-write sandbox and omits deprecated full-auto on resume', async () => {
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
        expect(firstArgs).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
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

        const innerSpy = vi.spyOn(
          adapter as unknown as { execSendMessageInner(m: string, a?: unknown): Promise<void> },
          'execSendMessageInner'
        );
        innerSpy
          .mockImplementationOnce(async () => {
            // At first call, adapter still has the stale resume state.
            throw new Error('Thread does not exist: thread-old');
          })
          .mockImplementationOnce(async () => {
            // Second call: caller has cleared resume state — verify here.
            expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
            expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
          });

        await adapter.sendInput('retry me');

        expect(innerSpy).toHaveBeenCalledTimes(2);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
        expect((adapter as unknown as { resumeCursor: unknown }).resumeCursor).toBeNull();
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

        const innerSpy = vi.spyOn(
          adapter as unknown as { execSendMessageInner(m: string, a?: unknown): Promise<void> },
          'execSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist'));

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread does not exist/i);

        expect(innerSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
