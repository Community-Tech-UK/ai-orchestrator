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
  proc.kill = vi.fn().mockImplementation(() => {
    proc.killed = true;
    return true;
  }) as ChildProcess['kill'];
  proc.emitClose = (code = 0, signal = null) => {
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

  describe('interrupt behavior', () => {
    it('returns false (falls back to SIGINT) when not in app-server mode', () => {
      const adapter = new CodexCliAdapter();
      // No process running, so interrupt returns false
      const result = adapter.interrupt();
      expect(result).toBe(false);
    });
  });

  describe('app-server init timeout', () => {
    it('falls back to exec mode when app-server init times out', async () => {
      const adapter = new CodexCliAdapter();

      // Mock checkStatus to report app-server available
      vi.spyOn(adapter as any, 'checkStatus').mockResolvedValue({
        available: true,
        metadata: { appServerAvailable: true },
      });

      // Mock initAppServerMode to hang forever (never resolve)
      vi.spyOn(adapter as any, 'initAppServerMode').mockReturnValue(new Promise(() => {}));

      // Mock prepareCleanCodexHome for exec fallback
      vi.spyOn(adapter as any, 'prepareCleanCodexHome').mockReturnValue(undefined);

      // Use fake timers to advance past the 30s timeout
      vi.useFakeTimers();
      const spawnPromise = adapter.spawn();
      await vi.advanceTimersByTimeAsync(31_000);
      const pid = await spawnPromise;
      vi.useRealTimers();

      expect(pid).toBeGreaterThan(0);
      expect((adapter as any).useAppServer).toBe(false);
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
});
