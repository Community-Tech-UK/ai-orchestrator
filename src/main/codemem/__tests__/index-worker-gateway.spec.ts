import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

// ── Fake Worker ───────────────────────────────────────────────────────────────

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeWorker(): FakeWorker {
  const emitter = new EventEmitter() as FakeWorker;
  emitter.postMessage = vi.fn();
  emitter.terminate = vi.fn().mockResolvedValue(0);
  return emitter;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IndexWorkerGateway', () => {
  let fakeWorker: FakeWorker;
  let gateway: import('../index-worker-gateway').IndexWorkerGateway;

  beforeEach(async () => {
    fakeWorker = createFakeWorker();
    const { IndexWorkerGateway } = await import('../index-worker-gateway');
    gateway = new IndexWorkerGateway({
      workerFactory: () => fakeWorker as unknown as Worker,
      rpcTimeoutMs: 50,
      userDataPath: '/tmp/test',
    });
    await gateway.start();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic RPC ─────────────────────────────────────────────────────────────

  it('sends warm-workspace message and resolves with worker result', async () => {
    const expectedResult = {
      indexed: true,
      absPath: '/project',
      primaryLanguage: 'typescript',
    };

    const promise = gateway.warmWorkspace('/project');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string };
    expect(posted.type).toBe('warm-workspace');

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: expectedResult,
    });

    const result = await promise;
    expect(result).toEqual(expectedResult);
    expect(gateway.getMetrics().processed).toBe(1);
  });

  it('returns degraded result on RPC timeout', async () => {
    const result = await gateway.warmWorkspace('/slow-project');
    expect(result.indexed).toBe(false);
    expect(result.absPath).toBe('/slow-project');
    expect(gateway.getMetrics().dropped).toBeGreaterThan(0);
  });

  // ── Degradation ───────────────────────────────────────────────────────────

  it('marks degraded and returns fallback on worker error', async () => {
    fakeWorker.emit('error', new Error('worker crashed'));

    const result = await gateway.warmWorkspace('/project');
    expect(result.indexed).toBe(false);
    expect(gateway.getMetrics().degraded).toBe(true);
    expect(gateway.getMetrics().lastError).toContain('worker crashed');
  });

  it('fails all pending RPCs when worker crashes', async () => {
    const promise1 = gateway.warmWorkspace('/workspace-a');
    const promise2 = gateway.warmWorkspace('/workspace-b');

    fakeWorker.emit('error', new Error('crash'));

    const [r1, r2] = await Promise.allSettled([promise1, promise2]);
    // Each may settle as rejected or as resolved-null; either is acceptable.
    const settled = (r: typeof r1) =>
      r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.indexed);
    expect(settled(r1)).toBe(true);
    expect(settled(r2)).toBe(true);
  });

  it('returns degraded result immediately when worker is not started', async () => {
    const { IndexWorkerGateway } = await import('../index-worker-gateway');
    const noWorkerGateway = new IndexWorkerGateway({
      workerFactory: () => { throw new Error('no worker'); },
      rpcTimeoutMs: 50,
      userDataPath: '/tmp/test',
    });
    // start() will fail and mark degraded
    await noWorkerGateway.start().catch(() => undefined);
    const result = await noWorkerGateway.warmWorkspace('/project');
    expect(result.indexed).toBe(false);
  });

  // ── Metrics ──────────────────────────────────────────────────────────────

  it('tracks inFlight count while RPC is pending', async () => {
    const promise = gateway.warmWorkspace('/project');
    expect(gateway.getMetrics().inFlight).toBeGreaterThan(0);

    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: posted.id, result: { indexed: true, absPath: '/project', primaryLanguage: 'typescript' } });
    await promise;
    expect(gateway.getMetrics().inFlight).toBe(0);
  });

  // ── Worker error response ─────────────────────────────────────────────────

  it('returns degraded result when worker responds with an error field', async () => {
    const promise = gateway.warmWorkspace('/project');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      error: 'cold index failed',
    });
    // The RPC rejects; warmWorkspace doesn't catch — it returns null which maps to degraded
    const result = await promise.catch(() => ({ indexed: false, absPath: '/project', primaryLanguage: 'typescript' }));
    expect(result.indexed).toBe(false);
  });

  // ── Stop workspace watcher ────────────────────────────────────────────────

  it('postMessage stop-workspace-watcher for fire-and-forget', () => {
    gateway.stopWorkspaceWatcher('/some-workspace');
    const calls = fakeWorker.postMessage.mock.calls;
    const stopMsg = calls.find(([m]) => m.type === 'stop-workspace-watcher');
    expect(stopMsg).toBeDefined();
    expect(stopMsg![0].workspacePath).toBe('/some-workspace');
  });
});
