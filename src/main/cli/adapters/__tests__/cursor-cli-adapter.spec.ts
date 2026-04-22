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

describe('CursorCliAdapter — assistant event', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  it('emits streaming output messages with a stable per-turn messageId', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { streaming?: boolean; accumulatedContent?: string };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello wo"}]},"timestamp_ms":100}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"rld"}]},"timestamp_ms":200}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const assistantOutputs = outputs.filter(o => o.type === 'assistant');

    expect(assistantOutputs).toHaveLength(3);
    expect(assistantOutputs[0].metadata?.streaming).toBe(true);
    expect(assistantOutputs[0].content).toBe('Hello wo');
    expect(assistantOutputs[0].metadata?.accumulatedContent).toBe('Hello wo');
    expect(assistantOutputs[1].metadata?.streaming).toBe(true);
    expect(assistantOutputs[1].content).toBe('rld');
    expect(assistantOutputs[1].metadata?.accumulatedContent).toBe('Hello world');
    expect(assistantOutputs[2].metadata?.streaming).toBe(false);
    expect(assistantOutputs[2].content).toBe('');
    expect(assistantOutputs[2].metadata?.accumulatedContent).toBe('Hello world');
    // Stable per-turn ID:
    const ids = new Set(assistantOutputs.map(o => o.id));
    expect(ids.size).toBe(1);
  });

  it('dedupe — final ⊆ streaming: terminal flush only, accumulated length 11', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { streaming?: boolean; accumulatedContent?: string };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello wo"}]},"timestamp_ms":100}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"rld"}]},"timestamp_ms":200}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const assistantOutputs = outputs.filter(o => o.type === 'assistant');

    const flushes = assistantOutputs.filter(o => o.metadata?.streaming === false);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].content).toBe('');
    expect(flushes[0].metadata?.accumulatedContent).toHaveLength(11);
    expect(flushes[0].metadata?.accumulatedContent).toBe('Hello world');
    // No streaming:true delta with "Hello world" as content (that would be a duplicate).
    const duplicateDeltas = assistantOutputs.filter(
      o => o.metadata?.streaming === true && o.content === 'Hello world'
    );
    expect(duplicateDeltas).toHaveLength(0);
  });

  it('dedupe — final extends streaming: emits suffix delta + flush, accumulated length 11', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { streaming?: boolean; accumulatedContent?: string };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"timestamp_ms":100}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const assistantOutputs = outputs.filter(o => o.type === 'assistant');

    expect(assistantOutputs).toHaveLength(3);
    expect(assistantOutputs[0].content).toBe('Hello');
    expect(assistantOutputs[1].metadata?.streaming).toBe(true);
    expect(assistantOutputs[1].content).toBe(' world');
    expect(assistantOutputs[1].metadata?.accumulatedContent).toBe('Hello world');
    expect(assistantOutputs[2].metadata?.streaming).toBe(false);
    expect(assistantOutputs[2].metadata?.accumulatedContent).toBe('Hello world');
    expect(assistantOutputs[2].metadata?.accumulatedContent).toHaveLength(11);
  });

  it('ignores buffered assistant copies with model_call_id before tool calls', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { streaming?: boolean; accumulatedContent?: string };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"timestamp_ms":100}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"timestamp_ms":101,"model_call_id":"call-1"}\n');
    proc.stdout.emit('data', '{"type":"tool_call","subtype":"started","call_id":"tool-1","tool_call":{"readToolCall":{"path":"README.md"}}}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" world"}]},"timestamp_ms":200}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const assistantOutputs = outputs.filter(o => o.type === 'assistant');
    expect(assistantOutputs).toHaveLength(3);
    expect(assistantOutputs[0].content).toBe('Hello');
    expect(assistantOutputs[1].content).toBe(' world');
    expect(assistantOutputs[1].metadata?.accumulatedContent).toBe('Hello world');
    expect(assistantOutputs[2].metadata?.streaming).toBe(false);
    expect(assistantOutputs[2].metadata?.accumulatedContent).toBe('Hello world');
  });

  it('processes a trailing assistant event even when the final line has no newline terminator', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { streaming?: boolean; accumulatedContent?: string };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\\u0027ll create a new `cur"}]},"timestamp_ms":100}\n');
    proc.stdout.emit('data', '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\\u0027ll create a new `cursor_plan.md`"}]}}');
    proc.emit('close', 0);

    const response = await sendPromise;
    const assistantOutputs = outputs.filter(o => o.type === 'assistant');

    expect(response.content).toBe('');
    expect(assistantOutputs).toHaveLength(3);
    expect(assistantOutputs[0].content).toBe("I'll create a new `cur");
    expect(assistantOutputs[1].content).toBe("sor_plan.md`");
    expect(assistantOutputs[1].metadata?.streaming).toBe(true);
    expect(assistantOutputs[1].metadata?.accumulatedContent).toBe("I'll create a new `cursor_plan.md`");
    expect(assistantOutputs[2].metadata?.streaming).toBe(false);
    expect(assistantOutputs[2].metadata?.accumulatedContent).toBe("I'll create a new `cursor_plan.md`");
  });
});

