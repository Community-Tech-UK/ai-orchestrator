import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuxGenerate, mockSlotAllowsFrontier, mockCreateAdapter, mockResolveCliType, mockSendMessage, mockIsCliAvailable } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockAuxGenerate: vi.fn(),
    mockSlotAllowsFrontier: vi.fn(() => true),
    mockSendMessage: sendMessage,
    mockCreateAdapter: vi.fn(() => ({
      sendMessage,
    })),
    mockResolveCliType: vi.fn(),
    mockIsCliAvailable: vi.fn(),
  };
});

vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: mockResolveCliType,
}));

vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: mockCreateAdapter,
  })),
}));

vi.mock('../cli/cli-detection', () => ({
  isCliAvailable: mockIsCliAvailable,
}));

vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: vi.fn(() => ({
    generate: mockAuxGenerate,
    slotAllowsFrontier: mockSlotAllowsFrontier,
  })),
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => mockLog),
}));

const { mockFilterProvidersForAutomation } = vi.hoisted(() => ({
  // Default passthrough: real exclusion behaviour is covered by
  // automation-provider-exclusions.spec.ts; this file only needs to prove the
  // filter is consulted before the candidate loop runs.
  mockFilterProvidersForAutomation: vi.fn((providers: readonly string[]) => [...providers]),
}));

vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: mockFilterProvidersForAutomation,
}));

// Spy that still forwards to the real recorder: other tests here assert on the
// real cost-attribution rows.
const recordModelCall = vi.hoisted(() => vi.fn());
vi.mock('../core/system/model-call-recorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/system/model-call-recorder')>();
  recordModelCall.mockImplementation(actual.recordModelCall);
  return { ...actual, recordModelCall };
});

import { AutoTitleService, TITLE_CLI_SPAWN_ENABLED } from './auto-title-service';

