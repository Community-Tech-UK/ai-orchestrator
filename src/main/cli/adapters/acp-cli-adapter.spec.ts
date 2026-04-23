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
    expect(statusHandler).toHaveBeenCalledWith('ready');

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
});
