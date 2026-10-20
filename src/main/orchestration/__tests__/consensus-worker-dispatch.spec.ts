import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnWorkerInboundMsg } from '../../cli/spawn-worker/cli-spawn-worker-protocol';

const fixture = vi.hoisted(() => ({ adapter: undefined as unknown }));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({ createAdapter: () => fixture.adapter }),
}));
vi.mock('../../instance/lifecycle/provider-route-preflight', () => ({
  attachProviderRoutes: async (_type: unknown, options: unknown) => options,
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({}) }),
}));
vi.mock('../../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({ isPaused: () => false }),
}));
vi.mock('../../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: vi.fn() }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CliAdapterWorkerProxy } from '../../cli/spawn-worker/cli-adapter-worker-proxy';
import { CliSpawnWorkerGateway } from '../../cli/spawn-worker/cli-spawn-worker-gateway';
import { CliDetectionService } from '../../cli/cli-detection';
import { isProviderDispatchNotStarted } from '../../cli/adapters/provider-dispatch-status';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';
import { ConsensusCoordinator } from '../consensus-coordinator';

type Mode = 'refused' | 'paid' | 'zero';

/** Controlled worker transport; the real gateway and proxy own turn finality. */
class ProtocolWorker extends EventEmitter {
  readonly requests: SpawnWorkerInboundMsg[] = [];

  constructor(private readonly mode: Mode) { super(); }

  postMessage(message: SpawnWorkerInboundMsg): void {
    this.requests.push(message);
    if (message.type === 'signal') return;
    queueMicrotask(() => {
      if (message.type === 'spawn' && message.args.includes('--version')) {
        this.emit('message', { type: 'rpc-response', id: message.id, result: { pid: 10101 } });
      } else if (message.type === 'spawn' && this.mode === 'refused') {
        this.emit('message', { type: 'rpc-response', id: message.id, error: 'Controlled prompt spawn refusal' });
      } else if (message.type === 'spawn') {
        this.emit('message', { type: 'spawned', instanceId: message.instanceId, pid: 10102 });
        this.emit('message', { type: 'rpc-response', id: message.id, result: { pid: 10102 } });
        queueMicrotask(() => {
          const frame = (value: unknown) => this.emit('message', {
            type: 'stdout-chunk', instanceId: message.instanceId, chunk: JSON.stringify(value) + '\n',
          });
          frame({ type: 'message', role: 'assistant', content: 'Controlled Gemini answer' });
          frame({ type: 'result', total_cost_usd: this.mode === 'paid' ? 0.25 : 0,
            usage: { input_tokens: 10, output_tokens: 5 } });
          this.emit('message', { type: 'exited', instanceId: message.instanceId, code: 0, signal: null });
        });
      } else this.emit('message', { type: 'rpc-response', id: message.id, result: {} });
    });
  }

  async terminate(): Promise<number> { return 0; }
}

afterEach(() => {
  ConsensusCoordinator._resetForTesting();
  vi.restoreAllMocks();
});

describe('consensus worker dispatch accounting', () => {
  it.each(['refused', 'paid', 'zero'] as const)('preserves the model-call boundary for %s', async mode => {
    const worker = new ProtocolWorker(mode);
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () => worker, rpcTimeoutMs: 100 });
    const adapter = new CliAdapterWorkerProxy({ cliType: 'gemini', instanceId: 'consensus-worker-fixture',
      options: { model: 'gemini-3-flash-preview', workingDirectory: '/tmp' }, gateway });
    fixture.adapter = adapter;
    const send = vi.spyOn(adapter, 'sendInput');
    vi.spyOn(CliDetectionService.getInstance(), 'detectAll').mockResolvedValue({
      available: [{ name: 'gemini' }], unavailable: [],
    } as unknown as Awaited<ReturnType<CliDetectionService['detectAll']>>);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    try {
      const result = await ConsensusCoordinator.getInstance().query('Compare scheduling options', undefined, {
        providers: [{ provider: 'gemini', model: 'gemini-3-flash-preview' }], workingDirectory: '/tmp', timeout: 1,
      });
      expect(worker.requests.filter(request => request.type === 'spawn' && request.args.includes('--version'))).toHaveLength(1);
      expect(worker.requests.filter(request => request.type === 'spawn' && !request.args.includes('--version'))).toHaveLength(1);
      expect(send).toHaveBeenCalledOnce();
      if (mode === 'refused') {
        const failure = await send.mock.results[0].value.then(() => null, (error: unknown) => error);
        expect(isProviderDispatchNotStarted(failure)).toBe(true);
        expect(result.responses[0]?.success).toBe(false);
        expect(rows).toEqual([]);
      } else {
        expect(result.responses[0]?.success).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ purpose: 'consensus', provider: 'gemini', outcome: 'success',
          costKnown: true, costSource: 'provider', usage: { cost: mode === 'paid' ? 0.25 : 0 } });
      }
      expect(adapter.isRunning()).toBe(false);
      expect(ConsensusCoordinator.getInstance().getActiveQueryCount()).toBe(0);
      for (const event of ['usage', 'complete', 'error', 'turn_error', 'output', 'status', 'exit']) {
        expect(adapter.listenerCount(event)).toBe(0);
      }
    } finally {
      stop();
      await adapter.terminate(false);
      await gateway.close();
    }
  });
});
