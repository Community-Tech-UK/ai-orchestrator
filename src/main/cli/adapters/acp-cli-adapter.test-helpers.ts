import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { PassThrough, Writable } from 'stream';
import { vi } from 'vitest';
import { AcpCliAdapter } from './acp-cli-adapter';
import type {
  AcpJsonRpcMessage,
  AcpJsonRpcRequest,
} from '../../../shared/types/cli.types';

export class FakeAcpProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 4242;
  killed = false;

  private stdinBuffer = '';
  private readonly handlers = new Map<string, (message: AcpJsonRpcRequest) => void | Promise<void>>();
  readonly receivedMessages: AcpJsonRpcMessage[] = [];
  private readonly waiters: {
    predicate: (message: AcpJsonRpcMessage) => boolean;
    resolve: (message: AcpJsonRpcMessage) => void;
  }[] = [];

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

  respondError(id: string | number, code: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
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

export function createInitializedAgentHarness(): FakeAcpProcess {
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

export class TestAcpCliAdapter extends AcpCliAdapter {
  constructor(
    private readonly proc: FakeAcpProcess,
    config: ConstructorParameters<typeof AcpCliAdapter>[0],
  ) {
    super(config);
  }

  override async checkStatus() {
    return { available: true };
  }

  protected override spawnProcess(args: string[]): ChildProcess {
    void args;
    this.emit('spawned', this.proc.pid);
    return this.proc as unknown as ChildProcess;
  }
}
