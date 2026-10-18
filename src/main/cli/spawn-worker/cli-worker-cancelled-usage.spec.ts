import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliSpawnWorkerGateway, type CliSpawnWorkerLike, type CliSpawnGatewayPort } from './cli-spawn-worker-gateway';
import { CliAdapterWorkerProxy } from './cli-adapter-worker-proxy';
import { sendAbortableReviewerMessage } from '../../review/review-execution-host';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';

// Exercises the build:main worker artifact and real RPC/process/stdio teardown.
// The child is a disposable Node fixture, so no provider or paid request runs.
describe('worker cancellation accounting', () => {
  it.each([[false, false], [true, false], [true, true]])(
    'drains closure before teardown acknowledgement (paid=%s, graceful=%s)', async (paid, graceful) => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    const frames: { type: string }[] = [];
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () => {
      const worker = new Worker(resolve('dist/main/cli/spawn-worker/cli-spawn-worker-main.js'));
      worker.on('message', frame => frames.push(frame));
      return worker as CliSpawnWorkerLike;
    } });
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'cancel-fixture',
      options: { workingDirectory: process.cwd() }, gateway });
    const ready = vi.fn();
    proxy.on('stderr', ready);
    vi.spyOn(proxy as unknown as { command(): string }, 'command').mockReturnValue(process.execPath);
    const result = JSON.stringify({ type: 'result', total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 10 } });
    vi.spyOn(proxy as unknown as { buildArgs(): string[] }, 'buildArgs').mockReturnValue(['-e',
      `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});process.stdin.once('data',()=>{${paid ? `process.stdout.write(${JSON.stringify(result)});` : ''}process.stderr.write('fixture-ready');});process.stdin.resume();setInterval(()=>{},1000);`]);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const abort = new AbortController();
    try {
      const caller = sendAbortableReviewerMessage(proxy, { role: 'user', content: 'fixture' }, abort.signal,
        undefined, { purpose: 'cross-model-review', provider: 'claude', model: 'fixture-model' }).catch(error => error);
      await vi.waitFor(() => expect(ready).toHaveBeenCalled(), { timeout: 5000 });
      if (graceful) {
        await proxy.terminate(true);
        expect((await caller).usage?.cost).toBe(0.25);
      } else {
        abort.abort();
        expect((await caller).message).toBe('Review cancelled');
      }
      await vi.waitFor(() => expect(rows).toHaveLength(1), { timeout: 5000 });
      expect(rows[0]).toMatchObject({ outcome: graceful ? 'success' : 'cancelled', costKnown: paid,
        costSource: paid ? 'provider' : 'unknown' });
      if (paid) expect(rows[0].usage?.cost).toBe(0.25);
      expect(proxy.listenerCount('usage')).toBe(0);
      expect(proxy.listenerCount('complete')).toBe(0);
      expect(proxy.listenerCount('exit')).toBe(0);
      const exited = frames.findIndex(frame => frame.type === 'exited');
      expect(exited).toBeGreaterThan(-1);
      expect(frames.slice(exited + 1).some(frame => frame.type === 'rpc-response')).toBe(true);
    } finally {
      stop();
      await proxy.terminate(false);
      await gateway.close();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  }, 15000);

  it.each([false, true])('settles a pending send and detaches after failed teardown (paid=%s)', async paid => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    let handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | undefined;
    const gateway: CliSpawnGatewayPort = {
      registerInstance: (_id, next) => { handler = next; },
      unregisterInstance: vi.fn(),
      spawnInstance: async () => { handler?.spawned?.(123); return { pid: 123 }; },
      writeStdin: vi.fn(async () => undefined),
      sendSignal: vi.fn(),
      terminate: async () => { throw new Error('Worker unavailable'); },
    };
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'failed-teardown',
      options: { workingDirectory: process.cwd() }, gateway });
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const abort = new AbortController();
    try {
      const caller = sendAbortableReviewerMessage(proxy, { role: 'user', content: 'fixture' }, abort.signal,
        undefined, { purpose: 'cross-model-review', provider: 'claude' }).catch(error => error);
      await vi.waitFor(() => expect(proxy.isRunning()).toBe(true));
      if (paid) handler?.stdout?.(JSON.stringify({ type: 'result', total_cost_usd: 0.25,
        usage: { input_tokens: 100, output_tokens: 10 } }));
      abort.abort();
      expect((await caller).message).toBe('Review cancelled');
      await vi.waitFor(() => expect(rows).toHaveLength(1));
      expect(rows[0]).toMatchObject({ outcome: 'cancelled', costKnown: paid });
      if (paid) expect(rows[0].usage?.cost).toBe(0.25);
      expect(proxy.listenerCount('usage')).toBe(0);
      expect(proxy.listenerCount('complete')).toBe(0);
      expect(proxy.listenerCount('exit')).toBe(0);
      expect(gateway.unregisterInstance).toHaveBeenCalledWith('failed-teardown');
    } finally { stop(); vi.unstubAllEnvs(); }
  });

  it.each(['formatting', 'spawning'])('owns teardown when cancelled during %s', async phase => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    let handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | undefined;
    let finishSpawn!: () => void;
    let finishFormat!: () => void;
    const gateway: CliSpawnGatewayPort = {
      registerInstance: (_id, next) => { handler = next; },
      unregisterInstance: vi.fn(() => { handler = undefined; }),
      spawnInstance: vi.fn(() => new Promise<{ pid: number }>(resolve => { finishSpawn = () => {
        handler?.spawned?.(123); resolve({ pid: 123 });
      }; })),
      writeStdin: vi.fn(async () => undefined),
      sendSignal: vi.fn(),
      terminate: vi.fn(async () => { handler?.exited?.(null, 'SIGKILL'); }),
    };
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'startup-cancel',
      options: { workingDirectory: process.cwd() }, gateway });
    vi.spyOn(proxy as unknown as { formatClaudeInput(): Promise<string> }, 'formatClaudeInput')
      .mockImplementation(() => new Promise(resolve => { finishFormat = () => resolve('fixture'); }));
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const abort = new AbortController();
    try {
      const caller = sendAbortableReviewerMessage(proxy, { role: 'user', content: 'fixture' }, abort.signal,
        undefined, { purpose: 'cross-model-review', provider: 'claude' }).catch(error => error);
      if (phase === 'spawning') {
        finishFormat();
        await vi.waitFor(() => expect(gateway.spawnInstance).toHaveBeenCalled());
      }
      abort.abort();
      expect((await caller).message).toBe('Review cancelled');
      if (phase === 'formatting') finishFormat();
      else finishSpawn();
      await vi.waitFor(() => expect(proxy.listenerCount('usage')).toBe(0), { timeout: 500 });
      expect(rows).toHaveLength(0);
      expect(gateway.writeStdin).not.toHaveBeenCalled();
      expect(proxy.listenerCount('usage')).toBe(0);
      expect(proxy.listenerCount('complete')).toBe(0);
      expect(proxy.listenerCount('exit')).toBe(0);
      expect(gateway.spawnInstance).toHaveBeenCalledTimes(phase === 'formatting' ? 0 : 1);
      expect(gateway.terminate).toHaveBeenCalledTimes(phase === 'formatting' ? 0 : 1);
    } finally { stop(); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
  });
});
