import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AcpCliAdapter } from './acp-cli-adapter';
import { PermissionRegistry } from '../../orchestration/permission-registry';
import type {
  AcpJsonRpcMessage,
  AcpJsonRpcRequest,
  AcpJsonRpcSuccessResponse,
} from '../../../shared/types/cli.types';

class FakeAcpProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 4242;
  killed = false;

  private stdinBuffer = '';
  private readonly handlers = new Map<string, (message: AcpJsonRpcRequest) => void | Promise<void>>();
  readonly receivedMessages: AcpJsonRpcMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: AcpJsonRpcMessage) => boolean;
    resolve: (message: AcpJsonRpcMessage) => void;
  }> = [];

  constructor() {
    super();

    this.stdin = {
      writable: true,
      destroyed: false,
      on: vi.fn(),
      once: vi.fn(),
      write: (chunk: Buffer | string) => {
        this.handleIncomingChunk(chunk.toString());
        return true;
      },
    } as unknown as Writable;
  }

  onRequest(method: string, handler: (message: AcpJsonRpcRequest) => void | Promise<void>): void {
    this.handlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  request(id: string | number, method: string, params?: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  respond(id: string | number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  waitForMessage(predicate: (message: AcpJsonRpcMessage) => boolean): Promise<AcpJsonRpcMessage> {
    const existing = this.receivedMessages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    this.killed = true;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  private handleIncomingChunk(chunk: string): void {
    this.stdinBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdinBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdinBuffer.slice(0, newlineIndex).trim();
      this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const message = JSON.parse(line) as AcpJsonRpcMessage;
      this.receivedMessages.push(message);
      this.flushWaiters(message);

      if ('method' in message && 'id' in message) {
        const handler = this.handlers.get(message.method);
        if (handler) {
          void handler(message as AcpJsonRpcRequest);
        }
      }
    }
  }

  private flushWaiters(message: AcpJsonRpcMessage): void {
    const remaining: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters.splice(0, this.waiters.length, ...remaining);
  }
}

function createInitializedAgentHarness(): FakeAcpProcess {
  const proc = new FakeAcpProcess();

  proc.onRequest('initialize', (message) => {
    proc.respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
  });

  proc.onRequest('session/new', (message) => {
    proc.respond(message.id, {
      sessionId: 'sess-acp-1',
    });
  });

  proc.onRequest('session/load', (message) => {
    proc.respond(message.id, null);
  });

  return proc;
}

class TestAcpCliAdapter extends AcpCliAdapter {
  constructor(
    private readonly proc: FakeAcpProcess,
    config: ConstructorParameters<typeof AcpCliAdapter>[0],
  ) {
    super(config);
  }

  override async checkStatus() {
    return { available: true };
  }

  protected override spawnProcess(_args: string[]): FakeAcpProcess {
    this.emit('spawned', this.proc.pid);
    return this.proc;
  }
}

describe('AcpCliAdapter', () => {
  beforeEach(() => {
    PermissionRegistry._resetForTesting();
  });

  afterEach(() => {
    PermissionRegistry._resetForTesting();
  });

  it('does not advertise resume until the ACP agent proves loadSession support', () => {
    const proc = new FakeAcpProcess();
    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      args: [],
      requestTimeoutMs: 100,
    });

    expect(adapter.getRuntimeCapabilities().supportsResume).toBe(false);
  });

  it('initializes the ACP transport and opens a new session', async () => {
    const proc = createInitializedAgentHarness();

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });

    const statusHandler = vi.fn();
    adapter.on('status', statusHandler);

    await expect(adapter.spawn()).resolves.toBe(4242);
    expect(proc.receivedMessages[0]).toMatchObject({
      method: 'initialize',
    });

    const initializeRequest = proc.receivedMessages.find((message) =>
      'method' in message && message.method === 'initialize',
    ) as AcpJsonRpcRequest | undefined;
    const sessionNewRequest = proc.receivedMessages.find((message) =>
      'method' in message && message.method === 'session/new',
    ) as AcpJsonRpcRequest | undefined;

    expect(initializeRequest?.params).toMatchObject({
      protocolVersion: 1,
      clientInfo: expect.objectContaining({ name: 'ai-orchestrator' }),
    });
    expect(sessionNewRequest?.params).toMatchObject({
      cwd: '/tmp',
    });
    expect(adapter.getSessionId()).toBe('sess-acp-1');
    expect(adapter.getRuntimeCapabilities().supportsResume).toBe(true);
    expect(statusHandler).toHaveBeenCalledWith('ready');

    proc.exit();
  });

  it('records confirmed native resume proof when session/load succeeds', async () => {
    const proc = createInitializedAgentHarness();

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'sess-existing',
    });

    await adapter.spawn();

    const loadRequest = proc.receivedMessages.find((message) =>
      'method' in message && message.method === 'session/load',
    ) as AcpJsonRpcRequest | undefined;

    expect(loadRequest?.params).toMatchObject({
      sessionId: 'sess-existing',
      cwd: '/tmp',
    });
    expect(adapter.getSessionId()).toBe('sess-existing');
    expect(adapter.getResumeAttemptResult()).toMatchObject({
      source: 'native',
      confirmed: true,
      requestedSessionId: 'sess-existing',
      actualSessionId: 'sess-existing',
      requestedCursor: expect.objectContaining({
        transport: 'acp',
        sessionId: 'sess-existing',
        workspacePath: '/tmp',
      }),
    });

    proc.exit();
  });

  it('records unconfirmed native resume proof when the agent lacks loadSession support', async () => {
    const proc = new FakeAcpProcess();
    proc.onRequest('initialize', (message) => {
      proc.respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'sess-existing',
    });

    await expect(adapter.spawn()).rejects.toThrow(/does not advertise loadSession support/);
    expect(adapter.getResumeAttemptResult()).toMatchObject({
      source: 'native',
      confirmed: false,
      requestedSessionId: 'sess-existing',
      reason: 'ACP agent does not advertise loadSession support.',
    });

    proc.exit();
  });

  it('translates ACP session updates into output, tool_use, and tool_result events', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', (message) => {
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Read config',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'package.json' },
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Found package.json' },
            },
          ],
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      });
      proc.respond(message.id, {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          costUsd: 0.01,
        },
      });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });

    await adapter.spawn();

    const outputHandler = vi.fn();
    const toolUseHandler = vi.fn();
    const toolResultHandler = vi.fn();
    adapter.on('output', outputHandler);
    adapter.on('tool_use', toolUseHandler);
    adapter.on('tool_result', toolResultHandler);

    const response = await adapter.sendMessage({ role: 'user', content: 'hello' });

    expect(response.content).toBe('Hello world');
    expect(response.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      cost: 0.01,
    });
    expect(toolUseHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'call-1',
        name: 'Read config',
      }),
    );
    expect(toolResultHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'call-1',
        name: 'Read config',
        result: 'Found package.json',
      }),
    );
    expect(outputHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        content: 'Hello ',
      }),
    );
    expect(outputHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_result',
        content: 'Found package.json',
      }),
    );

    // Regression: the tool_use output metadata MUST carry a `name` (ACP kind)
    // and `title` so the renderer's ActivityDebouncer can light up the
    // "Gathering context" / "Searching the codebase" progress pill for
    // Copilot/Cursor sessions — not just for Claude.
    expect(outputHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_use',
        content: 'Read config',
        metadata: expect.objectContaining({
          name: 'read',
          title: 'Read config',
          kind: 'read',
          transport: 'acp',
        }),
      }),
    );

    proc.exit();
  });

  it('treats available_commands_update + session_info_update as silent metadata, not chat output', async () => {
    // Regression: cursor-agent ACP sends `availableCommands` (camelCase per
    // the current spec) plus a `session_info_update` carrying the auto-
    // generated session title. Older code (a) treated the camelCase field
    // as malformed and emitted a red chat error, (b) returned an empty
    // command list and rendered "Available commands: none advertised." as
    // a system bubble, and (c) JSON.stringify'd the session_info_update
    // straight into the chat. All three should now stay out of the chat.
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', (message) => {
      // Real cursor-agent payload (camelCase, populated list).
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'simplify', description: 'Find low-info comments…' },
            { name: 'shell', description: 'Run a literal shell command.' },
          ],
        },
      });
      // Real cursor-agent auto-title metadata.
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'session_info_update',
          title: 'Orchestrator Optimizer',
        },
      });
      // Legacy ACP-draft payload (no commands array at all). Should also
      // stay silent — informational metadata, not a protocol violation.
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'available_commands_update',
        },
      });
      // Real model output continues normally.
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Still alive.' },
        },
      });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    const outputs: { type: string; content: string; metadata?: Record<string, unknown> }[] = [];
    const errors: Error[] = [];
    adapter.on('output', (message: { type: string; content: string; metadata?: Record<string, unknown> }) => {
      outputs.push(message);
    });
    adapter.on('error', (error: Error) => errors.push(error));

    const response = await adapter.sendMessage({ role: 'user', content: 'hello' });

    expect(response.content).toBe('Still alive.');
    expect(errors).toHaveLength(0);

    // No "Malformed ACP available commands update" red bubble.
    const malformedBubble = outputs.find((o) =>
      typeof o.content === 'string' && o.content.includes('Malformed ACP available commands update'),
    );
    expect(malformedBubble).toBeUndefined();

    // No "Available commands: none advertised." follow-up bubble.
    const noneAdvertisedBubble = outputs.find((o) =>
      typeof o.content === 'string' && o.content.includes('none advertised'),
    );
    expect(noneAdvertisedBubble).toBeUndefined();

    // No raw-JSON dump of session metadata into the chat.
    const rawSessionInfoBubble = outputs.find((o) =>
      typeof o.content === 'string' && o.content.includes('"session_info_update"'),
    );
    expect(rawSessionInfoBubble).toBeUndefined();

    // The actual assistant content must still come through.
    expect(outputs).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        content: 'Still alive.',
      }),
    );

    proc.exit();
  });

  it('keeps assistant chunks on a stable turn id when ACP messageId changes per chunk', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', (message) => {
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'agent-fragment-1',
          content: { type: 'text', text: 'I' },
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'agent-fragment-2',
          content: { type: 'text', text: "'m " },
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'agent-fragment-3',
          content: { type: 'text', text: 'ready' },
        },
      });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    const outputs: Array<{
      id: string;
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
    }> = [];
    adapter.on('output', (message: {
      id: string;
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
    }) => {
      outputs.push(message);
    });

    const response = await adapter.sendMessage({ role: 'user', content: 'hello' });

    const assistantOutputs = outputs.filter((message) => message.type === 'assistant');
    const streamingOutputs = assistantOutputs.filter((message) => message.metadata?.['streaming'] === true);
    const finalOutput = assistantOutputs.find((message) => message.metadata?.['streaming'] === false);

    expect(response.content).toBe("I'm ready");
    expect(streamingOutputs.map((message) => message.content)).toEqual([
      'I',
      "I'm ",
      "I'm ready",
    ]);
    expect(new Set(streamingOutputs.map((message) => message.id)).size).toBe(1);
    expect(finalOutput).toMatchObject({
      id: streamingOutputs[0]?.id,
      content: "I'm ready",
      metadata: expect.objectContaining({ streaming: false }),
    });
    expect(streamingOutputs.map((message) => message.metadata?.['acpMessageId'])).toEqual([
      'agent-fragment-1',
      'agent-fragment-2',
      'agent-fragment-3',
    ]);

    proc.exit();
  });

  it('round-trips ACP permission requests through sendRaw responses', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', async (message) => {
      proc.request(51, 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: {
          toolCallId: 'call-perm',
          title: 'Run tests',
          kind: 'execute',
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const permissionResponse = await proc.waitForMessage((incoming) =>
        'id' in incoming
        && incoming.id === 51
        && 'result' in incoming,
      ) as AcpJsonRpcSuccessResponse;

      expect(permissionResponse.result).toEqual({
        outcome: {
          outcome: 'selected',
          optionId: 'allow-once',
        },
      });

      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Permission granted.' },
        },
      });

      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    const inputRequiredHandler = vi.fn(async (payload: { id: string }) => {
      await adapter.sendRaw('allow', payload.id);
    });
    adapter.on('input_required', inputRequiredHandler);

    const response = await adapter.sendMessage({ role: 'user', content: 'run tests' });

    expect(inputRequiredHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acp_permission:51',
      }),
    );
    expect(response.content).toBe('Permission granted.');

    proc.exit();
  });

  it('round-trips ACP elicitation requests through sendRaw responses', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', async (message) => {
      proc.request('ask-1', 'elicitation/create', {
        sessionId: 'sess-acp-1',
        mode: 'form',
        message: 'Choose a strategy',
        requestedSchema: {
          type: 'object',
          properties: {
            strategy: { type: 'string', title: 'Strategy' },
          },
          required: ['strategy'],
        },
      });

      const elicitationResponse = await proc.waitForMessage((incoming) =>
        'id' in incoming
        && incoming.id === 'ask-1'
        && 'result' in incoming,
      ) as AcpJsonRpcSuccessResponse;

      expect(elicitationResponse.result).toEqual({
        action: 'accept',
        content: {
          strategy: 'balanced',
        },
      });

      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Using balanced.' },
        },
      });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    const inputRequiredHandler = vi.fn(async (payload: { id: string }) => {
      await adapter.sendRaw('balanced', payload.id);
    });
    adapter.on('input_required', inputRequiredHandler);

    const response = await adapter.sendMessage({ role: 'user', content: 'choose' });

    expect(inputRequiredHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acp_elicitation:ask-1',
        metadata: expect.objectContaining({
          type: 'acp_elicitation',
          schema: expect.objectContaining({
            type: 'object',
          }),
        }),
      }),
    );
    expect(response.content).toBe('Using balanced.');

    proc.exit();
  });

  it('can resolve ACP permission requests through the permission registry bridge', async () => {
    const proc = createInitializedAgentHarness();

    const registry = PermissionRegistry.getInstance();
    registry.on('permission:requested', (request) => {
      registry.resolve(request.id, true, 'auto_approve');
    });

    proc.onRequest('session/prompt', async (message) => {
      proc.request('perm-77', 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: {
          toolCallId: 'call-registry',
          title: 'Edit config',
          kind: 'edit',
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const permissionResponse = await proc.waitForMessage((incoming) =>
        'id' in incoming
        && incoming.id === 'perm-77'
        && 'result' in incoming,
      ) as AcpJsonRpcSuccessResponse;

      expect(permissionResponse.result).toEqual({
        outcome: {
          outcome: 'selected',
          optionId: 'allow-once',
        },
      });

      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-acp' },
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'edit config' });

    proc.exit();
  });

  it('reuses the same session across multiple prompt turns', async () => {
    const proc = createInitializedAgentHarness();

    let promptCount = 0;
    proc.onRequest('session/prompt', (message) => {
      promptCount += 1;
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `turn-${promptCount}` },
        },
      });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    const first = await adapter.sendMessage({ role: 'user', content: 'first' });
    const second = await adapter.sendMessage({ role: 'user', content: 'second' });

    const promptRequests = proc.receivedMessages.filter((message) =>
      'method' in message && message.method === 'session/prompt',
    ) as AcpJsonRpcRequest[];

    expect(promptRequests).toHaveLength(2);
    expect(promptRequests[0]?.params).toMatchObject({ sessionId: 'sess-acp-1' });
    expect(promptRequests[1]?.params).toMatchObject({ sessionId: 'sess-acp-1' });
    expect(first.content).toBe('turn-1');
    expect(second.content).toBe('turn-2');

    proc.exit();
  });

  it('serializes image data URL attachments as ACP image blocks', async () => {
    const proc = createInitializedAgentHarness();

    let promptBlocks: unknown[] | undefined;
    proc.onRequest('session/prompt', (message) => {
      promptBlocks = (message.params as { prompt: unknown[] }).prompt;
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    await adapter.sendInput('Inspect this screenshot', [
      {
        name: 'screenshot.png',
        type: 'image/png',
        size: 3,
        data: 'data:image/png;base64,QUJD',
      },
    ]);

    expect(promptBlocks).toEqual([
      { type: 'text', text: 'Inspect this screenshot' },
      {
        type: 'image',
        data: 'QUJD',
        mimeType: 'image/png',
        uri: 'attachment://screenshot.png',
      },
    ]);

    proc.exit();
  });

  it('serializes binary data URL attachments as ACP blob resources', async () => {
    const proc = createInitializedAgentHarness();

    let promptBlocks: unknown[] | undefined;
    proc.onRequest('session/prompt', (message) => {
      promptBlocks = (message.params as { prompt: unknown[] }).prompt;
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    await adapter.sendInput('Review the attachment', [
      {
        name: 'report.pdf',
        type: 'application/pdf',
        size: 8,
        data: 'data:application/pdf;base64,JVBERi0x',
      },
    ]);

    expect(promptBlocks).toEqual([
      { type: 'text', text: 'Review the attachment' },
      {
        type: 'resource',
        resource: {
          uri: 'attachment://report.pdf',
          mimeType: 'application/pdf',
          blob: 'JVBERi0x',
          title: 'report.pdf',
        },
      },
    ]);

    proc.exit();
  });

  it('injects the ACP system prompt only on the first prompt turn', async () => {
    const proc = createInitializedAgentHarness();

    const promptPayloads: Array<{ prompt: unknown[] }> = [];
    proc.onRequest('session/prompt', (message) => {
      promptPayloads.push(message.params as { prompt: unknown[] });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      systemPrompt: 'Follow the orchestration rubric.',
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'first turn' });
    await adapter.sendMessage({ role: 'user', content: 'second turn' });

    expect(promptPayloads).toHaveLength(2);
    expect(promptPayloads[0]).toMatchObject({
      sessionId: 'sess-acp-1',
      prompt: [
        {
          type: 'text',
          text: '[SYSTEM INSTRUCTIONS]\nFollow the orchestration rubric.\n[/SYSTEM INSTRUCTIONS]',
        },
        { type: 'text', text: 'first turn' },
      ],
    });
    expect(promptPayloads[1]).toMatchObject({
      sessionId: 'sess-acp-1',
      prompt: [
        { type: 'text', text: 'second turn' },
      ],
    });

    proc.exit();
  });

  // ============ Regression: ACP request hang prevention ============
  //
  // These cover the "Making edits / Processing…" hang observed when the
  // Copilot ACP agent stops responding mid-turn:
  //   - sendRequest now has a per-method timeout so pendingRequests can't
  //     accumulate forever,
  //   - interrupt()/cancelCurrentPrompt() actually rejects the in-flight
  //     session/prompt promise instead of fire-and-forgetting a notification,
  //   - sendInput() surfaces errors as `error` OutputMessages (previously the
  //     UI kept showing "Processing…" because thrown errors were swallowed).

  it('rejects session/prompt after promptTimeoutMs when the agent never responds', async () => {
    const proc = createInitializedAgentHarness();

    // Intentionally never respond to session/prompt — simulates the hang.
    proc.onRequest('session/prompt', () => {
      /* no-op: agent is "hung" */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      promptTimeoutMs: 50,
    });
    await adapter.spawn();

    await expect(
      adapter.sendMessage({ role: 'user', content: 'hello' }),
    ).rejects.toThrow(/session\/prompt request timed out after 50ms/);

    proc.exit();
  });

  it('sendInput leaves session/prompt timeouts retryable and returns to idle', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', () => {
      /* no-op: agent is "hung" */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      promptTimeoutMs: 50,
    });
    await adapter.spawn();

    const statuses: string[] = [];
    const outputs: Array<{ type: string; content: string; metadata?: Record<string, unknown> }> = [];
    const errors: Error[] = [];
    adapter.on('status', (status: string) => statuses.push(status));
    adapter.on('output', (message: { type: string; content: string; metadata?: Record<string, unknown> }) => {
      outputs.push(message);
    });
    adapter.on('error', (error: Error) => errors.push(error));

    await adapter.sendInput('hello');

    expect(statuses).toEqual(['busy', 'idle']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/session\/prompt request timed out after 50ms/);
    expect(outputs).toContainEqual(
      expect.objectContaining({
        type: 'error',
        content: expect.stringMatching(/session\/prompt request timed out after 50ms/),
        metadata: expect.objectContaining({
          recoverable: true,
          retryKind: 'acp-prompt-timeout',
        }),
      }),
    );

    proc.exit();
  });

  it('rejects non-prompt ACP requests after requestTimeoutMs when the agent is silent', async () => {
    const proc = new FakeAcpProcess();
    // Respond to initialize but never to session/new — forces spawn() to hit
    // the request timeout for the latter.
    proc.onRequest('initialize', (message) => {
      proc.respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
    });
    proc.onRequest('session/new', () => {
      /* no-op: agent stalls on session setup */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      requestTimeoutMs: 50,
    });

    await expect(adapter.spawn()).rejects.toThrow(/session\/new request timed out after 50ms/);
  });

  it('interrupt() cancels the in-flight prompt and rejects its promise locally', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', () => {
      /* intentionally never settle server-side */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      // Give it a very generous prompt timeout so we're sure the rejection
      // below comes from interrupt() and not the timeout watchdog.
      promptTimeoutMs: 60_000,
    });
    await adapter.spawn();

    const pending = adapter.sendMessage({ role: 'user', content: 'work' });

    // Wait for the session/prompt to actually land on the agent before cancelling.
    await proc.waitForMessage((message) =>
      'method' in message && message.method === 'session/prompt',
    );

    expect(adapter.interrupt()).toEqual({
      status: 'accepted',
      turnId: expect.any(String),
    });

    await expect(pending).rejects.toThrow(/cancelled by the client/);

    // A session/cancel notification must have been sent to the agent.
    const cancelSent = proc.receivedMessages.some((message) =>
      'method' in message && message.method === 'session/cancel',
    );
    expect(cancelSent).toBe(true);

    proc.exit();
  });

  it('sendInput surfaces "turn already in flight" errors as an error OutputMessage', async () => {
    const proc = createInitializedAgentHarness();

    // Hold the first prompt open; we don't want it to resolve before the
    // second sendInput tries to run.
    proc.onRequest('session/prompt', () => {
      /* no-op: keep turn in flight */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      promptTimeoutMs: 60_000,
    });
    await adapter.spawn();

    const outputs: { type: string; content: string }[] = [];
    adapter.on('output', (message: { type: string; content: string }) => {
      outputs.push({ type: message.type, content: message.content });
    });
    const statusEvents: string[] = [];
    adapter.on('status', (status: string) => statusEvents.push(status));
    // Register an `error` listener so EventEmitter's default "unhandled
    // error" behavior (rethrowing) doesn't kill the test. Real callers
    // (instance manager) always register one.
    const errorEvents: Error[] = [];
    adapter.on('error', (err: Error) => errorEvents.push(err));

    // Kick off the first turn without awaiting it (we don't want to block).
    const firstTurn = adapter.sendInput('first message').catch(() => {
      /* will eventually reject when we tear down */
    });

    // Wait until the agent sees the first prompt request before sending the second.
    await proc.waitForMessage((message) =>
      'method' in message && message.method === 'session/prompt',
    );

    await adapter.sendInput('second message while busy');

    const errorOutputs = outputs.filter((m) => m.type === 'error');
    expect(errorOutputs).toHaveLength(1);
    expect(errorOutputs[0]?.content).toMatch(/previous turn is still running/i);
    expect(statusEvents).toContain('error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.message).toMatch(/previous turn is still running/i);

    // Clean up the dangling first turn so the test process doesn't leak
    // a pending promise.
    adapter.interrupt();
    await firstTurn;

    proc.exit();
  });

  it('acquires a provider concurrency slot on spawn and releases on exit', async () => {
    const proc = createInitializedAgentHarness();

    const acquireCalls: string[] = [];
    const releaseCalls: string[] = [];
    const fakeRelease = vi.fn(() => {
      releaseCalls.push('released');
    });
    const fakeLimiter = {
      acquire: vi.fn(async (key: string) => {
        acquireCalls.push(key);
        return fakeRelease;
      }),
    };

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      concurrencyLimiter: fakeLimiter,
      concurrencyKey: 'copilot',
    });

    await adapter.spawn();
    expect(acquireCalls).toEqual(['copilot']);
    expect(releaseCalls).toEqual([]);

    proc.exit();
    // Process-exit path must free the slot even without an explicit terminate().
    expect(releaseCalls).toEqual(['released']);
  });

  it('refuses to spawn when the provider concurrency slot cannot be acquired', async () => {
    const proc = createInitializedAgentHarness();
    const acquireError = new Error('Timed out waiting 30ms for copilot slot');
    const fakeLimiter = {
      acquire: vi.fn(async () => {
        throw acquireError;
      }),
    };

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      concurrencyLimiter: fakeLimiter,
      concurrencyKey: 'copilot',
      concurrencyAcquireTimeoutMs: 30,
    });

    await expect(adapter.spawn()).rejects.toThrow(/copilot slot/);
    expect(proc.receivedMessages).toHaveLength(0);
  });

  it('releases the concurrency slot on terminate (and is idempotent)', async () => {
    const proc = createInitializedAgentHarness();

    const fakeRelease = vi.fn();
    const fakeLimiter = {
      acquire: vi.fn(async () => fakeRelease),
    };

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      concurrencyLimiter: fakeLimiter,
      concurrencyKey: 'copilot',
    });

    await adapter.spawn();
    await adapter.terminate(false);
    proc.exit();

    // Release must have been called exactly once overall — terminate + the
    // subsequent exit event should not double-release.
    expect(fakeRelease).toHaveBeenCalledTimes(1);
  });

  it('emits a stall_warning when a prompt turn receives no session/update for too long', async () => {
    const proc = createInitializedAgentHarness();

    // The agent accepts the prompt but never emits a session/update and
    // never settles the request. Simulates the "Making edits / Processing…"
    // hang pattern.
    proc.onRequest('session/prompt', () => {
      /* deliberately silent */
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      stallWarningMs: 40,
      promptTimeoutMs: 60_000,
    });
    await adapter.spawn();

    const errorOutputs: { content: string; metadata: Record<string, unknown> }[] = [];
    adapter.on('output', (message: { type: string; content: string; metadata: Record<string, unknown> }) => {
      if (message.type === 'error') {
        errorOutputs.push({ content: message.content, metadata: message.metadata });
      }
    });
    const stallEvents: Array<Record<string, unknown>> = [];
    adapter.on('stall_warning', (payload: Record<string, unknown>) => stallEvents.push(payload));

    const pending = adapter.sendMessage({ role: 'user', content: 'hang please' });
    // Wait past the stall threshold.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(stallEvents).toHaveLength(1);
    expect(stallEvents[0]).toMatchObject({ adapter: expect.any(String) });
    expect(errorOutputs.some((m) => m.metadata['source'] === 'acp-stall-warning')).toBe(true);

    // Let the pending promise drain so the test doesn't hang; cancel will
    // reject it locally now (fix #3).
    adapter.interrupt();
    await pending.catch(() => { /* expected */ });

    proc.exit();
  });

  it('does not emit a stall_warning when the agent stays responsive', async () => {
    const proc = createInitializedAgentHarness();

    proc.onRequest('session/prompt', (message) => {
      // Emit several updates well inside the stall threshold, then settle.
      const nudge = (text: string) => proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
      nudge('tick ');
      setTimeout(() => nudge('tock '), 20);
      setTimeout(() => {
        nudge('done');
        proc.respond(message.id, { stopReason: 'end_turn' });
      }, 40);
    });

    const adapter = new TestAcpCliAdapter(proc, {
      command: process.execPath,
      workingDirectory: '/tmp',
      stallWarningMs: 100,
    });
    await adapter.spawn();

    const stallEvents: Array<Record<string, unknown>> = [];
    adapter.on('stall_warning', (payload: Record<string, unknown>) => stallEvents.push(payload));

    const response = await adapter.sendMessage({ role: 'user', content: 'responsive please' });
    expect(response.content).toBe('tick tock done');
    expect(stallEvents).toHaveLength(0);

    proc.exit();
  });
});