describe('CursorCliAdapter — tool_call event', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  interface OutputEvent {
    id: string;
    type: string;
    content: string;
    metadata?: {
      toolName?: string;
      callId?: string;
      input?: unknown;
      success?: boolean;
      output?: unknown;
      error?: unknown;
    };
  }

  it('tool_call.started with readToolCall emits one tool_use output with correct metadata', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-tc1"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 't1',
      tool_call: { readToolCall: { path: 'foo' } },
      session_id: 'sess-tc1',
    }) + '\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-tc1"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const toolUseOutputs = outputs.filter(o => o.type === 'tool_use');
    expect(toolUseOutputs).toHaveLength(1);
    expect(toolUseOutputs[0].metadata?.name).toBe('read');
    expect(toolUseOutputs[0].metadata?.toolName).toBe('read');
    expect(toolUseOutputs[0].metadata?.callId).toBe('t1');
    expect(toolUseOutputs[0].metadata?.tool_use_id).toBe('t1');
    expect(toolUseOutputs[0].metadata?.input).toEqual({ path: 'foo' });
  });

  it('tool_call.started with bashToolCall emits tool_use with toolName === bash', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-tc2"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 't2',
      tool_call: { bashToolCall: { cmd: 'ls' } },
      session_id: 'sess-tc2',
    }) + '\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-tc2"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const toolUseOutputs = outputs.filter(o => o.type === 'tool_use');
    expect(toolUseOutputs).toHaveLength(1);
    expect(toolUseOutputs[0].metadata?.toolName).toBe('bash');
  });

  it('tool_call.started with empty tool_call object emits unknown_tool and does not throw', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-tc3"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 't3',
      tool_call: {},
      session_id: 'sess-tc3',
    }) + '\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-tc3"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const toolUseOutputs = outputs.filter(o => o.type === 'tool_use');
    expect(toolUseOutputs).toHaveLength(1);
    expect(toolUseOutputs[0].metadata?.toolName).toBe('unknown_tool');
  });

  it('tool_call.completed with inner error emits tool_result (success=false) AND error output', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-tc4"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 't4',
      tool_call: { readToolCall: { error: 'ENOENT' } },
      session_id: 'sess-tc4',
    }) + '\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-tc4"}\n');
    proc.emit('close', 0);

    await sendPromise;

    const toolResultOutputs = outputs.filter(o => o.type === 'tool_result');
    const errorOutputs = outputs.filter(o => o.type === 'error');

    expect(toolResultOutputs).toHaveLength(1);
    expect(toolResultOutputs[0].metadata?.name).toBe('read');
    expect(toolResultOutputs[0].metadata?.tool_use_id).toBe('t4');
    expect(toolResultOutputs[0].metadata?.is_error).toBe(true);
    expect(toolResultOutputs[0].metadata?.success).toBe(false);

    expect(errorOutputs).toHaveLength(1);
  });
});

