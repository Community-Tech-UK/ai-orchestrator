import { createHash } from 'node:crypto';
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
    handleLine(line: string): void;
    handleExit(error?: Error): void;
    isRunning(): boolean;
    setContextDiagnosticsCollector(collector: CodexContextPressureCollector | null): void;
    setNotificationHandler(handler: ((notification: { method: string; params: Record<string, unknown> }) => void) | null): void;
  };
}

describe('app-server transport liveness', () => {
  it('reports running until the transport exits', () => {
    const client = createClientDispatchHarness();

    expect(client.isRunning()).toBe(true);

    client.handleExit(new Error('synthetic disconnect'));

    expect(client.isRunning()).toBe(false);
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
