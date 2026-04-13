import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { LspWorkerGateway } from '../gateway-rpc';

class FakeWorker extends EventEmitter {
  public requests: unknown[] = [];

  constructor(private readonly onPostMessage?: (message: unknown, worker: FakeWorker) => void) {
    super();
  }

  postMessage(message: unknown): void {
    this.requests.push(message);
    this.onPostMessage?.(message, this);
  }

  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

describe('LspWorkerGateway', () => {
  it('resolves successful worker responses', async () => {
    const worker = new FakeWorker((message, currentWorker) => {
      const request = message as { id: number };
      setImmediate(() => {
        currentWorker.emit('message', { id: request.id, ok: true, result: { pong: true } });
      });
    });
    const gateway = new LspWorkerGateway({
      workerFactory: () => worker as unknown as Worker,
    });

    await expect(gateway.ping()).resolves.toEqual({ pong: true });
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[0]).toMatchObject({ type: 'ping' });
    expect(worker.requests[1]).toMatchObject({ type: 'ping' });
  });

  it('times out requests that never receive a response', async () => {
    const worker = new FakeWorker();
    const gateway = new LspWorkerGateway({
      requestTimeoutMs: 25,
      workerFactory: () => worker as unknown as Worker,
    });

    await expect(gateway.ping()).rejects.toThrow('LSP worker request timed out: ping');
  });

  it('sends warm-workspace requests through ready()', async () => {
    const worker = new FakeWorker((message, currentWorker) => {
      const request = message as { id: number; type: string; payload: { workspacePath: string; language: string } };
      setImmediate(() => {
        currentWorker.emit('message', {
          id: request.id,
          ok: true,
          result: {
            ready: true,
            filePath: `${request.payload.workspacePath}/src/index.ts`,
          },
        });
      });
    });
    const gateway = new LspWorkerGateway({
      workerFactory: () => worker as unknown as Worker,
    });

    const result = await gateway.ready('/repo', 'typescript');

    expect(result).toEqual({
      ready: true,
      filePath: '/repo/src/index.ts',
    });
    expect(worker.requests[0]).toMatchObject({
      type: 'ping',
    });
    expect(worker.requests[1]).toMatchObject({
      type: 'warm-workspace',
      payload: {
        workspacePath: '/repo',
        language: 'typescript',
      },
    });
  });
});