describe('CursorCliAdapter — result event', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  it('captures session_id, emits context, resolves sendMessage with result content', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent { id: string; type: string; content: string; metadata?: Record<string, unknown>; }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));
    const contexts: { used: number; total: number; percentage: number }[] = [];
    adapter.on('context', (c: { used: number; total: number; percentage: number }) => contexts.push(c));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-2', duration_ms: 1000, duration_api_ms: 800, result: 'done',
    }) + '\n');
    proc.emit('close', 0);

    const response = await sendPromise;
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBe('sess-2');
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    expect(response.content).toBe('done');
    expect(response.usage?.duration).toBe(1000);
  });

  it('is_error:true emits error OutputMessage and rejects sendMessage', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent { id: string; type: string; content: string; }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-e"}\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      session_id: 'sess-e', result: 'something went wrong',
    }) + '\n');
    proc.emit('close', 0);

    await expect(sendPromise).rejects.toThrow('something went wrong');
    const errorOutputs = outputs.filter(o => o.type === 'error');
    expect(errorOutputs.length).toBeGreaterThanOrEqual(1);
    expect(errorOutputs[0].content).toBe('something went wrong');
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBe('sess-e');
  });

  it('processes a trailing result event when the final line has no newline terminator', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const contexts: { used: number; total: number; percentage: number }[] = [];
    adapter.on('context', (c: { used: number; total: number; percentage: number }) => contexts.push(c));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    proc.stdout.emit('data', '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-2","result":"done"}');
    proc.emit('close', 0);

    const response = await sendPromise;
    expect(response.content).toBe('done');
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBe('sess-2');
    expect(contexts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CursorCliAdapter — resume-failure fallback', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  interface OutputEvent {
    id: string;
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
  }

  it("clears cursorSessionId and retries once without --resume on 'invalid session id'", async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    (adapter as unknown as { cursorSessionId: string | null }).cursorSessionId = 'stale';

    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    // First spawn — verify --resume was included.
    expect(lastSpawnState.lastSpawnArgs?.args).toEqual(expect.arrayContaining(['--resume', 'stale']));
    expect(spawnedProcesses).toHaveLength(1);

    const first = spawnedProcesses[0];
    first.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: 'invalid session id: stale',
    }) + '\n');
    // Yield so handleResultEvent can run dispatchTurn and spawn the retry.
    await new Promise<void>((r) => setImmediate(r));

    // Second spawn — verify --resume is NOT present.
    expect(spawnedProcesses).toHaveLength(2);
    expect(lastSpawnState.lastSpawnArgs?.args).not.toContain('--resume');

    // Fire a 'close' on the first (pre-retry) process AFTER the retry spawned.
    // dispatchTurn should have removed listeners, so this must NOT corrupt the
    // retry's state.
    first.emit('close', 0);

    const second = spawnedProcesses[1];
    second.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'new-sess', result: 'done',
    }) + '\n');
    second.emit('close', 0);

    const resp = await sendPromise;
    expect(resp.content).toBe('done');
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBe('new-sess');

    // User-visible recoverable-error notice was emitted exactly once, with
    // metadata { recoverable: true, retryKind: 'resume-fallback' }.
    const recoverables = outputs.filter(
      (o) =>
        o.type === 'error' &&
        (o.metadata as { retryKind?: string } | undefined)?.retryKind === 'resume-fallback'
    );
    expect(recoverables).toHaveLength(1);
    expect(recoverables[0].content).toBe('Previous Cursor session expired; starting fresh.');
    expect(recoverables[0].metadata?.recoverable).toBe(true);
  });

  it('does NOT retry on non-resume errors; cursorSessionId preserved', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    (adapter as unknown as { cursorSessionId: string | null }).cursorSessionId = 'sess-ok';

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    proc.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: 'unrelated error',
    }) + '\n');
    proc.emit('close', 0);

    await expect(sendPromise).rejects.toThrow('unrelated error');
    expect(spawnedProcesses).toHaveLength(1);
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBe('sess-ok');
  });

  it('retry also fails → rejects with the retry error (no infinite loop)', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    (adapter as unknown as { cursorSessionId: string | null }).cursorSessionId = 'stale';

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const first = spawnedProcesses[0];
    first.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: 'session expired',
    }) + '\n');
    await new Promise<void>((r) => setImmediate(r));
    first.emit('close', 0);

    expect(spawnedProcesses).toHaveLength(2);
    const second = spawnedProcesses[1];
    second.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
      result: 'authentication failed',
    }) + '\n');
    second.emit('close', 0);

    await expect(sendPromise).rejects.toThrow('authentication failed');
    // Guard: the retry's error must NOT trigger a third spawn even if it
    // happened to match the resume-failure pattern (it doesn't here, but the
    // `!retriedWithoutResume` gate enforces this regardless).
    expect(spawnedProcesses).toHaveLength(2);
  });
});