describe('AutoTitleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() resets call history but not a previously-set
    // mockImplementation, so an override from one test (e.g. the exclusion
    // test below) would otherwise leak into every later test.
    mockFilterProvidersForAutomation.mockImplementation(
      (providers: readonly string[]) => [...providers],
    );
    mockAuxGenerate.mockResolvedValue({
      text: '',
      decision: {
        slot: 'titleGeneration',
        provider: 'local-fallback',
        source: 'fallback',
        reason: 'test fallback',
        allowFrontierFallback: true,
      },
    });
    mockSendMessage.mockResolvedValue({ content: 'AI generated title' });
    // `clearAllMocks` clears calls but not implementations, so a test that swaps
    // in an adapter without `sendMessage` would otherwise leak into every test
    // after it.
    mockCreateAdapter.mockReturnValue({ sendMessage: mockSendMessage });
    AutoTitleService._resetForTesting();
    // Preserve coverage of the dormant legacy path while production keeps it off.
    AutoTitleService.getInstance().setCliSpawnEnabledForTesting(true);
  });

  it('uses a resident title after a local miss without spawning a CLI', async () => {
    const service = AutoTitleService.getInstance();
    service.setCliSpawnEnabledForTesting(false);
    const liveTitle = vi.fn().mockResolvedValue('Fix the deploy pipeline');
    service.setLiveTitleSource(liveTitle);
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('instance-1', 'Fix the broken deploy pipeline', applyTitle);
    expect(liveTitle).toHaveBeenCalledWith('instance-1', 'Fix the broken deploy pipeline');
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Fix the deploy pipeline', 'ai');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('ships with new-CLI title spawning off (default pinned)', async () => {
    // A new CLI consumed ~35.8K tokens for an 80-character label. Production
    // keeps it off: the constant and a freshly built service must both say so.
    expect(TITLE_CLI_SPAWN_ENABLED).toBe(false);
    AutoTitleService._resetForTesting();
    const service = AutoTitleService.getInstance();
    service.setLiveTitleSource(vi.fn().mockResolvedValue(null));
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('instance-1', 'Fix the broken deploy pipeline', applyTitle);
    expect(mockCreateAdapter).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(applyTitle.mock.calls).toEqual([[
      'instance-1', 'Fix the broken deploy pipeline', 'instant',
    ]]);
  });

  it('records no helper/claude ledger row itself when the live source made no request', async () => {
    // A Codex chat has no resident Claude channel, so the live source returns
    // null without asking anything. The service must not invent a Claude error
    // row for that; the source records its own row when it does ask.
    const service = AutoTitleService.getInstance();
    service.setCliSpawnEnabledForTesting(false);
    service.setLiveTitleSource(vi.fn().mockResolvedValue(null));
    await service.maybeGenerateTitle('codex-chat', 'Fix the broken deploy pipeline', vi.fn());
    expect(recordModelCall).not.toHaveBeenCalled();
  });

  it('keeps the instant title when no resident title is available', async () => {
    const service = AutoTitleService.getInstance();
    service.setCliSpawnEnabledForTesting(false);
    service.setLiveTitleSource(vi.fn().mockResolvedValue(null));
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('instance-1', 'Fix the broken deploy pipeline', applyTitle);
    expect(applyTitle.mock.calls).toEqual([[
      'instance-1', 'Fix the broken deploy pipeline', 'instant',
    ]]);
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('prefers antigravity for title generation even when copilot, claude, and codex are available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: ['antigravity', 'copilot', 'claude', 'codex'].includes(type),
    }));
    mockResolveCliType.mockResolvedValue('antigravity');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Should resolve to antigravity (first in preference order), not a later provider.
    expect(mockIsCliAvailable).toHaveBeenCalledWith('antigravity');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('copilot');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('claude');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('codex');
    expect(mockResolveCliType).toHaveBeenCalledWith('antigravity');
    // Antigravity ships an empty model catalog (agy picks its own default), so
    // no model is forwarded — assert the cliType only, not a string model.
    expect(mockCreateAdapter).toHaveBeenCalledWith(expect.objectContaining({
      cliType: 'antigravity',
    }));
    // Phase 1 instant title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.', 'instant');
    // Phase 2 AI title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'AI generated title', 'ai');
  });

  it('uses the filename when the local model titles a path-only task from its parent folder', async () => {
    mockAuxGenerate.mockResolvedValue({
      text: 'Superpowers',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });
    const applyTitle = vi.fn();
    const path = '/Users/suas/work/Dingley/dingley-kpi/dingley-kpi-fe/docs/superpowers/plans/2026-09-23-kpi-workbook-alignment-and-data-load_plan.md';

    await AutoTitleService.getInstance().maybeGenerateTitle('instance-1', path, applyTitle);

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'KPI workbook alignment and data load', 'instant');
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'KPI workbook alignment and data load', 'ai');
    expect(applyTitle).not.toHaveBeenCalledWith('instance-1', 'Superpowers', 'ai');
    expect(mockAuxGenerate.mock.calls[0][2]).toContain('KPI workbook alignment and data load');
    expect(mockAuxGenerate.mock.calls[0][2]).not.toContain('superpowers');
    expect(mockIsCliAvailable).not.toHaveBeenCalled();
  });

  it('keeps a grounded local-model title for a path-only task', async () => {
    mockAuxGenerate.mockResolvedValue({
      text: 'KPI workbook data load',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const title = await AutoTitleService.getInstance().generateLocalTitle(
      '/Users/suas/work/Dingley/dingley-kpi/dingley-kpi-fe/docs/superpowers/plans/2026-09-23-kpi-workbook-alignment-and-data-load_plan.md',
    );

    expect(title).toBe('KPI workbook data load');
    expect(mockAuxGenerate.mock.calls[0][2]).not.toContain('superpowers');
  });

  it('skips copilot and falls back to claude when antigravity is not available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'copilot' || type === 'claude' || type === 'codex',
    }));
    mockResolveCliType.mockImplementation(async (type: string) => type);

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(mockIsCliAvailable).toHaveBeenNthCalledWith(1, 'antigravity');
    expect(mockIsCliAvailable).toHaveBeenNthCalledWith(2, 'claude');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('copilot');
    expect(mockResolveCliType).toHaveBeenCalledWith('claude');
    expect(mockCreateAdapter).toHaveBeenCalledWith({
      cliType: 'claude',
      options: expect.objectContaining({
        model: expect.any(String),
      }),
    });
  });

  it('honours providersExcludedFromAutomation for the cross-provider title borrow', async () => {
    // Operator barred antigravity from automatic selection (e.g. a
    // work-scoped seat) — the same lever every other auto-pick site respects.
    mockFilterProvidersForAutomation.mockImplementation(
      (providers: readonly string[]) => providers.filter((p) => p !== 'antigravity'),
    );
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'antigravity' || type === 'claude',
    }));
    mockResolveCliType.mockImplementation(async (type: string) => type);

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(mockFilterProvidersForAutomation).toHaveBeenCalledWith(
      ['antigravity', 'claude', 'codex'],
      'autoTitle',
    );
    // Excluded before availability is even probed.
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('antigravity');
    expect(mockIsCliAvailable).toHaveBeenCalledWith('claude');
    expect(mockResolveCliType).toHaveBeenCalledWith('claude');
  });

  it('keeps instant title when no CLI is available', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Phase 1 instant title should still apply
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.', 'instant');
    // Phase 2 should not have been attempted
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('fails locally without probing a paid CLI when auxiliary acquisition or authorization throws', async () => {
    mockAuxGenerate.mockRejectedValue(new Error('authorization unavailable'));

    const title = await AutoTitleService.getInstance().generateTitle(
      'Investigate the broken deployment and summarize the fix.',
    );

    expect(title).toBeNull();
    expect(mockIsCliAvailable).not.toHaveBeenCalled();
    expect(mockCreateAdapter).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('keeps history title generation local even when paid fallback is authorized', async () => {
    mockAuxGenerate.mockResolvedValue({
      text: '',
      decision: {
        slot: 'titleGeneration',
        provider: 'local-fallback',
        source: 'fallback',
        reason: 'local model unavailable',
        allowFrontierFallback: true,
      },
    });

    const title = await AutoTitleService.getInstance().generateLocalTitle(
      'Fix session titles using the first authored message.',
    );

    expect(title).toBeNull();
    expect(mockIsCliAvailable).not.toHaveBeenCalled();
    expect(mockCreateAdapter).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('falls through to the next eligible provider when the preferred CLI call rejects', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'antigravity' || type === 'claude',
    }));
    mockResolveCliType.mockImplementation(async (type: string) => type);
    const antigravitySend = vi.fn().mockRejectedValue(new Error('agy exited with code 1'));
    const claudeSend = vi.fn().mockResolvedValue({ content: 'Deployment fallback title' });
    mockCreateAdapter.mockImplementation((input?: { cliType?: string }) => ({
      sendMessage: input?.cliType === 'antigravity' ? antigravitySend : claudeSend,
    }));

    const title = await AutoTitleService.getInstance().generateTitle(
      'Investigate the broken deployment and summarize the fix.',
    );

    expect(title).toBe('Deployment fallback title');
    expect(antigravitySend).toHaveBeenCalledTimes(1);
    expect(claudeSend).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('AI title escalation failed'),
      expect.objectContaining({
        cliType: 'antigravity',
        error: 'agy exited with code 1',
      }),
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('generated via CLI escalation'),
      expect.objectContaining({ cliType: 'claude' }),
    );
  });

  it('automatically attributes the real paid CLI adapter winner inside routing correlation', async () => {
    mockAuxGenerate.mockResolvedValue({
      text: '',
      decision: {
        slot: 'titleGeneration',
        provider: 'local-fallback',
        source: 'fallback',
        reason: 'authorized',
        allowFrontierFallback: true,
        fallbackDisposition: 'allowed',
        localAiRoutingEventId: 'routing-title',
      },
    });
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({
      content: 'Attributed title',
      usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34, cost: 0.01 },
    });
    const { subscribeCostAttribution } = await import('../core/system/cost-attribution');
    const { applyLocalAiRoutingCostAttribution } = await import(
      '../local-ai-guard/local-ai-runtime'
    );
    const records: unknown[] = [];
    let durablePatch: Record<string, unknown> | undefined;
    const health = {
      getRoutingEvent: () => ({ id: 'routing-title' }),
      updateRoutingEvent: (_eventId: string, patch: Record<string, unknown>) => {
        durablePatch = patch;
      },
    };
    const unsubscribe = subscribeCostAttribution((record) => {
      records.push(record);
      applyLocalAiRoutingCostAttribution({ health } as never, record);
    });

    await AutoTitleService.getInstance().generateTitle(
      'Investigate the broken deployment and summarize the fix.',
    );
    unsubscribe();

    const correlated = records.filter((record) => (
      (record as { correlationId?: string }).correlationId === 'routing-title'
    ));
    expect(correlated).toHaveLength(1);
    expect(correlated[0]).toEqual(expect.objectContaining({
      correlationId: 'routing-title',
      provider: 'anthropic',
      usage: expect.objectContaining({ inputTokens: 30, outputTokens: 4, cost: 0.01 }),
      costKnown: true,
    }));
    expect(durablePatch).toMatchObject({
      provider: 'anthropic',
      knownCostUsd: 0.01,
      inputTokens: 30,
      outputTokens: 4,
    });
    expect(durablePatch).not.toHaveProperty('estimatedCostUsd');
  });

  it.each(['success', 'error'] as const)('records an uncorrelated title escalation with outcome %s', async outcome => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({ installed: type === 'claude' }));
    mockResolveCliType.mockResolvedValue('claude');
    if (outcome === 'error') mockSendMessage.mockRejectedValue(new Error('provider failed'));
    else mockSendMessage.mockResolvedValue({ content: 'Deployment title', usage: { inputTokens: 20, outputTokens: 4, cost: 0.01 } });
    const { subscribeCostAttribution } = await import('../core/system/cost-attribution');
    const records: unknown[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    try {
      await AutoTitleService.getInstance().generateTitle('Investigate the broken deployment and summarize the fix.');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ purpose: 'helper', taskType: 'aux:titleGeneration', outcome, costSource: outcome === 'error' ? 'unknown' : 'provider' });
    } finally { stop(); }
  });

  it('keeps the plain title while its helper is paused without probing a paid CLI', async () => {
    mockAuxGenerate.mockResolvedValue({ text: '', decision: { slot: 'titleGeneration', provider: 'local-fallback', source: 'fallback', reason: 'paused', allowFrontierFallback: true, pausedUntil: Date.now() + 60_000 } });
    const applyTitle = vi.fn();
    await AutoTitleService.getInstance().maybeGenerateTitle('paused', 'Investigate the failing helper model.', applyTitle);
    expect(mockCreateAdapter).not.toHaveBeenCalled();
    expect(mockIsCliAvailable).not.toHaveBeenCalled();
    expect(applyTitle).toHaveBeenCalledWith('paused', expect.any(String), 'instant');
    expect(applyTitle).not.toHaveBeenCalledWith('paused', expect.any(String), 'ai');
  });

  it('uses the live session while its helper is paused (the real paused decision shape)', async () => {
    // A paused helper reports allowFrontierFallback:false with pausedUntil set
    // (auxiliary-backoff-integration.spec.ts pins that shape).
    mockAuxGenerate.mockResolvedValue({ text: '', decision: { slot: 'titleGeneration', provider: 'local-fallback', source: 'fallback', reason: 'Paused until 12:00', allowFrontierFallback: false, pausedUntil: Date.now() + 60_000 } });
    const service = AutoTitleService.getInstance();
    const liveTitle = vi.fn().mockResolvedValue('Investigate failing helper');
    service.setLiveTitleSource(liveTitle);
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('paused-live', 'Investigate the failing helper model.', applyTitle);
    expect(liveTitle).toHaveBeenCalledTimes(1);
    expect(applyTitle).toHaveBeenLastCalledWith('paused-live', 'Investigate failing helper', 'ai');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
    expect(mockIsCliAvailable).not.toHaveBeenCalled();
  });

  it('does not use the live session while paused when the slot forbids frontier fallback', async () => {
    mockAuxGenerate.mockResolvedValue({ text: '', decision: { slot: 'titleGeneration', provider: 'local-fallback', source: 'fallback', reason: 'Paused until 12:00', allowFrontierFallback: false, pausedUntil: Date.now() + 60_000 } });
    mockSlotAllowsFrontier.mockReturnValueOnce(false);
    const service = AutoTitleService.getInstance();
    const liveTitle = vi.fn().mockResolvedValue('Never used');
    service.setLiveTitleSource(liveTitle);
    await service.maybeGenerateTitle('paused-private', 'Investigate the failing helper model.', vi.fn());
    expect(liveTitle).not.toHaveBeenCalled();
  });

  it('logs "AI title upgrade skipped" once per instance, however often a title is requested', async () => {
    const service = AutoTitleService.getInstance();
    service.setCliSpawnEnabledForTesting(false);
    service.setLiveTitleSource(vi.fn().mockResolvedValue(null));
    const skipped = () => mockLog.info.mock.calls.filter(([message]) =>
      String(message).startsWith('AI title upgrade skipped')).length;
    await service.generateTitle('Fix the broken deploy pipeline', [], 'chat-a');
    await service.generateTitle('Fix the broken deploy pipeline', [], 'chat-a');
    expect(skipped()).toBe(1);
    await service.generateTitle('Fix the broken deploy pipeline', [], 'chat-b');
    expect(skipped()).toBe(2);
    service.clearInstance('chat-a');
    await service.generateTitle('Fix the broken deploy pipeline', [], 'chat-a');
    expect(skipped()).toBe(3);
  });

  it('stops title candidates after a budget stop and retains the billed cost', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: true });
    mockResolveCliType.mockImplementation(async (type: string) => type);
    mockSendMessage.mockResolvedValue({ content: 'partial', metadata: { budgetExceeded: true }, usage: { cost: 0.11 } });
    const { subscribeCostAttribution } = await import('../core/system/cost-attribution');
    const records: unknown[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    try {
      expect(await AutoTitleService.getInstance().generateTitle('Investigate the broken deployment and summarize the fix.')).toBeNull();
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockCreateAdapter).toHaveBeenCalledOnce();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'budget-exceeded', costSource: 'provider', usage: { cost: 0.11 } });
    } finally { stop(); }
  });

  it.each([
    ['claude', 'claude', 'anthropic', 'haiku'],
    ['codex', 'codex', 'openai', 'gpt-5.6-luna'],
    ['antigravity', 'antigravity', 'google', 'gemini-3.8-flash'],
    ['antigravity', 'gemini', 'google', 'gemini-2.5-flash'],
  ] as const)(
    'patches a missing-cost %s CLI winner as pricing provider %s',
    async (availableCandidate, resolvedCli, expectedProvider, expectedModel) => {
      // gemini-3.8-flash (agy's current Flash) is priced only by the models.dev
      // overlay, which the app seeds from its bundled snapshot at startup.
      const { clearModelRateOverlay, registerProviderModelRates } = await import(
        '../../shared/data/model-pricing'
      );
      clearModelRateOverlay();
      registerProviderModelRates([
        { provider: 'google', id: 'gemini-3.8-flash', rate: { input: 0.75, output: 3.75 } },
      ]);
      mockAuxGenerate.mockResolvedValue({
        text: '',
        decision: {
          slot: 'titleGeneration',
          provider: 'local-fallback',
          source: 'fallback',
          reason: 'authorized',
          allowFrontierFallback: true,
          fallbackDisposition: 'allowed',
          localAiRoutingEventId: `routing-${resolvedCli}`,
        },
      });
      mockIsCliAvailable.mockImplementation(async (type: string) => ({
        installed: type === availableCandidate,
      }));
      mockResolveCliType.mockResolvedValue(resolvedCli);
      mockSendMessage.mockResolvedValue({ content: 'Estimated title' });
      const { subscribeCostAttribution } = await import('../core/system/cost-attribution');
      const { applyLocalAiRoutingCostAttribution } = await import(
        '../local-ai-guard/local-ai-runtime'
      );
      let durablePatch: Record<string, unknown> | undefined;
      const health = {
        getRoutingEvent: (eventId: string) => (
          eventId === `routing-${resolvedCli}` ? { id: eventId } : undefined
        ),
        updateRoutingEvent: (_eventId: string, patch: Record<string, unknown>) => {
          durablePatch = patch;
        },
      };
      const unsubscribe = subscribeCostAttribution((record) => {
        applyLocalAiRoutingCostAttribution({ health } as never, record);
      });
      const message = 'Investigate the broken deployment and summarize the fix.';

      await AutoTitleService.getInstance().generateTitle(message);
      unsubscribe();

      expect(durablePatch).toMatchObject({
        provider: expectedProvider,
        model: expectedModel,
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number),
      });
      expect(durablePatch?.['inputTokens']).toBeGreaterThan(Math.ceil(message.length / 4));
      expect(durablePatch).not.toHaveProperty('knownCostUsd');
    },
  );

  it('does not accept requestedProvider parameter', async () => {
    // Verify the signature only takes 4 params
    const service = AutoTitleService.getInstance();
    expect(service.maybeGenerateTitle.length).toBeLessThanOrEqual(4);
  });

  it('folds the attachment filename into a generic instant title, subject-first', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please fully implement this',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    // Leads with the distinctive file subject, not the generic verb, so the
    // recognizable part survives rail truncation.
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Loopfixex implementation', 'instant');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('leads with the attachment subject for a plain "implement this" + long filename (screenshot case)', async () => {
    // No CLI: only the instant (Phase 1) title is exercised. Reproduces the
    // header that previously showed only "Implement…" because the verb led and
    // the distinctive filename was truncated away.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please implement this',
      applyTitle,
      false,
      ['2026-06-02-chrome-devtools-managed-profile-attach.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Chrome devtools managed profile attach implementation',
      'instant',
    );
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('uses the attached plan subject instead of a trailing quality instruction', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please implement this, be thorough',
      applyTitle,
      false,
      ['2026-05-28-first-class-remote-orchestration-plan.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'First class remote orchestration implementation',
      'instant',
    );
  });

  it('titles from the attachment when there is no message text', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      '',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'loopfixex.md', 'instant');
  });

  it('skips a pasted session ID on its own line and titles from the real message', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      '1ed2be54-1026-428c-a407-9a52c835759b\nWhere has all your text gone, I just see my messages to you',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Where has all your text gone, I just see my messages to you',
      'instant',
    );
  });

  it('does not force the filename into an already-distinctive title', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Refactor the AuthService session cache',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Refactor the AuthService session cache', 'instant');
  });

  it('titles a loop-with-attachments kickoff from its files, not the injected header', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    const prompt = [
      'Attached files (relative to workspace; use your file-read tools):',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
      '',
      'Please work these files and implement them. Be thorough.',
    ].join('\n');

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      prompt,
      applyTitle,
      false,
    );

    // Before the fix this stamped "Attached files (relative to workspace; use…".
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Mobile control app implementation', 'instant');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('strips the attachment preamble before sending the AI title prompt', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const prompt = [
      'Attached files (relative to workspace; use your file-read tools):',
      '- .aio-loop-attachments/loop-x/2026-05-30-mobile-control-app-plan.md',
      '',
      'Please work these files and implement them. Be thorough.',
    ].join('\n');

    await AutoTitleService.getInstance().generateTitle(prompt);

    const sent = mockSendMessage.mock.calls[0][0].content as string;
    // The injected boilerplate header must not reach the model...
    expect(sent).not.toContain('relative to workspace');
    // ...but the real file name should, as the attachment subject.
    expect(sent).toContain('2026-05-30-mobile-control-app-plan.md');
  });

  it('discards an AI title that is actually a provider rate-limit notice', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: "You've hit your session limit · resets 6:30pm" });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Phase 1 instant title still applies...
    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      'instant',
    );
    // ...but the limit notice must never be stamped as the AI title.
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
  });

  it('keeps a legitimate AI title that merely mentions "limit"', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: 'Session-limit retry bug' });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Session-limit retry bug', 'ai');
  });

  // ── LT-533: every escalation exit must be visible ─────────────────────────
  // These paths were `logger.debug` or a bare `catch { return null; }`, and debug
  // is not persisted — so an escalation that silently produced nothing looked
  // exactly like one that never ran. That is what hid the failure in production.

  it('logs a persisted warning when no fast-tier CLI is available (LT-533)', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text: 'x'.repeat(400), // rejected by the length gate, so escalation runs
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug thoroughly please.',
      vi.fn(),
      false,
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('no fast-tier CLI available'),
      expect.objectContaining({ tried: expect.arrayContaining(['claude']) }),
    );
  });

  it('logs the error and elapsed time when the CLI one-shot throws (LT-533)', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockRejectedValue(new Error('spawn ENOENT'));
    mockAuxGenerate.mockResolvedValue({
      text: 'x'.repeat(400),
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug thoroughly please.',
      vi.fn(),
      false,
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('AI title escalation failed'),
      expect.objectContaining({
        cliType: 'claude',
        error: 'spawn ENOENT',
        elapsedMs: expect.any(Number),
      }),
    );
  });

  it('logs when the CLI adapter cannot do a one-shot send (LT-533)', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    // An adapter with no `sendMessage` at all — the shape the one-shot guard exists for.
    mockCreateAdapter.mockReturnValue({} as unknown as { sendMessage: typeof mockSendMessage });
    mockAuxGenerate.mockResolvedValue({
      text: 'x'.repeat(400),
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug thoroughly please.',
      vi.fn(),
      false,
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot do a one-shot send'),
      expect.objectContaining({ cliType: 'claude' }),
    );
  });

  it('logs when the CLI one-shot returns unusable output (LT-533)', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    // Over the 80-char narration bound, so finalizeGeneratedTitle rejects it.
    mockSendMessage.mockResolvedValue({ content: 'y'.repeat(400) });
    mockAuxGenerate.mockResolvedValue({
      text: 'x'.repeat(400),
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug thoroughly please.',
      vi.fn(),
      false,
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('escalation returned unusable output'),
      expect.objectContaining({ cliType: 'claude', outputLength: 400 }),
    );
  });

  it('logs the successful CLI escalation so the route is visible (LT-533)', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: 'Upgrade Angular 22' });
    mockAuxGenerate.mockResolvedValue({
      text: 'x'.repeat(400),
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: true,
      },
    });

    const applyTitle = vi.fn();
    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Upgrade angular to the latest version of angular 22.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Upgrade Angular 22', 'ai');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining('generated via CLI escalation'),
      expect.objectContaining({ cliType: 'claude' }),
    );
  });

  it('discards an over-long auxiliary title (real 119-char numbered-list case)', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text:
        '1. Node Proxy Server 2. Chrome DevTools Login 3. Screenshot Capture '
        + '4. File Save to aio-transfers 5. Screenshot Analysis',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Short screenshot task. Capture the pricing page and save it.',
      applyTitle,
      false,
    );

    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
    expect(applyTitle).toHaveBeenCalledWith('instance-1', expect.any(String), 'instant');
  });

  it('discards an auxiliary title that narrates instead of answering (real 193-char case)', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text:
        'The tab title should summarize importing modules into a context worker '
        + 'with an error. It needs to be concise (3-6 words) and start with the '
        + 'most distinctive word. **Title:** Module Import Issue',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Importing modules into a context worker throws at startup.',
      applyTitle,
      false,
    );

    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
  });

  it('front-loads and rail-truncates an auxiliary title, as the CLI branch does', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text: 'Please fix the UnstablePvP coin accounting flow',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'The coin accounting flow is wrong somewhere in the ledger.',
      applyTitle,
      false,
    );

    // "Please " is a generic lead-in and must be stripped, exactly as it would
    // be for a CLI-generated title.
    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Fix the UnstablePvP coin accounting flow',
      'ai',
    );
  });

  it('discards an auxiliary title that is only unfinished <think> reasoning', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text: '<think> Alright, I need to help the user summarize this tab title.',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug and strip raw reasoning tags.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Investigate the tab renaming bug and strip raw reasoning...',
      'instant',
    );
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('<think>'), 'ai');
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
  });

  it('discards an auxiliary title that is only unfinished bracket thinking', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });
    mockAuxGenerate.mockResolvedValue({
      text: '[THINKING] I should produce a concise tab title.',
      decision: {
        slot: 'titleGeneration',
        provider: 'ollama',
        source: 'local',
        reason: 'test local',
        allowFrontierFallback: false,
      },
    });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the tab renaming bug and strip raw reasoning tags.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Investigate the tab renaming bug and strip raw reasoning...',
      'instant',
    );
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('[THINKING]'), 'ai');
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
  });

  it('strips closed <think> reasoning before accepting a CLI-generated title', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({
      content: '<think>Need a short title.</think>\nTab rename sanitizer',
    });

    const title = await AutoTitleService.getInstance().generateTitle(
      'Investigate the tab renaming bug and strip raw reasoning tags.',
    );

    expect(title).toBe('Tab rename sanitizer');
  });

  it('passes attachment names to the AI title prompt', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please fully implement this',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('loopfixex.md'),
      }),
    );
  });

  describe('title quality repair', () => {
    it.each([
      'Completed',
      'We are done',
      'cz3mwn04e',
    ])(
      'keeps the task subject when opening naming returns %s', async (text) => {
        mockAuxGenerate.mockResolvedValue({ text, decision: { source: 'local', allowFrontierFallback: false } });
        const applyTitle = vi.fn();
        const service = AutoTitleService.getInstance();
        await service.maybeGenerateTitle('status', 'Work Finder watchdog faults', applyTitle);
        expect(applyTitle).toHaveBeenCalledTimes(1);
        expect(applyTitle).toHaveBeenCalledWith('status', 'Work Finder watchdog faults', 'instant');
      },
    );
    const localDecision = { source: 'local', allowFrontierFallback: false };
    const invalidBoundaryAnswers = [
      'waiting_for_input',
      "Suggested title",
      "Untitled thread",
      "Idle",
      "Pending approval",
      'Please 1) Work Finder filters',
      'Please Title: Work Finder filters',
      'Please The session involves Work Finder filters',
      '1)Work Finder filters',
      '１２３',
      'Please 1)Work Finder filters',
      'Question ١٢٣',
      'I am done',
      "We've found no issues",
      "Job completed",
      '## Work Finder filters',
      "Suggested title: Work Finder watchdog",
      "Here’s a proposed title: Work Finder watchdog",
      "Title — Work Finder watchdog",
      "I've fixed Work Finder watchdog",
      "1– Work Finder watchdog",
      "Fixing this issue",
      "Investigations completed",
    ];

    it.each(invalidBoundaryAnswers)(
      'keeps the opening subject across local and opening naming for %s', async (text) => {
        mockAuxGenerate.mockResolvedValue({ text, decision: localDecision });
        const service = AutoTitleService.getInstance();
        expect(await service.generateLocalTitle('Work Finder watchdog faults')).toBeNull();
        const applyTitle = vi.fn();
        await service.maybeGenerateTitle('boundary', 'Work Finder watchdog faults', applyTitle);
        expect(mockAuxGenerate).toHaveBeenCalledTimes(2);
        expect(applyTitle.mock.calls).toEqual([['boundary', 'Work Finder watchdog faults', 'instant']]);
        expect(mockIsCliAvailable).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['Please Work Finder filters', 'Work Finder filters'],
      ['Work Finder delivery readiness research case ownership reconciliation repairs',
        'Work Finder delivery readiness research case ownership...'],
      ['OAuth2 HTTP 500', 'OAuth2 HTTP 500'],
      ['Angular ２２ migration', 'Angular ２２ migration'],
      ['HTTP 500: gateway faults', 'HTTP 500: gateway faults'],
      ["IT inventory sync", "IT inventory sync"],
      ["Work Finder title: parsing fixes", "Work Finder title: parsing fixes"],
      ['Session-settings', 'Session-settings'],
    ])('preserves useful formatted title %s', async (text, expected) => {
      mockAuxGenerate.mockResolvedValue({ text, decision: localDecision });
      expect(await AutoTitleService.getInstance().generateLocalTitle('Work Finder watchdog faults')).toBe(expected);
    });

    it.each(['1.', '12345', '1. Work Finder filters', 'Done', 'Please implement this', '**Question 5**'])(
      'rejects unusable local-only history title %s', async (text) => {
        mockAuxGenerate.mockResolvedValue({ text, decision: localDecision });
        expect(await AutoTitleService.getInstance().generateLocalTitle('Work Finder delivery readiness faults')).toBeNull();
        expect(mockIsCliAvailable).not.toHaveBeenCalled();
      },
    );

    it.each([
      '1. Work Finder filters',
      'Not logged in · Please run /login',
      'Not logged in. Run `codex login`',
      ...invalidBoundaryAnswers,
    ])(
      'tries the next eligible CLI after invalid answer %s from the first', async (content) => {
        mockIsCliAvailable.mockResolvedValue({ installed: true });
        mockResolveCliType.mockImplementation(async (type: string) => type);
        mockSendMessage.mockResolvedValueOnce({ content })
          .mockResolvedValueOnce({ content: 'Work Finder watchdog faults' });

        expect(await AutoTitleService.getInstance().generateTitle('Work Finder health watchdog found faults')).toBe(
          'Work Finder watchdog faults',
        );
        expect(mockCreateAdapter).toHaveBeenCalledTimes(2);
        expect(mockCreateAdapter).toHaveBeenNthCalledWith(1, expect.objectContaining({ cliType: 'antigravity' }));
        expect(mockCreateAdapter).toHaveBeenNthCalledWith(2, expect.objectContaining({ cliType: 'claude' }));
      },
    );

    it('does not replace a known subject with an incidental attachment after a generic model answer', async () => {
      mockAuxGenerate.mockResolvedValue({ text: '1.', decision: localDecision });
      const service = AutoTitleService.getInstance();
      expect(await service.generateLocalTitle('Work Finder watchdog faults need repairing', ['1'])).toBeNull();
      expect(await service.generateLocalTitle('Work Finder watchdog faults need repairing', ['screenshot.png']))
        .toBeNull();
      expect(await service.generateLocalTitle('Please implement this', ['1'])).toBeNull();
      expect(await service.generateLocalTitle('Please implement this', ['work-finder-plan.md']))
        .toBe('Work finder implementation');
    });

    it('does not apply an in-flight title after the instance is cleared', async () => {
      let finishOpening!: (result: unknown) => void;
      mockAuxGenerate.mockImplementationOnce(() => new Promise((resolve) => { finishOpening = resolve; }));
      const applyTitle = vi.fn();
      const service = AutoTitleService.getInstance();
      const opening = service.maybeGenerateTitle('closed', 'Work Finder watchdog found faults', applyTitle);
      service.clearInstance('closed');
      finishOpening({ text: 'Work Finder watchdog faults', decision: localDecision });
      await opening;
      expect(applyTitle.mock.calls.filter(([, , source]) => source === 'ai')).toEqual([]);
    });

  });

  it('repairs a low-signal AI title using the attached plan subject', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: 'Be thorough' });

    const title = await AutoTitleService.getInstance().generateTitle(
      'Please implement this, be thorough',
      ['2026-05-28-first-class-remote-orchestration-plan.md'],
    );

    expect(title).toBe('First class remote orchestration implementation');
  });
});
