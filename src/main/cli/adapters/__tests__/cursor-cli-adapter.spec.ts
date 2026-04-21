import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { CursorCliAdapter } from '../cursor-cli-adapter';

describe('CursorCliAdapter — identity', () => {
  it('getName returns cursor-cli', () => {
    expect(new CursorCliAdapter({}).getName()).toBe('cursor-cli');
  });
  it('getCapabilities declares streaming + multiTurn + sandbox-appropriate caps', () => {
    const caps = new CursorCliAdapter({}).getCapabilities();
    expect(caps).toMatchObject({
      streaming: true, toolUse: true, multiTurn: true,
      codeExecution: true, vision: false,
      outputFormats: ['text', 'json', 'stream-json'],
    });
  });
  it('getRuntimeCapabilities declares supportsResume: true', () => {
    const caps = new CursorCliAdapter({}).getRuntimeCapabilities();
    expect(caps.supportsResume).toBe(true);
    expect(caps.supportsPermissionPrompts).toBe(false);
  });
});

describe('CursorCliAdapter — buildArgs baseline', () => {
  it('includes -p, --output-format stream-json, --force, --sandbox disabled', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hi' });
    expect(args).toEqual(expect.arrayContaining([
      '-p', '--output-format', 'stream-json',
      '--force', '--sandbox', 'disabled',
    ]));
  });

  it('positional prompt appears at the end', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hello' });
    expect(args[args.length - 1]).toBe('hello');
  });
});

describe('CursorCliAdapter — buildArgs per-flag rules', () => {
  interface BuildArgsSpy {
    buildArgs: (m: { content: string }) => string[];
    cursorSessionId: string | null;
    partialOutputSupported: boolean;
  }

  it('omits --model when cliConfig.model is undefined', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'auto'", () => {
    const adapter = new CursorCliAdapter({ model: 'auto' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'AUTO' (case-insensitive)", () => {
    const adapter = new CursorCliAdapter({ model: 'AUTO' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it('includes --model when concrete value set', () => {
    const adapter = new CursorCliAdapter({ model: 'claude-sonnet-4-6' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-6');
  });
  it('prepends systemPrompt with blank-line separator', () => {
    const adapter = new CursorCliAdapter({ systemPrompt: 'SYS' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'user' });
    expect(args[args.length - 1]).toBe('SYS\n\nuser');
  });
  it('includes --resume <id> when cursorSessionId is set', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as BuildArgsSpy).cursorSessionId = 'sess-123';
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('sess-123');
  });
  it('omits --stream-partial-output when feature flag cleared', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as BuildArgsSpy).partialOutputSupported = false;
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--stream-partial-output');
  });
});

describe('CursorCliAdapter — system/init parsing', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  it('captures session_id from system.init event', async () => {
    const adapter = new CursorCliAdapter({});
    // Flip the spawn gate — spawn() is a stub until Task 23; flip directly.
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const emitted: { status?: string }[] = [];
    adapter.on('status', (s: string) => emitted.push({ status: s }));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });

    // Wait for the promise executor to run and register stdout handler.
    await new Promise<void>((r) => setImmediate(r));

    // Grab the fake process that was spawned.
    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    // Drive NDJSON lines through stdout then close.
    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1","model":"auto"}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    expect(
      (adapter as unknown as { cursorSessionId: string | null }).cursorSessionId
    ).toBe('sess-1');
    expect(emitted).toContainEqual({ status: 'busy' });
  });
});
