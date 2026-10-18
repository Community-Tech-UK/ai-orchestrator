import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cli/adapters/adapter-factory', () => ({ resolveCliType: vi.fn() }));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));
vi.mock('../../cli/cli-detection', () => ({ isCliAvailable: vi.fn() }));
vi.mock('../../cli/provider-notice', () => ({
  isProviderNotice: (s: string) => s.startsWith('NOTICE:'),
}));

import { invokeProviderOneShot, type ProviderInvokeDeps } from '../council-provider-invoke';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';

function makeDeps(answers: Record<string, string | Error | null>): {
  deps: ProviderInvokeDeps;
  sends: Record<string, ReturnType<typeof vi.fn>>;
  terminate: Record<string, ReturnType<typeof vi.fn>>;
} {
  const sends: Record<string, ReturnType<typeof vi.fn>> = {};
  const terminate: Record<string, ReturnType<typeof vi.fn>> = {};
  let clock = 1000;

  const deps: ProviderInvokeDeps = {
    resolveProvider: async (p) => (answers[p] === null || answers[p] === undefined ? null : (p as never)),
    createAdapter: (cliType) => {
      const provider = cliType as unknown as string;
      const send = vi.fn(async () => {
        const a = answers[provider];
        if (a instanceof Error) throw a;
        return { id: 'r', role: 'assistant' as const, content: a as string };
      });
      const term = vi.fn(async () => undefined);
      sends[provider] = send;
      terminate[provider] = term;
      return { sendMessage: send, terminate: term } as unknown as CliAdapter;
    },
    now: () => (clock += 5),
  };
  return { deps, sends, terminate };
}

describe('invokeProviderOneShot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps a fresh Claude call and records a budget stop without another send', async () => {
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const { deps } = makeDeps({ claude: 'answer' });
    const send = vi.fn(async () => ({ content: 'partial', metadata: { budgetExceeded: true }, usage: { cost: 0.0064186, inputTokens: 0, outputTokens: 0 } }));
    deps.createAdapter = vi.fn((_type, options) => {
      expect(options.maxBudgetUsd).toBe(1);
      return { sendMessage: send } as unknown as CliAdapter;
    });
    try {
      expect(await invokeProviderOneShot(deps, 'claude', 'hi')).toMatchObject({ ok: false, error: 'Provider budget exceeded' });
      expect(send).toHaveBeenCalledOnce();
      expect(rows).toContainEqual(expect.objectContaining({ outcome: 'budget-exceeded', costSource: 'provider', usage: expect.objectContaining({ cost: 0.0064186 }) }));
    } finally { stop(); }
  });

  it('records dispatched calls with purpose, usage, and explicit failures', async () => {
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    try {
      const { deps } = makeDeps({ claude: 'answer', codex: new Error('failed') });
      const create = deps.createAdapter;
      deps.createAdapter = (type, options) => {
        const adapter = create(type, options);
        if (type === 'claude') Object.assign(adapter, {
          sendMessage: vi.fn(async () => ({ content: 'answer', usage: { inputTokens: 10, outputTokens: 2, cost: 0.12 } })),
        });
        return adapter;
      };
      const result = await invokeProviderOneShot(deps, 'claude', 'hi', { purpose: 'compare' });
      await invokeProviderOneShot(deps, 'codex', 'hi', { purpose: 'council' });
      await invokeProviderOneShot(makeDeps({ claude: null }).deps, 'claude', 'hi');
      expect(result.usage).toMatchObject({ cost: 0.12 });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ purpose: 'compare', provider: 'claude', model: expect.any(String), costKnown: true, usage: { cost: 0.12, inputTokens: 10 } });
      expect(rows[1]).toMatchObject({ purpose: 'council', provider: 'codex', outcome: 'error', costSource: 'unknown' });
    } finally { stop(); }
  });

  it('records cancellation once only after dispatch', async () => {
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const abort = new AbortController();
    const { deps } = makeDeps({ claude: 'answer' });
    deps.createAdapter = () => ({ sendMessage: async () => {
      abort.abort();
      return { content: 'partial', usage: { cost: 0.1 } };
    } }) as unknown as CliAdapter;
    try {
      await invokeProviderOneShot(deps, 'claude', 'hi', { signal: abort.signal });
      await invokeProviderOneShot(deps, 'claude', 'hi', { signal: abort.signal });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'cancelled', costSource: 'provider', costKnown: true, usage: { cost: 0.1 } });
    } finally { stop(); }
  });

  it('returns the answer on success', async () => {
    const { deps } = makeDeps({ claude: 'hello' });
    const result = await invokeProviderOneShot(deps, 'claude', 'hi');
    expect(result).toMatchObject({ ok: true, answer: 'hello' });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('fails when the provider is unavailable', async () => {
    const { deps } = makeDeps({ claude: null });
    const result = await invokeProviderOneShot(deps, 'claude', 'hi');
    expect(result).toMatchObject({ ok: false, error: 'Provider is not available' });
  });

  it('captures a thrown error', async () => {
    const { deps } = makeDeps({ claude: new Error('spawn ENOENT') });
    const result = await invokeProviderOneShot(deps, 'claude', 'hi');
    expect(result).toMatchObject({ ok: false, error: 'spawn ENOENT' });
  });

  it('flags a provider status/limit notice as failure', async () => {
    const { deps } = makeDeps({ claude: 'NOTICE: rate limited' });
    const result = await invokeProviderOneShot(deps, 'claude', 'hi');
    expect(result).toMatchObject({ ok: false, error: /status\/limit notice/i });
  });

  it('treats an empty response as failure', async () => {
    const { deps } = makeDeps({ claude: '   ' });
    const result = await invokeProviderOneShot(deps, 'claude', 'hi');
    expect(result).toMatchObject({ ok: false, error: /empty response/i });
  });

  it('short-circuits before resolving the provider when already aborted', async () => {
    const { deps, sends } = makeDeps({ claude: 'hello' });
    const controller = new AbortController();
    controller.abort();
    const result = await invokeProviderOneShot(deps, 'claude', 'hi', { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: 'Cancelled' });
    expect(sends['claude']).toBeUndefined();
  });

  it('reports cancellation even when the adapter call already resolved by the time we check', async () => {
    const { deps } = makeDeps({ claude: 'hello' });
    const controller = new AbortController();
    const promise = invokeProviderOneShot(deps, 'claude', 'hi', { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Cancelled');
  });

  it('reports the created adapter back to the caller for cancellation tracking', async () => {
    const { deps } = makeDeps({ claude: 'hello' });
    let reported: CliAdapter | undefined;
    await invokeProviderOneShot(deps, 'claude', 'hi', {
      onAdapterCreated: (adapter) => { reported = adapter; },
    });
    expect(reported).toBeDefined();
  });
});