describe('CursorCliAdapter — unknown-flag fallback for --stream-partial-output', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  it('first spawn exits non-zero with stderr mentioning --stream-partial-output → retries without flag and caches fallback', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    // First sendMessage.
    const sendPromise1 = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    // First spawn: --stream-partial-output IS present.
    expect(lastSpawnState.lastSpawnArgs?.args).toContain('--stream-partial-output');
    const first = spawnedProcesses[0];

    // Fire stderr then non-zero close.
    first.stderr.emit('data', "error: unknown option '--stream-partial-output'\n");
    first.emit('close', 1);
    await new Promise<void>((r) => setImmediate(r));

    // Retry spawn: --stream-partial-output is ABSENT.
    expect(spawnedProcesses).toHaveLength(2);
    expect(lastSpawnState.lastSpawnArgs?.args).not.toContain('--stream-partial-output');
    const second = spawnedProcesses[1];

    // Let the retry succeed.
    second.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    second.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-1', result: 'done'
    }) + '\n');
    second.emit('close', 0);

    const resp1 = await sendPromise1;
    expect(resp1.content).toBe('done');
    // Instance flag cached.
    expect((adapter as unknown as { partialOutputSupported: boolean }).partialOutputSupported).toBe(false);

    // Third invocation (new sendMessage on the SAME adapter) — flag stays absent.
    const sendPromise3 = adapter.sendMessage({ role: 'user', content: 'follow-up' });
    await new Promise<void>((r) => setImmediate(r));

    expect(spawnedProcesses).toHaveLength(3);
    expect(lastSpawnState.lastSpawnArgs?.args).not.toContain('--stream-partial-output');
    const third = spawnedProcesses[2];
    third.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-1', result: 'ok'
    }) + '\n');
    third.emit('close', 0);

    const resp3 = await sendPromise3;
    expect(resp3.content).toBe('ok');
  });

  it('also handles spec-example wording ("unknown flag --stream-partial-output")', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const first = spawnedProcesses[0];
    first.stderr.emit('data', 'unknown flag --stream-partial-output\n');
    first.emit('close', 1);
    await new Promise<void>((r) => setImmediate(r));

    expect(spawnedProcesses).toHaveLength(2);
    expect(lastSpawnState.lastSpawnArgs?.args).not.toContain('--stream-partial-output');
    const second = spawnedProcesses[1];
    second.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-1', result: 'done'
    }) + '\n');
    second.emit('close', 0);

    const resp = await sendPromise;
    expect(resp.content).toBe('done');
  });

  it('non-zero exit WITHOUT --stream-partial-output mention does NOT retry and rejects with stderr included', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    proc.stderr.emit('data', 'some unrelated failure\n');
    proc.emit('close', 42);

    await expect(sendPromise).rejects.toThrow(/exited with code 42.*some unrelated failure/);
    expect(spawnedProcesses).toHaveLength(1);
    expect((adapter as unknown as { partialOutputSupported: boolean }).partialOutputSupported).toBe(true);
  });
});

