import type { ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
import {
  collectStdin,
  queueCodexRun,
} from './codex-cli-adapter.test-helpers';

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

  describe('getLastContextUsage (WS4 truthful occupancy)', () => {
    it('exec mode reports unknown: aggregate-only — cumulative totals cannot prove occupancy', () => {
      const adapter = new CodexCliAdapter();
      // Even with turn tokens tracked, exec mode has no per-turn occupancy proof.
      (adapter as unknown as { lastTurnTokens: number }).lastTurnTokens = 7_000_000;
      expect(adapter.getLastContextUsage()).toEqual({ status: 'unknown', reason: 'aggregate-only' });
    });
  });
});
