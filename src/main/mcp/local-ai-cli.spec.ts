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

    // Five requests (Ollama version, tags, context, resident-context read, canary) at
    // 120 s each, plus the transport and completion margins.
    expect(createClient).toHaveBeenCalledWith(611_000);
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

  it('retires a target and reports its new lifecycle', async () => {
    const h = harness({ ...target, lifecycle: 'retired', retiredAt: target.updatedAt });

    await runLocalAiCli(['set-lifecycle', 'target-1', 'retired'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.set_lifecycle', {
      targetId: 'target-1',
      lifecycle: 'retired',
    });
    expect(h.output.join('')).toBe('node-1: openai-compatible (target-1) is now retired.\n');
  });

  it('passes a pause deadline only for the paused lifecycle', async () => {
    const h = harness({ ...target, lifecycle: 'paused', pausedUntil: 1_800_000_000_000 });

    await runLocalAiCli(['set-lifecycle', 'target-1', 'paused', '--paused-until', '1800000000000', '--json'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.set_lifecycle', {
      targetId: 'target-1',
      lifecycle: 'paused',
      pausedUntil: 1_800_000_000_000,
    });
    expect(JSON.parse(h.output.join(''))).toMatchObject({ lifecycle: 'paused' });
  });

  it.each([
    [['set-lifecycle', 'target-1'], /requires <target-id>/],
    [['set-lifecycle', 'target-1', 'deleted'], /Invalid Local AI lifecycle request/],
    [['set-lifecycle', 'target-1', 'retired', '--paused-until', '1800000000000'], /Invalid Local AI lifecycle request/],
    [['set-lifecycle', 'target-1', 'paused', '--paused-until', 'soon'], /epoch-milliseconds/],
  ])('rejects a malformed lifecycle request before any RPC: %j', async (argv, message) => {
    const h = harness(null);

    await expect(runLocalAiCli(argv, h)).rejects.toThrow(message);
    expect(h.call).not.toHaveBeenCalled();
  });
  it('lists targets with their ids so agents can act on them', async () => {
    const h = harness([target]);

    await runLocalAiCli(['list'], h);

    expect(h.output.join('')).toContain('node-1: openai-compatible | target-1 | enrolled');
  });

  const cliStatus = {
    aggregate: { state: 'healthy', enrolled: 1, healthy: 1, degraded: 0, unavailable: 0, paused: 0 },
    targets: [{
      id: 'target-1',
      label: 'windows-pc · LM Studio',
      lifecycle: 'enrolled',
      provider: 'openai-compatible',
      state: 'healthy',
      routableRoles: ['compression'],
      consecutiveFailures: 0,
      checkedAt: 1_700_000_000_000,
      layers: {
        endpoint: { ok: true, required: true, checkedAt: 1_700_000_000_000, durationMs: 2 },
        inference: { ok: false, required: true, checkedAt: 1_700_000_000_000, durationMs: 9, failureCode: 'malformed-inference-output' },
      },
    }],
    incidents: [{
      id: 'incident-1',
      targetId: 'old-target',
      targetLabel: 'windows-pc · Ollama',
      state: 'open',
      severity: 'warning',
      failureCode: 'connection-refused',
      affectedLayers: ['endpoint'],
      affectedRoles: ['compression'],
      openedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      unpricedDispatchCount: 0,
    }],
  };

  it('prints target health, failed layers and labelled incidents for status', async () => {
    const h = harness(cliStatus);

    await runLocalAiCli(['status'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.status', {});
    const text = h.output.join('');
    expect(text).toContain('Overall: healthy (enrolled 1, healthy 1');
    expect(text).toContain('windows-pc · LM Studio (target-1)');
    expect(text).toContain('routes: compression');
    expect(text).toContain('canary: FAILED (malformed-inference-output)');
    expect(text).toContain('model: not checked');
    expect(text).toContain('incident-1 | open | warning | connection-refused | windows-pc · Ollama');
  });

  function recheckClients(recheck: (...args: unknown[]) => Promise<unknown>) {
    const created: { timeoutMs: number; call: ReturnType<typeof vi.fn> }[] = [];
    const createClient = vi.fn((timeoutMs: number) => {
      const call = vi.fn(async (method: string, ...rest: unknown[]) =>
        method === 'orchestrator_tools.local_ai.list' ? [target] : recheck(method, ...rest));
      created.push({ timeoutMs, call });
      return { call };
    });
    return { createClient, created };
  }

  it('sizes each recheck wait from the target probe settings, defaulting to a lightweight check', async () => {
    const clients = recheckClients(async () => cliStatus.targets[0]);
    const output: string[] = [];

    await runLocalAiCli(['recheck', 'target-1', '--kind', 'functional'], { createClient: clients.createClient, stdout: (t) => output.push(t) });
    await runLocalAiCli(['recheck', 'target-1'], { createClient: clients.createClient, stdout: (t) => output.push(t) });

    // LM Studio, no context minimum, 30 s canary timeout: functional = models + canary,
    // lightweight = models only; each plus the 1 s transport and 10 s completion margins.
    expect(clients.created.map((client) => client.timeoutMs)).toEqual([120_000, 71_000, 120_000, 41_000]);
    expect(clients.created.flatMap((client) => client.call.mock.calls)).toEqual([
      ['orchestrator_tools.local_ai.list', {}],
      ['orchestrator_tools.local_ai.recheck', { targetId: 'target-1', kind: 'functional' }],
      ['orchestrator_tools.local_ai.list', {}],
      ['orchestrator_tools.local_ai.recheck', { targetId: 'target-1', kind: 'lightweight' }],
    ]);
    expect(output.join('')).toContain('windows-pc · LM Studio (target-1)');
  });

  it('refuses to recheck an unknown target without starting a check', async () => {
    const recheck = vi.fn(async () => cliStatus.targets[0]);
    const clients = recheckClients(recheck);

    await expect(runLocalAiCli(['recheck', 'missing'], { createClient: clients.createClient, stdout: () => undefined }))
      .rejects.toThrow('Local AI target not found: missing');
    expect(recheck).not.toHaveBeenCalled();
  });

  it('explains that a timed-out check may still be running', async () => {
    const clients = recheckClients(async () => {
      throw new Error('orchestrator-tools RPC request timed out');
    });

    await expect(runLocalAiCli(['recheck', 'target-1', '--kind', 'functional'], { createClient: clients.createClient, stdout: () => undefined }))
      .rejects.toThrow(/may still be running in Harness.*local-ai status/);
  });

  it('renames a target with a trimmed label', async () => {
    const h = harness({ ...target, label: 'windows-pc · LM Studio' });

    await runLocalAiCli(['rename', 'target-1', '  windows-pc · LM Studio  '], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.rename', {
      targetId: 'target-1',
      label: 'windows-pc · LM Studio',
    });
    expect(h.output.join('')).toBe('target-1 is now labelled "windows-pc · LM Studio".\n');
  });

  it('updates a target with a strict patch', async () => {
    const h = harness({ ...target, warningLatencyMs: 15_000 });

    await runLocalAiCli(['update', 'target-1', '{"warningLatencyMs":15000}'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.update', {
      targetId: 'target-1',
      patch: { warningLatencyMs: 15_000 },
    });
  });

  it('prints the effectiveness summary as a percentage of eligible tasks', async () => {
    const h = harness({
      window: '7d', localTasks: 95, localTokens: 1_000, proposedFallbacks: 5, allowedFallbacks: 5,
      deferredFallbacks: 0, blockedFallbacks: 0, knownCostUsd: 0.01, estimatedCostUsd: 0,
      unpricedDispatchCount: 2, avoidedEstimatedTokens: 1_000, avoidedEstimatedCostUsd: 0.2,
      byTarget: {}, byModel: {}, bySlot: {}, byIncident: {},
    });

    await runLocalAiCli(['summary', '--window', '7d'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.summary', { window: '7d' });
    expect(h.output.join('')).toContain('Local AI effectiveness (7d): 95% local (95 of 100 tasks)');
  });

  it('acknowledges an incident', async () => {
    const h = harness({
      id: 'incident-1', targetId: 'old-target', state: 'acknowledged', severity: 'warning',
      failureCode: 'connection-refused', affectedLayers: ['endpoint'], affectedRoles: ['compression'],
      openedAt: 1, updatedAt: 2, acknowledgedAt: 2, fallbackCount: 0, knownCostUsd: 0,
      estimatedCostUsd: 0, unpricedDispatchCount: 0,
    });

    await runLocalAiCli(['acknowledge', 'incident-1'], h);

    expect(h.call).toHaveBeenCalledWith('orchestrator_tools.local_ai.acknowledge', { incidentId: 'incident-1' });
    expect(h.output.join('')).toBe('Incident incident-1 is now acknowledged.\n');
  });

  it.each([
    [['recheck'], /requires <target-id>/],
    [['recheck', 'target-1', '--kind', 'deep'], /lightweight or functional/],
    [['recheck', 'target-1', '--kind'], /--kind requires a value/],
    [['rename', 'target-1'], /requires <target-id> <label>/],
    [['rename', 'target-1', '   '], /requires <target-id> <label>/],
    [['update', 'target-1', 'not json'], /valid JSON/],
    [['update', 'target-1', '{"endpointId":"other"}'], /Invalid Local AI target patch/],
    [['summary', '--window', '1y'], /24h, 7d or 30d/],
    [['summary', 'extra'], /no positional arguments/],
    [['acknowledge'], /requires <incident-id>/],
    [['status', '--verbose'], /Unknown local-ai option/],
  ])('rejects malformed management commands before any RPC: %j', async (argv, message) => {
    const h = harness(null);

    await expect(runLocalAiCli(argv, h)).rejects.toThrow(message);
    expect(h.call).not.toHaveBeenCalled();
  });

  it('refuses an untrusted status result from the parent', async () => {
    const h = harness({ aggregate: {}, targets: 'nope', incidents: [] });

    await expect(runLocalAiCli(['status'], h)).rejects.toThrow(/invalid Local AI status result/);
    expect(h.output).toEqual([]);
  });
});
