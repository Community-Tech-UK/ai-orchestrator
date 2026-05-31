import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cli/adapters/adapter-factory', () => ({ resolveCliType: vi.fn() }));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));
vi.mock('../../cli/cli-detection', () => ({ isCliAvailable: vi.fn() }));
vi.mock('../../cli/provider-notice', () => ({
  // Treat any string starting with "NOTICE:" as a provider status notice.
  isProviderNotice: (s: string) => s.startsWith('NOTICE:'),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { MultiProviderCompareService, type MultiProviderCompareDeps } from '../multi-provider-compare-service';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';

/**
 * Build a service whose adapters return per-provider canned answers (string),
 * or throw (Error), or are missing (provider resolves to null).
 */
function makeService(
  answers: Record<string, string | Error | null>,
): { service: MultiProviderCompareService; sends: Record<string, ReturnType<typeof vi.fn>> } {
  const sends: Record<string, ReturnType<typeof vi.fn>> = {};
  let clock = 1000;

  const deps: MultiProviderCompareDeps = {
    resolveProvider: async (p) => (answers[p] === null || answers[p] === undefined ? null : (p as never)),
    createAdapter: (cliType) => {
      const provider = cliType as unknown as string;
      const send = vi.fn(async () => {
        const a = answers[provider];
        if (a instanceof Error) throw a;
        return { id: 'r', role: 'assistant' as const, content: a as string };
      });
      sends[provider] = send;
      return { sendMessage: send } as unknown as CliAdapter;
    },
    now: () => (clock += 5),
  };
  return { service: new MultiProviderCompareService(deps), sends };
}

describe('MultiProviderCompareService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty result for a blank prompt', async () => {
    const { service } = makeService({ claude: 'x' });
    const r = await service.compare('   ', ['claude']);
    expect(r).toEqual({ prompt: '', results: [] });
  });

  it('fans out to multiple providers and collects answers', async () => {
    const { service } = makeService({ claude: 'Claude says hi', gemini: 'Gemini says hello' });
    const r = await service.compare('greet me', ['claude', 'gemini']);
    expect(r.prompt).toBe('greet me');
    expect(r.results).toHaveLength(2);
    const claude = r.results.find((c) => c.provider === 'claude')!;
    expect(claude).toMatchObject({ ok: true, answer: 'Claude says hi' });
    expect(claude.durationMs).toBeGreaterThan(0);
  });

  it('marks unavailable providers as failed cells without aborting others', async () => {
    const { service } = makeService({ claude: 'ok', codex: null });
    const r = await service.compare('q', ['claude', 'codex']);
    expect(r.results.find((c) => c.provider === 'claude')).toMatchObject({ ok: true });
    expect(r.results.find((c) => c.provider === 'codex')).toMatchObject({ ok: false, error: /not available/i });
  });

  it('captures a thrown provider error per cell', async () => {
    const { service } = makeService({ claude: new Error('spawn ENOENT') });
    const r = await service.compare('q', ['claude']);
    expect(r.results[0]).toMatchObject({ ok: false, error: 'spawn ENOENT' });
  });

  it('flags a provider status/limit notice as a failure', async () => {
    const { service } = makeService({ claude: 'NOTICE: you hit your limit' });
    const r = await service.compare('q', ['claude']);
    expect(r.results[0]).toMatchObject({ ok: false, error: /status\/limit notice/i });
  });

  it('treats an empty response as a failure', async () => {
    const { service } = makeService({ claude: '   ' });
    const r = await service.compare('q', ['claude']);
    expect(r.results[0]).toMatchObject({ ok: false, error: /empty response/i });
  });

  it('de-dupes providers and ignores unknown ones', async () => {
    const { service, sends } = makeService({ claude: 'a' });
    const r = await service.compare('q', ['claude', 'claude', 'not-a-real-provider']);
    expect(r.results).toHaveLength(1);
    expect(sends['claude']).toHaveBeenCalledOnce();
  });

  it('lists only available known providers', async () => {
    const { service } = makeService({ claude: 'a', gemini: 'b', codex: null, copilot: null, cursor: null });
    const available = await service.listAvailableProviders();
    expect(available).toEqual(['claude', 'gemini']);
  });
});
