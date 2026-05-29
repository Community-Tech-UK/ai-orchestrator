import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkerTerminalHandler,
  defaultShellForPlatform,
  type PtyProcessLike,
  type PtySpawnFn,
} from './worker-terminal-handler';

/** Controllable fake PTY mirroring the node-pty surface we use. */
class FakePty implements PtyProcessLike {
  readonly pid = 4242;
  dataListener: ((data: string) => void) | null = null;
  exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  written: string[] = [];
  lastResize: { cols: number; rows: number } | null = null;
  killed = false;
  killSignal: string | undefined;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.lastResize = { cols, rows };
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
  }

  // test helpers
  emitData(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

const ROOT = '/work/repo';

function makeHandler() {
  const output: Array<{ sessionId: string; data: string }> = [];
  const exits: Array<{ sessionId: string; exitCode: number | null; signal: string | null }> = [];
  const ptys: FakePty[] = [];
  const spawn: PtySpawnFn = vi.fn(() => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  });
  const handler = new WorkerTerminalHandler(
    [ROOT],
    {
      onOutput: (sessionId, data) => output.push({ sessionId, data }),
      onExit: (sessionId, exitCode, signal) => exits.push({ sessionId, exitCode, signal }),
    },
    spawn,
  );
  return { handler, output, exits, ptys, spawn };
}

describe('WorkerTerminalHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spawns a PTY in an allowed cwd and returns sessionId + pid', () => {
    const { handler, spawn, ptys } = makeHandler();
    const result = handler.create({ sessionId: 's1', cwd: ROOT, cols: 120, rows: 40 });
    expect(result).toEqual({ sessionId: 's1', pid: 4242 });
    expect(handler.sessionCount()).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const opts = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
      cols: number;
      rows: number;
      cwd: string;
    };
    expect(opts.cols).toBe(120);
    expect(opts.rows).toBe(40);
    expect(opts.cwd).toBe(ROOT);
    expect(ptys).toHaveLength(1);
  });

  it('refuses a cwd outside the allowed roots (sandbox)', () => {
    const { handler, spawn } = makeHandler();
    expect(() => handler.create({ sessionId: 's1', cwd: '/etc' })).toThrow(/outside allowed roots/);
    expect(spawn).not.toHaveBeenCalled();
    expect(handler.sessionCount()).toBe(0);
  });

  it('rejects duplicate session ids', () => {
    const { handler } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    expect(() => handler.create({ sessionId: 's1', cwd: ROOT })).toThrow(/already exists/);
  });

  it('clamps absurd dimensions and falls back on invalid ones', () => {
    const { handler, spawn } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT, cols: 999_999, rows: 0 });
    const opts = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as {
      cols: number;
      rows: number;
    };
    expect(opts.cols).toBe(10_000); // clamped to MAX_DIMENSION
    expect(opts.rows).toBe(24); // 0 -> default
  });

  it('coalesces PTY output and flushes on a timer', () => {
    const { handler, output, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    ptys[0].emitData('hel');
    ptys[0].emitData('lo');
    expect(output.length).toBe(0); // nothing flushed yet
    vi.advanceTimersByTime(30);
    expect(output).toEqual([{ sessionId: 's1', data: 'hello' }]);
  });

  it('flushes immediately when the buffer grows large', () => {
    const { handler, output, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    ptys[0].emitData('x'.repeat(20_000));
    expect(output.length).toBe(1);
    expect(output[0].data.length).toBe(20_000);
  });

  it('writes input to the PTY', () => {
    const { handler, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    handler.input('s1', 'ls -la\r');
    expect(ptys[0].written).toEqual(['ls -la\r']);
  });

  it('throws when writing to an unknown session', () => {
    const { handler } = makeHandler();
    expect(() => handler.input('nope', 'x')).toThrow(/not found/);
  });

  it('resizes the PTY', () => {
    const { handler, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    handler.resize('s1', 100, 50);
    expect(ptys[0].lastResize).toEqual({ cols: 100, rows: 50 });
  });

  it('flushes pending output then emits exit and drops the session', () => {
    const { handler, output, exits, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    ptys[0].emitData('bye');
    ptys[0].emitExit(0, 15);
    // pending "bye" flushed before exit
    expect(output).toEqual([{ sessionId: 's1', data: 'bye' }]);
    expect(exits).toEqual([{ sessionId: 's1', exitCode: 0, signal: '15' }]);
    expect(handler.sessionCount()).toBe(0);
  });

  it('kill is idempotent for unknown sessions and requests PTY termination', () => {
    const { handler, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    expect(() => handler.kill('ghost')).not.toThrow();
    handler.kill('s1', 'SIGTERM');
    expect(ptys[0].killed).toBe(true);
    expect(ptys[0].killSignal).toBe('SIGTERM');
  });

  it('killAll terminates every PTY', () => {
    const { handler, ptys } = makeHandler();
    handler.create({ sessionId: 's1', cwd: ROOT });
    handler.create({ sessionId: 's2', cwd: ROOT });
    handler.killAll();
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(true);
    expect(handler.sessionCount()).toBe(0);
  });

  it('defaultShellForPlatform returns a platform-appropriate shell', () => {
    expect(defaultShellForPlatform('win32')).toMatch(/cmd|powershell|ComSpec/i);
    expect(defaultShellForPlatform('linux')).toMatch(/sh|bash|zsh/);
  });
});
