import { describe, expect, it, vi } from 'vitest';
import { runLocalAiCli } from './local-ai-cli';

const config = {
  lifecycle: 'enrolled',
  location: { type: 'worker', nodeId: 'node-1' },
  provider: 'openai-compatible',
  endpointId: 'openai-compatible',
  baseUrl: 'http://100.64.0.2:1234/v1',
  expectedModels: [
    { modelId: 'qwen/qwen3.5-9b', required: true },
    { modelId: 'qwen/qwen3.6-35b-a3b', required: true },
  ],
  canary: {
    model: 'qwen/qwen3.5-9b',
    timeoutMs: 30_000,
    intervalMs: 600_000,
  },
  endpointCheckIntervalMs: 60_000,
  freshnessLimitMs: 120_000,
  warningLatencyMs: 2_000,
  routingRoles: ['compression'],
  fallbackPolicy: 'notify-and-allow',
  slotFallbackPolicies: {},
  recovery: {
    automatic: false,
    maxAttempts: 2,
    cooldownMs: 300_000,
  },
} as const;

const discovery = [{
  identity: {
    location: { type: 'worker', nodeId: 'node-1' },
    provider: 'openai-compatible',
    endpointId: 'openai-compatible',
    baseUrl: 'http://100.64.0.2:1234/v1',
  },
  label: 'windows-pc • openai-compatible',
  models: ['qwen/qwen3.5-9b', 'qwen/qwen3.6-35b-a3b'],
  healthy: true,
}];

const validation = [
  probe('worker'),
  probe('endpoint'),
  probe('model'),
  probe('inference'),
];

const target = {
  ...config,
  id: 'target-1',
  label: 'node-1: openai-compatible',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function probe(layer: 'worker' | 'endpoint' | 'model' | 'inference') {
  return {
    targetId: 'validation-target',
    layer,
    checkType: 'functional' as const,
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt: 1_700_000_000_000,
    durationMs: 25,
    evidence: layer === 'worker'
      ? { workerConnected: true, workerLatencyMs: 7 }
      : {},
  };
}

function harness(result: unknown) {
  const output: string[] = [];
  const call = vi.fn(async () => result);
  return {
    client: { call },
    call,
    output,
    stdout: (text: string) => output.push(text),
  };
}

describe('runLocalAiCli', () => {
  it('prints command help without opening the parent RPC client', async () => {
    const h = harness(null);

    await runLocalAiCli(['--help'], h);

    expect(h.call).not.toHaveBeenCalled();
    expect(h.output.join('')).toContain('aio-mcp local-ai discover');
    expect(h.output.join('')).toContain('enrol <config-json>');
  });

  it('discovers bounded endpoint metadata as JSON', async () => {
    const h = harness(discovery);

    await runLocalAiCli(['discover', '--json'], h);

    expect(h.call).toHaveBeenCalledWith(
      'orchestrator_tools.local_ai.discover',
      {},
    );
    expect(JSON.parse(h.output.join(''))).toEqual(discovery);
  });

  it('lists enrolled targets in concise human output', async () => {
    const h = harness([target]);

    await runLocalAiCli(['list'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.list', {});
    expect(h.output.join('')).toContain('node-1: openai-compatible');
    expect(h.output.join('')).toContain('qwen/qwen3.5-9b');
    expect(h.output.join('')).not.toContain('createdAt');
  });

  it('validates a strict target config and omits raw evidence from human output', async () => {
    const h = harness(validation);

    await runLocalAiCli(['validate', JSON.stringify(config)], h);

    expect(h.call).toHaveBeenCalledWith(
      'orchestrator_tools.local_ai.validate',
      { config },
    );
    expect(h.output.join('')).toContain('worker');
    expect(h.output.join('')).toContain('passed');
    expect(h.output.join('')).not.toContain('workerLatencyMs');
  });

  it('enrols a strict target config and parses the returned target plus validation', async () => {
    const h = harness({ target, validation });

    await runLocalAiCli(['enrol', JSON.stringify(config), '--json'], h);

    expect(h.call).toHaveBeenCalledWith(
      'orchestrator_tools.local_ai.enrol',
      { config },
    );
    expect(JSON.parse(h.output.join(''))).toEqual({ target, validation });
  });

  it('gives a maximum bounded Ollama functional probe enough RPC time to finish', async () => {
    const output: string[] = [];
    const call = vi.fn(async () => validation);
    const createClient = vi.fn(() => ({ call }));
    const maximumProbeConfig = {
      ...config,
      provider: 'ollama',
      endpointId: 'ollama',
      expectedModels: [{
        modelId: 'qwen3.5:9b',
        required: true,
        minContextLength: 32_768,
      }],
      canary: {
        ...config.canary,
        model: 'qwen3.5:9b',
        timeoutMs: 120_000,
      },
    } as const;

    await runLocalAiCli(
      ['validate', JSON.stringify(maximumProbeConfig)],
      {
        createClient,
        stdout: (text) => output.push(text),
      },
    );

    expect(createClient).toHaveBeenCalledWith(491_000);
    expect(call).toHaveBeenCalledWith(
      'orchestrator_tools.local_ai.validate',
      { config: maximumProbeConfig },
    );
    expect(output.join('')).toContain('passed');
  });

  it('rejects malformed config JSON before making an RPC call', async () => {
    const h = harness(null);

    await expect(
      runLocalAiCli(['enrol', '{not-json}'], h),
    ).rejects.toThrow('valid JSON');

    expect(h.call).not.toHaveBeenCalled();
  });

  it.each(['unmanaged', 'paused', 'retired'] as const)(
    'rejects lifecycle %s locally for enrolment',
    async (lifecycle) => {
      const h = harness(null);

      await expect(
        runLocalAiCli(['enrol', JSON.stringify({ ...config, lifecycle })], h),
      ).rejects.toThrow('enrolled lifecycle');

      expect(h.call).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid parent results instead of printing untrusted data', async () => {
    const h = harness([{ endpoint: 'raw-secret-bearing-object' }]);

    await expect(runLocalAiCli(['discover'], h)).rejects.toThrow(
      'invalid Local AI discovery result',
    );

    expect(h.output).toEqual([]);
  });
});
