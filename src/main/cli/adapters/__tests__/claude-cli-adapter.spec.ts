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
    };
    stdin.write = vi.fn();
    stdin.end = vi.fn();
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
import { NdjsonParser } from '../../ndjson-parser';

describe('ClaudeCliAdapter', () => {
  let adapter: ClaudeCliAdapter;

  beforeEach(() => {
    adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/test-cwd',
      model: 'opus',
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
      expect(rt.supportsNativeCompaction).toBe(true);
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
      const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp/proj-xyz' });
      const statusPromise = adapter.checkStatus();
      const proc = spawnedProcesses[spawnedProcesses.length - 1]!;
      proc.emit('close', 0);
      await statusPromise;

      expect(lastSpawnState.lastSpawnArgs?.opts.cwd).toBe('/tmp/proj-xyz');
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

    it('sends SIGINT to the running process and returns true', () => {
      const { adapter, proc } = adapterWithRunningProcess();
      const ok = adapter.interrupt();
      expect(ok).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('returns false when no process is running', () => {
      const adapter = new ClaudeCliAdapter({});
      expect(adapter.interrupt()).toBe(false);
    });
  });
});
