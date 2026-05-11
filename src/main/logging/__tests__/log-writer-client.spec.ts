import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { LogWriterClient } from '../log-writer-client';

function buildFakeWorker() {
  const emitter = new EventEmitter();
  const messages: unknown[] = [];
  const worker = Object.assign(emitter, {
    postMessage: vi.fn((msg: unknown) => messages.push(msg)),
    messages,
    terminate: vi.fn(),
  });
  return worker;
}

describe('LogWriterClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends init message to worker on construction', () => {
    const worker = buildFakeWorker();
    new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    expect(worker.messages[0]).toMatchObject({
      type: 'init',
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
    });
  });

  it('batches lines and sends write-lines after flush interval', () => {
    const worker = buildFakeWorker();
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    client.writeLine('{"a":1}');
    client.writeLine('{"b":2}');

    // No write-lines yet (batching)
    const writeMsgs = worker.messages.filter((m: unknown) => (m as { type: string }).type === 'write-lines');
    expect(writeMsgs).toHaveLength(0);

    vi.advanceTimersByTime(300);

    const afterMsgs = worker.messages.filter((m: unknown) => (m as { type: string }).type === 'write-lines');
    expect(afterMsgs).toHaveLength(1);
    expect((afterMsgs[0] as { lines: string[] }).lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('flushes immediately when batch size is reached', () => {
    const worker = buildFakeWorker();
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    // 100 lines triggers immediate flush
    for (let i = 0; i < 100; i++) {
      client.writeLine(`{"i":${i}}`);
    }

    const writeMsgs = worker.messages.filter((m: unknown) => (m as { type: string }).type === 'write-lines');
    expect(writeMsgs).toHaveLength(1);
    expect((writeMsgs[0] as { lines: string[] }).lines).toHaveLength(100);
  });

  it('does not throw when workerFactory returns null (fallback mode)', () => {
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => null,
    });

    expect(() => client.writeLine('{"x":1}')).not.toThrow();
  });

  it('sends shutdown to worker and waits for exit', async () => {
    vi.useRealTimers();

    const worker = buildFakeWorker();
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    // Simulate worker exit on shutdown message
    const originalPost = worker.postMessage;
    worker.postMessage = vi.fn((msg: unknown) => {
      originalPost(msg);
      if ((msg as { type: string }).type === 'shutdown') {
        setImmediate(() => worker.emit('exit', 0));
      }
    });

    await client.shutdown();

    const shutdownMsg = worker.messages.find((m: unknown) => (m as { type: string }).type === 'shutdown');
    expect(shutdownMsg).toBeDefined();
  });

  it('exposes metrics from worker messages', () => {
    const worker = buildFakeWorker();
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    worker.emit('message', { type: 'metrics', written: 500, rotations: 1, errors: 0 });

    expect(client.metrics()).toMatchObject({ workerWritten: 500, workerRotations: 1, workerErrors: 0 });
  });

  it('increments workerErrors and falls back when worker crashes', () => {
    const worker = buildFakeWorker();
    const client = new LogWriterClient({
      logFile: '/tmp/app.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      currentFileSize: 0,
      workerFactory: () => worker as never,
    });

    // Simulate worker crash
    worker.emit('error', new Error('crash'));

    expect(client.metrics().workerErrors).toBe(1);
    // After crash, writeLine should not throw
    expect(() => client.writeLine('{"x":1}')).not.toThrow();
  });
});
