import { createHash } from 'node:crypto';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as appServerClientModule from './app-server-client';
import { CodexContextPressureCollector, type CodexContextDiagnosticRecord } from './context-pressure-diagnostics';

const { terminateProcessTree, checkAppServerAvailability, ProtocolError } = appServerClientModule;

function createClientDispatchHarness() {
  const Base = (appServerClientModule as unknown as {
    AppServerClientBase?: new (cwd: string, transport: 'direct' | 'broker') => unknown;
  }).AppServerClientBase;
  expect(Base).toBeTypeOf('function');
  if (!Base) throw new Error('AppServerClientBase is not exported');

  return Reflect.construct(Base, ['/tmp/project', 'direct']) as {
    handleChunk(chunk: string): void;
    handleLine(line: string): void;
    handleExit(error?: Error): void;
    isRunning(): boolean;
    setContextDiagnosticsCollector(collector: CodexContextPressureCollector | null): void;
    setNotificationHandler(handler: ((notification: { method: string; params: Record<string, unknown> }) => void) | null): void;
    subscribeNotifications(handler: (notification: { method: string; params: Record<string, unknown> }) => void): () => void;
  };
}

function createWritableClientDispatchHarness() {
  const Base = (appServerClientModule as unknown as {
    AppServerClientBase?: new (cwd: string, transport: 'direct' | 'broker') => {
      initialize(clientInfo?: unknown, capabilities?: unknown): Promise<void>;
      request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
    };
  }).AppServerClientBase;
  expect(Base).toBeTypeOf('function');
  if (!Base) throw new Error('AppServerClientBase is not exported');

  class WritableHarness extends Base {
    readonly sent: Record<string, unknown>[] = [];

    async close(): Promise<void> { /* test harness has no transport */ }

    protected sendMessage(message: Record<string, unknown>): void {
      this.sent.push(message);
    }

    dispatch(line: string): void {
      (this as unknown as { handleLine(value: string): void }).handleLine(line);
    }
  }

  return new WritableHarness('/tmp/project', 'direct');
}

describe('app-server transport liveness', () => {
  it('reports running until the transport exits', () => {
    const client = createClientDispatchHarness();

    expect(client.isRunning()).toBe(true);

    client.handleExit(new Error('synthetic disconnect'));

    expect(client.isRunning()).toBe(false);
  });
});

