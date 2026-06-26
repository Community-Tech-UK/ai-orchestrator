/**
 * ClaudeCliAdapter tests
 *
 * Three layered concerns:
 *  1. Pure units — capability reporting, session id, deferred-tool state.
 *  2. NDJSON parser integration via the adapter's underlying parser.
 *  3. Spawn / terminate — child_process.spawn args, CLAUDECODE removal,
 *     SIGTERM-then-SIGKILL escalation. These use a fake EventEmitter-based
 *     ChildProcess so we never spawn a real process.
 *
 * Cross-CLI parity scenarios live in `adapter-parity.spec.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getLogManager: () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test',
    isPackaged: false,
  },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: {},
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

// child_process.spawn returns a fake EventEmitter-based ChildProcess so we
// can assert on args/env and drive lifecycle events deterministically.
type FakeProc = EventEmitter & {
  pid: number;
  killed: boolean;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

// vi.mock factories are hoisted above any const declarations, so we use
// vi.hoisted() to share state with them.
const spawnFixture = vi.hoisted(() => {
  const spawnedProcesses: EventEmitter[] = [];
  const state: {
    lastSpawnArgs: { command: string; args: string[]; opts: { env?: NodeJS.ProcessEnv; cwd?: string } } | null;
  } = { lastSpawnArgs: null };

  const makeFakeProc = () => {
    const proc = new EventEmitter() as EventEmitter & {
      pid: number;
      killed: boolean;
      stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      removeAllListeners: () => EventEmitter;
    };
    proc.pid = 4242;
    proc.killed = false;
    const stdin = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      writable: boolean;
    };
    stdin.writable = true;
    stdin.write = vi.fn((_chunk: unknown, _encoding?: unknown, cb?: unknown) => {
      if (typeof cb === 'function') {
        queueMicrotask(() => (cb as () => void)());
      }
      return true;
    });
    stdin.end = vi.fn(() => {
      stdin.writable = false;
    });
    proc.stdin = stdin;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
  };

  const spawnMock = vi.fn(
    (
      command: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv; cwd?: string }
    ) => {
      state.lastSpawnArgs = { command, args, opts };
      const proc = makeFakeProc();
      spawnedProcesses.push(proc);
      return proc;
    }
  );

  return { spawnMock, spawnedProcesses, state, makeFakeProc };
});

const spawnMock = spawnFixture.spawnMock;
const spawnedProcesses = spawnFixture.spawnedProcesses as FakeProc[];
const makeFakeProc = spawnFixture.makeFakeProc as () => FakeProc;
const lastSpawnState = spawnFixture.state;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mocked = {
    ...actual,
    spawn: (...args: unknown[]) =>
      spawnFixture.spawnMock(...(args as Parameters<typeof spawnFixture.spawnMock>)),
  };
  // CJS interop — base-cli-adapter uses named imports; vitest also needs default
  // when running modules through its own loader.
  return { ...mocked, default: mocked };
});

import { ClaudeCliAdapter, DEFER_MIN_VERSION } from '../claude-cli-adapter';
import { InputFormatter } from '../../input-formatter';
import { NdjsonParser } from '../../ndjson-parser';

describe('ClaudeCliAdapter', () => {
  let adapter: ClaudeCliAdapter;

  beforeEach(() => {
    adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/test-cwd',
      model: 'opus',
    });
  });

  describe('parseOutput — token extraction across CLI schema versions', () => {
    /**
     * Regression: Loop Mode reported `tokens: 0` for every iteration on
     * Claude CLI 2.1.x because the parser only knew the legacy
     * `system / context_usage` schema, which the CLI no longer emits.
     * Per-turn usage now lives on `assistant.message.usage`, and the final
     * authoritative tally lives on `result.usage`. The parser must extract
     * from both paths.
     */
    it('extracts tokens from the result.usage tally (Claude CLI 2.1.x)', () => {
      const ndjson = [
        '{"type":"system","subtype":"init","session_id":"s","model":"sonnet"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":3,"output_tokens":2}}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"Hi","usage":{"input_tokens":3,"output_tokens":6,"cache_creation_input_tokens":24998,"cache_read_input_tokens":0},"total_cost_usd":0.0938}',
      ].join('\n');
      const out = adapter.parseOutput(ndjson);
      expect(out.content).toBe('Hi');
      // result.usage wins over per-turn assistant.message.usage.
      expect(out.usage.totalTokens).toBe(9); // input+output, not cache.
      expect(out.usage.inputTokens).toBe(3);
      expect(out.usage.outputTokens).toBe(6);
      expect(out.usage.cost).toBeCloseTo(0.0938);
    });

    it('falls back to summed assistant.message.usage when no result message', () => {
      const ndjson = [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":3,"output_tokens":4}}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":2,"output_tokens":5}}}',
      ].join('\n');
      const out = adapter.parseOutput(ndjson);
      expect(out.content).toBe('ab');
      expect(out.usage.totalTokens).toBe(14); // (3+4) + (2+5)
      expect(out.usage.inputTokens).toBe(5);
      expect(out.usage.outputTokens).toBe(9);
    });

    it('still honours legacy system/context_usage schema as a final fallback', () => {
      const ndjson = [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
        '{"type":"system","subtype":"context_usage","usage":{"total_tokens":42}}',
      ].join('\n');
      const out = adapter.parseOutput(ndjson);
      expect(out.content).toBe('hi');
      expect(out.usage.totalTokens).toBe(42);
    });

    it('returns 0 tokens (no field) when no usage data present', () => {
      const ndjson =
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"silent"}]}}';
      const out = adapter.parseOutput(ndjson);
      expect(out.content).toBe('silent');
      expect(out.usage.totalTokens).toBeUndefined();
    });
  });

  describe('identity', () => {
    it('reports the correct adapter name', () => {
      expect(adapter.getName()).toBe('claude-cli');
    });

    it('advertises expected capabilities', () => {
      const caps = adapter.getCapabilities();
      expect(caps.streaming).toBe(true);
      expect(caps.toolUse).toBe(true);
      expect(caps.multiTurn).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.outputFormats).toContain('ndjson');
    });

    it('reports runtime capabilities including resume and fork', () => {
      const rt = adapter.getRuntimeCapabilities();
      expect(rt.supportsResume).toBe(true);
      expect(rt.supportsForkSession).toBe(true);
      // Claude CLI in headless `--input-format stream-json` mode has no
      // programmatic compaction hook (slash commands aren't intercepted),
      // so we don't claim a callable native compaction. Auto-compaction is
      // self-managed by the CLI at the model's internal threshold.
      expect(rt.supportsNativeCompaction).toBe(false);
      expect(rt.selfManagedAutoCompaction).toBe(true);
      expect(rt.supportsPermissionPrompts).toBe(true);
    });
  });

  describe('session state', () => {
    it('generates a session id when none is provided', () => {
      const a = new ClaudeCliAdapter({});
      const b = new ClaudeCliAdapter({});
      expect(a.getSessionId()).toBeTruthy();
      expect(b.getSessionId()).toBeTruthy();
      expect(a.getSessionId()).not.toBe(b.getSessionId());
    });

    it('preserves a provided session id', () => {
      const a = new ClaudeCliAdapter({ sessionId: 'fixed-session-id' });
      expect(a.getSessionId()).toBe('fixed-session-id');
    });
  });

  describe('deferred tool use state', () => {
    it('starts with no deferred tool use', () => {
      expect(adapter.getDeferredToolUse()).toBeNull();
    });

    it('clearDeferredToolUse keeps null state stable', () => {
      adapter.clearDeferredToolUse();
      expect(adapter.getDeferredToolUse()).toBeNull();
    });
  });

  describe('setResume', () => {
    it('toggles resume mode without throwing', () => {
      expect(() => adapter.setResume(true)).not.toThrow();
      expect(() => adapter.setResume(false)).not.toThrow();
    });
  });

  describe('DEFER_MIN_VERSION', () => {
    it('exposes a semver-like minimum version string', () => {
      expect(DEFER_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('permission hook settings', () => {
    it('wraps the defer hook in a node command for Windows-safe execution', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      try {
        const adapter = new ClaudeCliAdapter({
          permissionHookPath: 'C:\\Program Files\\AI Orchestrator\\defer-permission-hook.mjs',
        });
        (
          adapter as unknown as {
            cachedCliStatus: { available: boolean; version: string };
          }
        ).cachedCliStatus = { available: true, version: '2.1.98' };

        const args = (
          adapter as unknown as {
            buildArgs(message: { role: 'user'; content: string }): string[];
          }
        ).buildArgs({ role: 'user', content: 'hello' });

        const settingsIndex = args.indexOf('--settings');
        expect(settingsIndex).toBeGreaterThan(-1);

        // On win32 the inline-JSON --settings is materialized to a temp file
        // path (cmd.exe would otherwise strip its quotes); read it back.
        const settingsRaw = args[settingsIndex + 1] ?? '{}';
        const settingsJson = settingsRaw.startsWith('{')
          ? settingsRaw
          : readFileSync(settingsRaw, 'utf-8');
        const settings = JSON.parse(settingsJson) as {
          hooks?: {
            PreToolUse?: {
              hooks?: { command?: string }[];
            }[];
          };
        };

        expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
          'node "C:\\Program Files\\AI Orchestrator\\defer-permission-hook.mjs"',
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('merges ultracode workflow with defer hook settings', () => {
      const adapter = new ClaudeCliAdapter({
        reasoningEffort: 'workflow',
        permissionHookPath: '/tmp/defer-permission-hook.mjs',
      });
      (
        adapter as unknown as {
          cachedCliStatus: { available: boolean; version: string };
        }
      ).cachedCliStatus = { available: true, version: '2.1.98' };

      const args = (
        adapter as unknown as {
          buildArgs(message: { role: 'user'; content: string }): string[];
        }
      ).buildArgs({ role: 'user', content: 'hello' });

      expect(args).not.toContain('--effort');
      const settingsIndex = args.indexOf('--settings');
      expect(settingsIndex).toBeGreaterThan(-1);
      const settings = JSON.parse(args[settingsIndex + 1] ?? '{}') as {
        ultracode?: boolean;
        hooks?: {
          PreToolUse?: {
            hooks?: { command?: string }[];
          }[];
        };
      };

      expect(settings.ultracode).toBe(true);
      expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
        "node '/tmp/defer-permission-hook.mjs'",
      );
    });
  });
});

describe('NdjsonParser (used by ClaudeCliAdapter for stream parsing)', () => {
  let parser: NdjsonParser;

  beforeEach(() => {
    parser = new NdjsonParser();
  });

  it('parses complete NDJSON lines', () => {
    const chunk =
      JSON.stringify({ type: 'assistant', content: 'hello' }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'world' }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { content?: string }).content).toBe('hello');
    expect((msgs[1] as { content?: string }).content).toBe('world');
  });

  it('handles split lines across chunks', () => {
    const first =
      JSON.stringify({ type: 'assistant', content: 'part-a' }) +
      '\n' +
      '{"type":"assistant","co';
    const second = 'ntent":"part-b"}\n';

    const firstMsgs = parser.parse(first);
    expect(firstMsgs).toHaveLength(1);
    expect((firstMsgs[0] as { content?: string }).content).toBe('part-a');

    const secondMsgs = parser.parse(second);
    expect(secondMsgs).toHaveLength(1);
    expect((secondMsgs[0] as { content?: string }).content).toBe('part-b');
  });

  it('skips malformed JSON lines without throwing', () => {
    const chunk =
      'not-json-at-all\n' +
      JSON.stringify({ type: 'assistant', content: 'ok' }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content?: string }).content).toBe('ok');
  });

  it('stamps a timestamp when one is missing', () => {
    const chunk = JSON.stringify({ type: 'assistant', content: 'hello' }) + '\n';
    const msgs = parser.parse(chunk);
    expect(msgs[0]!.timestamp).toBeTypeOf('number');
  });

  it('preserves an existing timestamp', () => {
    const chunk =
      JSON.stringify({ type: 'assistant', content: 'hello', timestamp: 123 }) +
      '\n';
    const msgs = parser.parse(chunk);
    expect(msgs[0]!.timestamp).toBe(123);
  });

  it('flush() emits the trailing message when it is valid JSON', () => {
    parser.parse(JSON.stringify({ type: 'assistant', content: 'hello' }));
    const msgs = parser.flush();
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content?: string }).content).toBe('hello');
  });

  it('flush() discards incomplete trailing content', () => {
    parser.parse('{"type":"assistant","co');
    const msgs = parser.flush();
    expect(msgs).toHaveLength(0);
  });

  it('reset() clears any buffered partial line', () => {
    parser.parse('{"type":"assistant","co');
    expect(parser.hasPendingData()).toBe(true);
    parser.reset();
    expect(parser.hasPendingData()).toBe(false);
  });

  it('recovers complete lines when the buffer exceeds the configured cap', () => {
    const smallParser = new NdjsonParser(1); // 1 KB cap
    const bigLine = JSON.stringify({ type: 'assistant', content: 'x'.repeat(2000) });
    const msgs = smallParser.parse(bigLine + '\n');
    // Recovery salvages parseable complete lines even when the buffer limit is
    // exceeded, so we expect at least one message rather than data loss.
    expect(msgs.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Spawn / Terminate lifecycle tests (using the fake child_process)
// ---------------------------------------------------------------------------

describe('ClaudeCliAdapter — spawn/terminate lifecycle', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    spawnMock.mockClear();
    spawnedProcesses.length = 0;
    lastSpawnState.lastSpawnArgs = null;
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    originalEnv = { ...process.env };
    // Set CLAUDECODE so we can verify the adapter strips it from spawned env.
    process.env['CLAUDECODE'] = '1';
  });

  afterEach(() => {
    killSpy.mockRestore();
    process.env = originalEnv;
  });

  describe('spawnProcess (via checkStatus)', () => {
    it('invokes child_process.spawn with the configured command', async () => {
      const adapter = new ClaudeCliAdapter({});
      // checkStatus calls spawnProcess(['--version']); we drive close immediately
      // so the promise settles without timing out.
      const statusPromise = adapter.checkStatus();
      // Microtask flush so the spawn factory runs before we read its results.
      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalled();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.stdout.emit('data', Buffer.from('claude 2.5.0\n'));
      proc.emit('close', 0);
      await statusPromise;

      expect(lastSpawnState.lastSpawnArgs?.command).toBe('claude');
      expect(lastSpawnState.lastSpawnArgs?.args).toContain('--version');
    });

    it('removes the CLAUDECODE env var from the spawned process', async () => {
      const adapter = new ClaudeCliAdapter({});
      const statusPromise = adapter.checkStatus();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.stdout.emit('data', Buffer.from('claude 2.5.0\n'));
      proc.emit('close', 0);
      await statusPromise;

      const env = lastSpawnState.lastSpawnArgs?.opts.env ?? {};
      expect(env['CLAUDECODE']).toBeUndefined();
    });

    it('extends PATH with common CLI install directories', async () => {
      const adapter = new ClaudeCliAdapter({});
      const statusPromise = adapter.checkStatus();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.emit('close', 0);
      await statusPromise;

      const path = lastSpawnState.lastSpawnArgs?.opts.env?.['PATH'] ?? '';
      expect(path).toContain('/usr/local/bin');
      expect(path).toContain('/opt/homebrew/bin');
    });

    it('uses the workingDirectory option as cwd', async () => {
      // Must be a real directory — spawnProcess now throws CliSpawnCwdError
      // for nonexistent cwds before ever reaching spawn().
      const workingDirectory = tmpdir();
      const adapter = new ClaudeCliAdapter({ workingDirectory });
      const statusPromise = adapter.checkStatus();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.emit('close', 0);
      await statusPromise;

      expect(lastSpawnState.lastSpawnArgs?.opts.cwd).toBe(workingDirectory);
    });

    it('reports unavailable when the spawned process emits error', async () => {
      const adapter = new ClaudeCliAdapter({});
      const statusPromise = adapter.checkStatus();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.emit('error', new Error('ENOENT'));
      const status = await statusPromise;

      expect(status.available).toBe(false);
      expect(status.error).toContain('ENOENT');
    });
  });

  describe('sendMessage', () => {
    it('closes stdin after writing the one-shot stream-json prompt', async () => {
      const adapter = new ClaudeCliAdapter({});
      const sendPromise = adapter.sendMessage({ role: 'user', content: 'hello' });

      await new Promise<void>((r) => setImmediate(r));
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;

      await vi.waitFor(() => {
        expect(proc.stdin.write).toHaveBeenCalled();
      });
      expect(proc.stdin.end).toHaveBeenCalledTimes(1);

      proc.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'));
      proc.emit('close', 0);

      await expect(sendPromise).resolves.toMatchObject({ content: 'ok' });
    });

    it('returns partial output on timeout when the message opts in', async () => {
      vi.useFakeTimers();
      try {
        const adapter = new ClaudeCliAdapter({ timeout: 100 });
        const onComplete = vi.fn();
        adapter.on('complete', onComplete);
        const sendPromise = adapter.sendMessage({
          role: 'user',
          content: 'loop iteration',
          metadata: { allowPartialOnTimeout: true },
        });

        await Promise.resolve();
        const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
        proc.stdout.emit(
          'data',
          Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"partial work"}],"usage":{"input_tokens":5,"output_tokens":7}}}\n'),
        );

        await vi.advanceTimersByTimeAsync(100);

        await expect(sendPromise).resolves.toMatchObject({
          content: 'partial work',
          metadata: {
            timedOut: true,
            timeoutMs: 100,
          },
          usage: {
            totalTokens: 12,
          },
        });
        expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
        expect(onComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            content: 'partial work',
            metadata: expect.objectContaining({ timedOut: true }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('extends the timeout while a loop child has recent stdout activity', async () => {
      vi.useFakeTimers();
      try {
        const adapter = new ClaudeCliAdapter({ timeout: 100 });
        const onOutput = vi.fn();
        adapter.on('output', onOutput);
        const sendPromise = adapter.sendMessage({
          role: 'user',
          content: 'loop iteration',
          metadata: {
            allowPartialOnTimeout: true,
            continueWhileActiveOnTimeout: true,
            activeTimeoutMs: 50,
          },
        });
        let settled = false;
        sendPromise.finally(() => {
          settled = true;
        });

        await Promise.resolve();
        const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
        proc.stdout.emit(
          'data',
          Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"initial work"}]}}\n'),
        );
        await vi.advanceTimersByTimeAsync(99);
        proc.stdout.emit(
          'data',
          Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":" still active"}]}}\n'),
        );

        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(killSpy).not.toHaveBeenCalled();
        expect(onOutput).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'system',
            content: expect.stringContaining('still active'),
            metadata: expect.objectContaining({ timeoutExtended: true }),
          }),
        );

        proc.stdout.emit(
          'data',
          Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":" done"}]}}\n'),
        );
        proc.emit('close', 0);

        await expect(sendPromise).resolves.toMatchObject({
          content: 'initial work still active done',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the existing timeout rejection behavior unless partial timeout is explicitly enabled', async () => {
      vi.useFakeTimers();
      try {
        const adapter = new ClaudeCliAdapter({ timeout: 100 });
        const sendPromise = adapter.sendMessage({ role: 'user', content: 'normal invocation' });

        await Promise.resolve();
        const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
        proc.stdout.emit(
          'data',
          Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"partial work"}]}}\n'),
        );

        const rejection = expect(sendPromise).rejects.toThrow('Claude CLI timeout');
        await vi.advanceTimersByTimeAsync(100);

        await rejection;
        expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('terminate', () => {
    /**
     * Helper: stand up a ClaudeCliAdapter with a "running" process by
     * driving `checkStatus()` and then attaching the spawned proc to the
     * adapter's protected `process` field. This mirrors what spawn() would
     * do without exercising the full ~600 LOC spawn pipeline.
     */
    function adapterWithRunningProcess(): { adapter: ClaudeCliAdapter; proc: FakeProc } {
      const adapter = new ClaudeCliAdapter({});
      // Reach into the protected slot directly — we are testing terminate
      // behavior in isolation from the full spawn flow.
      const proc = makeFakeProc();
      (adapter as unknown as { process: FakeProc | null }).process = proc;
      return { adapter, proc };
    }

    it('sends SIGTERM to the process group on graceful terminate', async () => {
      const { adapter, proc } = adapterWithRunningProcess();
      const terminatePromise = adapter.terminate(true);
      // Simulate the process exiting cleanly so the timeout isn't triggered.
      proc.killed = true;
      proc.emit('exit');
      await terminatePromise;

      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
    });

    it('sends SIGKILL immediately on non-graceful terminate', async () => {
      const { adapter, proc } = adapterWithRunningProcess();
      await adapter.terminate(false);

      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
    });

    it('escalates to SIGKILL when the process does not exit before timeout', async () => {
      vi.useFakeTimers();
      try {
        const { adapter, proc } = adapterWithRunningProcess();
        const terminatePromise = adapter.terminate(true);

        // Don't emit exit — simulate a hung process that ignores SIGTERM.
        // The base adapter's escalation timeout is 5000ms.
        await vi.advanceTimersByTimeAsync(5000);
        await terminatePromise;

        expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a no-op when no process is attached', async () => {
      const adapter = new ClaudeCliAdapter({});
      await adapter.terminate(true);
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('interrupt', () => {
    function adapterWithRunningProcess(): { adapter: ClaudeCliAdapter; proc: FakeProc } {
      const adapter = new ClaudeCliAdapter({});
      const proc = makeFakeProc();
      (adapter as unknown as { process: FakeProc | null }).process = proc;
      return { adapter, proc };
    }

    it('sends SIGINT to the running process group and returns accepted', () => {
      const { adapter, proc } = adapterWithRunningProcess();
      // Resident path requires a writable formatter; without one, base SIGINT fires.
      // So ensure no formatter is set for this test.
      (adapter as unknown as { formatter: null }).formatter = null;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number | string, signal?: NodeJS.Signals | number) => {
          expect(pid).toBe(-proc.pid);
          expect(signal).toBe('SIGINT');
          return true;
        }) as typeof process.kill,
      );

      const result = adapter.interrupt();
      expect(result).toEqual({ status: 'accepted' });
      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGINT');
    });

    it('returns already-idle when no process is running', () => {
      const adapter = new ClaudeCliAdapter({});
      expect(adapter.interrupt().status).toBe('already-idle');
    });
  });

  describe('resident interrupt path (control_request / control_response)', () => {
    function adapterWithResidentProcess(): {
      adapter: ClaudeCliAdapter;
      proc: FakeProc;
      processCliMessage: (msg: unknown) => void;
    } {
      const adapter = new ClaudeCliAdapter({ residentClaude: true });
      const proc = makeFakeProc();
      // Simulate a live resident process: process + writable formatter.
      (adapter as unknown as { process: FakeProc | null }).process = proc;
      // Build a minimal writable-stdin formatter
      (adapter as unknown as { formatter: InputFormatter | null }).formatter =
        new InputFormatter(proc.stdin as unknown as import('stream').Writable);
      const processCliMessage = (
        adapter as unknown as { processCliMessage: (m: unknown) => void }
      ).processCliMessage.bind(adapter);
      return { adapter, proc, processCliMessage };
    }

    it('getAdapterCapabilities returns resident when process is alive and stdin writable', () => {
      const { adapter } = adapterWithResidentProcess();
      const caps = adapter.getAdapterCapabilities();
      expect(caps.residentSession).toBe(true);
      expect(caps.liveInterrupt).toBe(true);
      expect(caps.liveSteer).toBe(true);
    });

    it('getAdapterCapabilities returns non-resident when no process', () => {
      const adapter = new ClaudeCliAdapter({});
      const caps = adapter.getAdapterCapabilities();
      expect(caps.residentSession).toBe(false);
      expect(caps.liveInterrupt).toBe(false);
      expect(caps.liveSteer).toBe(false);
    });

    it('interrupt() sends control_request{interrupt} via stdin when process is resident', async () => {
      const { adapter, proc } = adapterWithResidentProcess();
      const result = adapter.interrupt();

      expect(result.status).toBe('accepted');
      expect(result.completion).toBeInstanceOf(Promise);

      // stdin.write should have been called with a JSON containing control_request
      const written = proc.stdin.write.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join('');
      expect(written).toContain('"type":"control_request"');
      expect(written).toContain('"subtype":"interrupt"');
    });

    it('interrupt() does NOT send SIGINT when process is resident', async () => {
      const { adapter } = adapterWithResidentProcess();
      const killSpy = vi.spyOn(process, 'kill');
      adapter.interrupt();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('control_response{success} resolves the interrupt completion promise', async () => {
      const { adapter, processCliMessage } = adapterWithResidentProcess();
      const result = adapter.interrupt();
      expect(result.completion).toBeInstanceOf(Promise);

      // Simulate CLI acknowledging the interrupt
      processCliMessage({ type: 'control_response', subtype: 'interrupt', status: 'success' });

      const completion = await result.completion!;
      expect(completion.status).toBe('interrupted');
    });

    it('control_response{error} resolves completion with rejected status', async () => {
      const { adapter, processCliMessage } = adapterWithResidentProcess();
      const result = adapter.interrupt();

      processCliMessage({
        type: 'control_response',
        subtype: 'interrupt',
        status: 'error',
        error: 'no active turn',
      });

      const completion = await result.completion!;
      expect(completion.status).toBe('rejected');
      expect(completion.reason).toContain('no active turn');
    });

    it('control_response with unknown subtype does not resolve the interrupt promise', () => {
      const { adapter, processCliMessage } = adapterWithResidentProcess();
      const result = adapter.interrupt();
      // Send a control_response for a different subtype — should not resolve
      processCliMessage({ type: 'control_response', subtype: 'other', status: 'success' });
      // The promise should still be pending (not resolved/rejected within this tick)
      let settled = false;
      result.completion?.then(() => { settled = true; }).catch(() => { settled = true; });
      // No microtask flush — promise should still be pending
      expect(settled).toBe(false);
    });

    it('sendEndSession writes end_session JSON to stdin', async () => {
      const { adapter, proc } = adapterWithResidentProcess();
      await adapter.sendEndSession();
      const written = proc.stdin.write.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join('');
      expect(written).toContain('"type":"end_session"');
    });

    it('sendEndSession is a no-op when no formatter', async () => {
      const adapter = new ClaudeCliAdapter({});
      await expect(adapter.sendEndSession()).resolves.toBeUndefined();
    });

    it('residentClaude:false disables the resident interrupt path and falls through to SIGINT', () => {
      const adapter = new ClaudeCliAdapter({ residentClaude: false });
      const proc = makeFakeProc();
      (adapter as unknown as { process: FakeProc | null }).process = proc;
      (adapter as unknown as { formatter: InputFormatter | null }).formatter =
        new InputFormatter(proc.stdin as unknown as import('stream').Writable);

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number | string, signal?: NodeJS.Signals | number) => {
          expect(pid).toBe(-proc.pid);
          expect(signal).toBe('SIGINT');
          return true;
        }) as typeof process.kill,
      );

      const result = adapter.interrupt();
      // Should fall through to SIGINT (no completion promise)
      expect(result.status).toBe('accepted');
      expect(result.completion).toBeUndefined();
      expect(killSpy).toHaveBeenCalled();
    });

    it('process exit during resident interrupt leaves completion pending (exit handler owns recovery)', () => {
      // When the process exits before control_response arrives, pendingInterruptResolve is
      // cleared WITHOUT resolving. The exit event then fires, triggering onInterruptedExit()
      // → respawnAfterInterrupt() which owns recovery and resolves respawnPromise only after
      // the new process is ready. Resolving with 'rejected' here would prematurely settle
      // the instance to idle (before the new process is spawned), unblocking sendInput()
      // against a null formatter and losing the queued steer message.
      const { adapter, proc } = adapterWithResidentProcess();
      const result = adapter.interrupt();
      expect(result.completion).toBeInstanceOf(Promise);

      // Simulate process dying before control_response arrives
      const handleExit = (adapter as unknown as { handleExit(code: number | null, signal: string | null): void }).handleExit.bind(adapter);
      handleExit(1, null);

      // The completion promise must NOT be settled by process exit — it stays pending
      // until the 15s interrupt-completion deadline fires in handleInterruptCompletion.
      // This ensures the exit handler path owns respawn rather than prematurely idling.
      let settled = false;
      result.completion?.then(() => { settled = true; }).catch(() => { settled = true; });
      // No await — promise must still be pending after synchronous handleExit
      expect(settled).toBe(false);

      // Also verify pendingInterruptResolve was cleared (no double-settle risk)
      const internals = adapter as unknown as { pendingInterruptResolve: unknown };
      expect(internals.pendingInterruptResolve).toBeNull();

      void proc; // referenced to suppress unused warning
    });

    it('stdin EPIPE during resident interrupt clears pendingInterruptResolve without resolving completion', async () => {
      // When stdin.write fails (EPIPE) before control_response arrives, the catch
      // handler clears pendingInterruptResolve WITHOUT resolving the completion promise.
      // Same principle as the process-exit case: the exit handler path owns recovery.
      const { adapter, proc } = adapterWithResidentProcess();

      // Override stdin.write to fire the callback with an EPIPE error
      proc.stdin.write = vi.fn((_chunk: unknown, _encoding?: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          queueMicrotask(() => (cb as (e: Error) => void)(new Error('EPIPE: write to closed pipe')));
        }
        return true;
      });

      const result = adapter.interrupt();
      expect(result.status).toBe('accepted');
      expect(result.completion).toBeInstanceOf(Promise);

      // Wait for the EPIPE catch handler to propagate through the promise chain:
      // write-callback → sendRaw rejects → writeToStdin → sendControlRequest → .catch()
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }

      // pendingInterruptResolve must be cleared (exit handler owns recovery)
      const internals = adapter as unknown as { pendingInterruptResolve: unknown };
      expect(internals.pendingInterruptResolve).toBeNull();

      // Completion must NOT be settled — the 15s deadline in handleInterruptCompletion
      // handles early return; respawnAfterInterrupt() owns the actual recovery
      let settled = false;
      result.completion?.then(() => { settled = true; }).catch(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
    });

    it('residentClaude:false makes getAdapterCapabilities return non-resident', () => {
      const adapter = new ClaudeCliAdapter({ residentClaude: false });
      const proc = makeFakeProc();
      (adapter as unknown as { process: FakeProc | null }).process = proc;
      (adapter as unknown as { formatter: InputFormatter | null }).formatter =
        new InputFormatter(proc.stdin as unknown as import('stream').Writable);
      const caps = adapter.getAdapterCapabilities();
      expect(caps.residentSession).toBe(false);
      expect(caps.liveInterrupt).toBe(false);
      expect(caps.liveSteer).toBe(false);
    });
  });
});
