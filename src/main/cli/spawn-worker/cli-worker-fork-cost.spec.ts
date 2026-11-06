import { describe, expect, it, vi } from 'vitest';
import { CliAdapterWorkerProxy } from './cli-adapter-worker-proxy';
import type { CliSpawnGatewayPort } from './cli-spawn-worker-gateway';

vi.mock('../adapters/claude-transcript-registry', () => ({
  nativeTranscriptExists: () => true,
  nativeSessionIdInUse: () => false,
  readLastClaudeCostState: () => ({ totalCostUSD: 2 }),
}));

describe('worker proxy native fork cost', () => {
  it('books only the new spend on the first forked turn, not the inherited total', async () => {
    let handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | undefined;
    const gateway: CliSpawnGatewayPort = {
      registerInstance: (_id, next) => { handler = next; },
      unregisterInstance: () => { handler = undefined; },
      spawnInstance: async () => { handler?.spawned?.(123); return { pid: 123 }; },
      writeStdin: async () => undefined,
      sendSignal: vi.fn(),
      terminate: vi.fn(async () => { handler?.exited?.(null, 'SIGKILL'); }),
    };
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'claude', instanceId: 'fork-cost', gateway,
      options: { workingDirectory: '/tmp', model: 'haiku', sessionId: 'parent', resume: true, forkSession: true },
    });
    const complete = vi.fn();
    proxy.on('complete', complete);

    await proxy.spawn();
    await proxy.sendInput('next');
    handler?.stdout?.(`${JSON.stringify({ type: 'result', total_cost_usd: 2.5, usage: { input_tokens: 10, output_tokens: 1 } })}\n`);

    expect(complete.mock.calls[0]?.[0].usage.cost).toBe(0.5);
  });
});