describe('CursorCliAdapter — lifecycle + status + stderr', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    spawnMock.mockClear();
    lastSpawnState.lastSpawnArgs = null;
  });

  it('checkStatus happy path — parses version from --version output', async () => {
    const adapter = new CursorCliAdapter({});
    const statusPromise = Promise.resolve().then(() => adapter.checkStatus());
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    expect(lastSpawnState.lastSpawnArgs?.args).toEqual(['--version']);

    proc.stdout.emit('data', '2026.04.17-787b533\n');
    proc.emit('close', 0);

    const result = await statusPromise;
    expect(result).toMatchObject({ available: true });
    expect(result.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it('checkStatus timeout → available:false with Timeout error', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new CursorCliAdapter({});
      const statusPromise = adapter.checkStatus();
      // Let the Promise executor run so the spawn happens and timer is set.
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(5001);
      const result = await statusPromise;
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/Timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sendMessage rejects with install hint on ENOENT spawn error', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    const err = new Error('spawn cursor-agent ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    proc.emit('error', err);

    await expect(sendPromise).rejects.toThrow(/cursor-agent.*not found|install|cursor\.com/i);
  });

  it('spawn() calls checkStatus, marks isSpawned, emits spawned event', async () => {
    const adapter = new CursorCliAdapter({});
    const spawnedEvents: number[] = [];
    adapter.on('spawned', (pid: number) => spawnedEvents.push(pid));

    const spawnPromise = adapter.spawn();
    await new Promise<void>((r) => setImmediate(r));

    // --version spawn — drive success.
    const proc = spawnedProcesses[0];
    proc.stdout.emit('data', '2026.04.17-787b533\n');
    proc.emit('close', 0);

    const pid = await spawnPromise;
    expect(typeof pid).toBe('number');
    expect((adapter as unknown as { isSpawned: boolean }).isSpawned).toBe(true);
    // The --version probe spawn also emits 'spawned' (inherited from
    // BaseCliAdapter.spawnProcess since the fake proc has a pid). What matters
    // is that spawn() itself emitted a 'spawned' with the synthetic PID.
    expect(spawnedEvents).toContain(pid);
  });

  it('spawn() rejects when already spawned', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    await expect(adapter.spawn()).rejects.toThrow(/already spawned/i);
  });

  it('sendInput emits ready -> busy -> idle on success', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const statuses: string[] = [];
    adapter.on('status', (s: string) => statuses.push(s));

    vi.spyOn(adapter, 'sendMessage').mockResolvedValue({
      id: 'r1',
      content: 'ok',
      role: 'assistant',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      raw: '',
    });

    await adapter.sendInput('hi');
    expect(statuses).toEqual(['ready', 'busy', 'idle']);
  });

  it('terminate(true) clears cursor-specific instance state', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    (adapter as unknown as { cursorSessionId: string | null }).cursorSessionId = 'x';
    (adapter as unknown as { partialOutputSupported: boolean }).partialOutputSupported = false;

    await adapter.terminate(true);

    expect((adapter as unknown as { isSpawned: boolean }).isSpawned).toBe(false);
    expect((adapter as unknown as { cursorSessionId: string | null }).cursorSessionId).toBeNull();
    expect((adapter as unknown as { partialOutputSupported: boolean }).partialOutputSupported).toBe(true);
  });

  it("terminate() emits 'exit' (0, null) AND 'status' (terminated) when previously spawned", async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    const exitEvents: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    const statusEvents: string[] = [];
    adapter.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitEvents.push({ code, signal });
    });
    adapter.on('status', (s: string) => statusEvents.push(s));

    await adapter.terminate(true);

    // Provider wrappers (e.g., CopilotCliProvider) subscribe to 'exit' to mark
    // isActive = false AND call pushExit(code, signal). Matching Copilot's
    // emit('exit', 0, null) keeps Cursor's lifecycle semantics identical so a
    // CursorCliProvider following the same pattern won't silently stay active.
    expect(exitEvents).toEqual([{ code: 0, signal: null }]);
    expect(statusEvents).toContain('terminated');
  });

  it('multi-turn: first sendMessage captures session_id, second includes --resume', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    // Turn 1 — no --resume yet.
    const send1 = adapter.sendMessage({ role: 'user', content: 'first' });
    await new Promise<void>((r) => setImmediate(r));
    expect(lastSpawnState.lastSpawnArgs?.args).not.toContain('--resume');

    const proc1 = spawnedProcesses[0];
    proc1.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-mt', result: 'one',
    }) + '\n');
    proc1.emit('close', 0);
    await send1;

    // Turn 2 — --resume sess-mt present.
    const send2 = adapter.sendMessage({ role: 'user', content: 'second' });
    await new Promise<void>((r) => setImmediate(r));
    expect(lastSpawnState.lastSpawnArgs?.args).toEqual(
      expect.arrayContaining(['--resume', 'sess-mt']),
    );

    const proc2 = spawnedProcesses[1];
    proc2.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess-mt', result: 'two',
    }) + '\n');
    proc2.emit('close', 0);
    const resp2 = await send2;
    expect(resp2.content).toBe('two');
  });

  it('stderr matching generic error pattern emits error OutputMessage with metadata.kind === "stderr"', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { kind?: string; recoverable?: boolean };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    proc.stderr.emit('data', 'error: some backend failure\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess', result: 'done',
    }) + '\n');
    proc.emit('close', 0);
    await sendPromise;

    const stderrErrors = outputs.filter(
      (o) => o.type === 'error' && o.metadata?.kind === 'stderr',
    );
    expect(stderrErrors).toHaveLength(1);
    expect(stderrErrors[0].content).toMatch(/error: some backend failure/);
    expect(stderrErrors[0].metadata?.recoverable).toBe(false);
  });

  it('stderr matching keychain pattern emits error OutputMessage with metadata.kind === "keychain"', async () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;

    interface OutputEvent {
      id: string;
      type: string;
      content: string;
      metadata?: { kind?: string; recoverable?: boolean };
    }
    const outputs: OutputEvent[] = [];
    adapter.on('output', (m: OutputEvent) => outputs.push(m));

    const sendPromise = adapter.sendMessage({ role: 'user', content: 'hi' });
    await new Promise<void>((r) => setImmediate(r));

    const proc = spawnedProcesses[0];
    proc.stderr.emit('data', 'SecItemCopyMatching failed: errSecInteractionNotAllowed\n');
    proc.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      session_id: 'sess', result: 'done',
    }) + '\n');
    proc.emit('close', 0);
    await sendPromise;

    const keychainErrors = outputs.filter(
      (o) => o.type === 'error' && o.metadata?.kind === 'keychain',
    );
    expect(keychainErrors).toHaveLength(1);
    expect(keychainErrors[0].content).toMatch(/cursor-agent login/);
    expect(keychainErrors[0].content).toMatch(/CURSOR_API_KEY/);
    expect(keychainErrors[0].metadata?.recoverable).toBe(false);
    // Keychain match has priority — no generic "stderr" error should be emitted
    // for the same chunk.
    const stderrErrors = outputs.filter(
      (o) => o.type === 'error' && o.metadata?.kind === 'stderr',
    );
    expect(stderrErrors).toHaveLength(0);
  });
});