describe('socket broker transport lifecycle', () => {
  /**
   * Minimal broker stub on a real Unix socket: answers `initialize` so
   * connectToAppServer()'s handshake succeeds, then hands the live connection
   * to the test.
   */
  function startBrokerStub(): Promise<{
    endpoint: string;
    connection: () => net.Socket;
    close: () => Promise<void>;
  }> {
    const socketPath = path.join(
      os.tmpdir(),
      `aio-broker-spec-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    let conn: net.Socket | null = null;
    const server = net.createServer((socket) => {
      conn = socket;
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.id !== undefined && message.method === 'initialize') {
            socket.write(JSON.stringify({ id: message.id, result: { capabilities: {} } }) + '\n');
          }
        }
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve({
        endpoint: `unix:${socketPath}`,
        connection: () => {
          if (!conn) throw new Error('broker stub never received a connection');
          return conn;
        },
        close: () => new Promise<void>((res) => server.close(() => res())),
      }));
    });
  }

  it.skipIf(process.platform === 'win32')(
    'close() resolves once the broker FINs back and drops all socket listeners',
    async () => {
      const broker = await startBrokerStub();
      try {
        const client = await appServerClientModule.connectToAppServer('/tmp/project', {
          brokerEndpoint: broker.endpoint,
        });
        expect(client.transport).toBe('broker');
        expect(client.isRunning()).toBe(true);

        await client.close();

        expect(client.isRunning()).toBe(false);
        // exitPromise resolved and listeners were released — nothing left to leak.
        await client.exitPromise;
      } finally {
        await broker.close();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a broker disconnect rejects in-flight requests and resolves the exit promise',
    async () => {
      const broker = await startBrokerStub();
      try {
        const client = await appServerClientModule.connectToAppServer('/tmp/project', {
          brokerEndpoint: broker.endpoint,
        });

        const inFlight = client.request(
          'thread/start' as never,
          {} as never,
          60_000,
        );
        // Attach the rejection expectation BEFORE the disconnect so the
        // rejection is never unhandled.
        const rejection = expect(inFlight).rejects.toThrow(/closed|Connection/i);
        broker.connection().destroy();

        await rejection;
        await client.exitPromise;
        expect(client.isRunning()).toBe(false);
      } finally {
        await broker.close();
      }
    },
  );
});

describe('app-server JSON-RPC routing', () => {
  it('deframes fragmented and batched socket chunks before routing notifications', () => {
    const client = createClientDispatchHarness();
    const handled: string[] = [];
    client.setNotificationHandler((notification) => handled.push(notification.method));

    client.handleChunk('{"method":"turn/started","params":{}}\n{"method":"turn/com');
    expect(handled).toEqual(['turn/started']);

    client.handleChunk('pleted","params":{}}\r\n');
    expect(handled).toEqual(['turn/started', 'turn/completed']);
  });

  it('enables the experimental API required by metadata-only thread resume', async () => {
    const client = createWritableClientDispatchHarness();

    const initialize = client.initialize();
    const requestId = client.sent[0]?.['id'];

    expect(client.sent[0]).toMatchObject({
      method: 'initialize',
      params: {
        capabilities: {
          experimentalApi: true,
        },
      },
    });

    client.dispatch(JSON.stringify({ id: requestId, result: {} }));
    await initialize;
  });

  it('responds to an unsupported server request instead of misclassifying it as a response', () => {
    const client = createWritableClientDispatchHarness();

    client.dispatch(JSON.stringify({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
    }));

    expect(client.sent).toEqual([{
      id: 77,
      error: { code: -32601, message: 'Method not supported by client' },
    }]);
  });

  it('rejects a response that violates the generated method contract', async () => {
    const client = createWritableClientDispatchHarness();
    const response = client.request('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    const requestId = client.sent[0]?.['id'];

    client.dispatch(JSON.stringify({ id: requestId, result: {} }));

    await expect(response).rejects.toMatchObject({
      name: 'CodexAppServerRuntimeError',
      kind: 'protocol-invalid',
      method: 'turn/start',
    });
  });

  it('rejects stale request fields before writing them to Codex', () => {
    const client = createWritableClientDispatchHarness();

    expect(() => client.request('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      reasoningEffort: 'high',
    } as never)).toThrow(/unsupported parameter: reasoningEffort/);
    expect(client.sent).toEqual([]);
  });
});

describe('app-server notification diagnostics', () => {
  it('records allowed transport notifications before the primary handler with a hashed thread correlation', () => {
    const client = createClientDispatchHarness();
    const order: string[] = [];
    const records: CodexContextDiagnosticRecord[] = [];
    const collector = new CodexContextPressureCollector({
      write: (record) => {
        records.push(record);
        order.push(record.kind);
      },
    });
    const rawThreadId = 'synthetic-private-thread-id';
    const expectedCorrelation = createHash('sha256').update(rawThreadId).digest('hex').slice(0, 12);

    client.setContextDiagnosticsCollector(collector);
    client.setNotificationHandler((notification) => order.push(`handled:${notification.method}`));

    client.handleLine(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: rawThreadId,
        tokenUsage: {
          last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1 },
          total: { totalTokens: 34, inputTokens: 30, cachedInputTokens: 8, outputTokens: 4, reasoningOutputTokens: 2 },
          modelContextWindow: 100,
        },
      },
    }));
    client.handleLine(JSON.stringify({
      method: 'thread/compacted',
      params: { threadId: rawThreadId },
    }));

    expect(order).toEqual([
      'transport-usage',
      'handled:thread/tokenUsage/updated',
      'transport-compaction',
      'handled:thread/compacted',
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'transport-usage',
        threadCorrelation: expectedCorrelation,
        contextWindow: 100,
        last: {
          totalTokens: 12,
          inputTokens: 10,
          cachedInputTokens: 4,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
        cumulative: {
          totalTokens: 34,
          inputTokens: 30,
          cachedInputTokens: 8,
          outputTokens: 4,
          reasoningOutputTokens: 2,
        },
      }),
      expect.objectContaining({
        kind: 'transport-compaction',
        threadCorrelation: expectedCorrelation,
      }),
    ]);
    expect(expectedCorrelation).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(records)).not.toContain(rawThreadId);
  });

  it('does not create transport records for other notification methods', () => {
    const client = createClientDispatchHarness();
    const records: CodexContextDiagnosticRecord[] = [];
    const handled: string[] = [];
    client.setContextDiagnosticsCollector(new CodexContextPressureCollector({
      write: (record) => records.push(record),
    }));
    client.setNotificationHandler((notification) => handled.push(notification.method));

    for (const method of ['turn/started', 'item/completed', 'turn/completed', 'error']) {
      client.handleLine(JSON.stringify({ method, params: { threadId: 'raw-thread-id' } }));
    }

    expect(records).toEqual([]);
    expect(handled).toEqual(['turn/started', 'item/completed', 'turn/completed', 'error']);
  });

  it('skips allowed transport records when the thread id is missing or non-string', () => {
    const client = createClientDispatchHarness();
    const records: CodexContextDiagnosticRecord[] = [];
    const handled: string[] = [];
    client.setContextDiagnosticsCollector(new CodexContextPressureCollector({
      write: (record) => records.push(record),
    }));
    client.setNotificationHandler((notification) => handled.push(notification.method));

    client.handleLine(JSON.stringify({ method: 'thread/compacted', params: {} }));
    client.handleLine(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 42, tokenUsage: { last: { totalTokens: 1 } } },
    }));

    expect(records).toEqual([]);
    expect(handled).toEqual(['thread/compacted', 'thread/tokenUsage/updated']);
  });

  it('routes malformed allowed notifications even when params are absent or null', () => {
    const client = createClientDispatchHarness();
    const records: CodexContextDiagnosticRecord[] = [];
    const handled: string[] = [];
    client.setContextDiagnosticsCollector(new CodexContextPressureCollector({
      write: (record) => records.push(record),
    }));
    client.setNotificationHandler((notification) => handled.push(notification.method));

    expect(() => client.handleLine(JSON.stringify({ method: 'thread/compacted' }))).not.toThrow();
    expect(() => client.handleLine(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: null,
    }))).not.toThrow();

    expect(records).toEqual([]);
    expect(handled).toEqual(['thread/compacted', 'thread/tokenUsage/updated']);
  });
});

describe('app-server notification subscriptions', () => {
  it('fans out notifications to the compatibility handler and scoped subscribers in registration order', () => {
    const client = createClientDispatchHarness();
    const handled: string[] = [];
    client.setNotificationHandler(() => handled.push('legacy'));
    client.subscribeNotifications(() => handled.push('first'));
    client.subscribeNotifications(() => handled.push('second'));

    client.handleLine(JSON.stringify({ method: 'turn/started', params: {} }));

    expect(handled).toEqual(['legacy', 'first', 'second']);
  });

  it('unsubscribes one consumer without disturbing the others', () => {
    const client = createClientDispatchHarness();
    const handled: string[] = [];
    const unsubscribeFirst = client.subscribeNotifications(() => handled.push('first'));
    client.subscribeNotifications(() => handled.push('second'));

    unsubscribeFirst();
    unsubscribeFirst();
    client.handleLine(JSON.stringify({ method: 'turn/started', params: {} }));

    expect(handled).toEqual(['second']);
  });

  it('uses a stable dispatch snapshot when subscriptions change inside a callback', () => {
    const client = createClientDispatchHarness();
    const handled: string[] = [];
    let unsubscribeSecond = () => { /* assigned before the first dispatch */ };
    client.subscribeNotifications(() => {
      handled.push('first');
      unsubscribeSecond();
      client.subscribeNotifications(() => handled.push('late'));
    });
    unsubscribeSecond = client.subscribeNotifications(() => handled.push('second'));

    client.handleLine(JSON.stringify({ method: 'turn/started', params: {} }));
    expect(handled).toEqual(['first', 'second']);

    handled.length = 0;
    client.handleLine(JSON.stringify({ method: 'turn/completed', params: {} }));
    expect(handled).toEqual(['first', 'late']);
  });

  it('isolates observer failures so later consumers still receive the notification', () => {
    const client = createClientDispatchHarness();
    const handled: string[] = [];
    client.subscribeNotifications(() => {
      throw new Error('observer failed');
    });
    client.subscribeNotifications((notification) => handled.push(notification.method));

    expect(() => {
      client.handleLine(JSON.stringify({ method: 'turn/completed', params: {} }));
    }).not.toThrow();
    expect(handled).toEqual(['turn/completed']);
  });
});

// ─── terminateProcessTree ───────────────────────────────────────────────────

describe('terminateProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when pid is undefined', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    terminateProcessTree(undefined);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('sends SIGTERM to the process group on Unix', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    terminateProcessTree(12345);

    // Should attempt process group kill with negative PID
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('falls back to single-process kill when process group kill fails', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (typeof pid === 'number' && pid < 0) {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    terminateProcessTree(42);

    // Should try group kill first, then single kill
    expect(killSpy).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(42, 'SIGTERM');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('silently ignores ESRCH (no such process)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    // Should not throw
    expect(() => terminateProcessTree(999)).not.toThrow();
    expect(killSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

// ─── checkAppServerAvailability ─────────────────────────────────────────────

describe('checkAppServerAvailability', () => {
  it('returns a boolean', () => {
    // This test just verifies the function doesn't throw and returns a boolean.
    // In CI, codex may not be installed, so we just check the return type.
    const result = checkAppServerAvailability();
    expect(typeof result).toBe('boolean');
  });
});

// ─── ProtocolError ──────────────────────────────────────────────────────────

describe('ProtocolError', () => {
  it('creates an error with message and data', () => {
    const error = new ProtocolError('test error', { code: -32001, detail: 'busy' });
    expect(error.message).toBe('test error');
    expect(error.data).toEqual({ code: -32001, detail: 'busy' });
    expect(error.rpcCode).toBe(-32001);
    expect(error.name).toBe('ProtocolError');
  });

  it('creates an error without rpcCode when data has no code', () => {
    const error = new ProtocolError('basic error', { detail: 'info' });
    expect(error.rpcCode).toBeUndefined();
  });

  it('creates an error without data', () => {
    const error = new ProtocolError('bare error');
    expect(error.data).toBeUndefined();
    expect(error.rpcCode).toBeUndefined();
  });
});
