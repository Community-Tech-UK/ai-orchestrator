import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_INSTANCE_STATUSES } from '../../shared/attention/attention-level';

const { mockAuxGenerate, mockCreateAdapter, mockResolveCliType, mockSendMessage, mockIsCliAvailable } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockAuxGenerate: vi.fn(),
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

import { AutoTitleService } from './auto-title-service';

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

  it.each([
    ['claude', 'claude', 'anthropic', 'haiku'],
    ['codex', 'codex', 'openai', 'gpt-5.6-luna'],
    ['antigravity', 'antigravity', 'google', 'gemini-3.5-flash'],
    ['antigravity', 'gemini', 'google', 'gemini-2.5-flash'],
  ] as const)(
    'patches a missing-cost %s CLI winner as pricing provider %s',
    async (availableCandidate, resolvedCli, expectedProvider, expectedModel) => {
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
    it.each(['Completed', 'Finished', 'Task completed', 'Task complete', 'In progress', 'Success', 'Pending', 'Work completed successfully', 'In-progress', 'Task-completed',
      'All work has been completed', 'We are done', 'All set', 'Awaiting instructions', 'The task is complete',
      'No action required', 'Waiting for input', 'Not yet completed', 'Currently in progress', 'Cancelled',
      'cz3mwn04e', 'Cz3mwn04e', 'x8f3k2m1p', 's7j4x1q9w',
      'All tests passed', 'Finished without errors', 'Ready for testing', 'Needs clarification'])(
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
      "Short title",
      "Suggested title",
      "Proposed name",
      "Recommended heading",
      "Concise summary",
      "Brief session",
      "Candidate title",
      "Descriptive name",
      "Final title",
      "Title suggestion",
      "Suggested name",
      "Name proposal",
      "Session recommendation",
      ...ALL_INSTANCE_STATUSES,
      "Untitled thread",
      "Untitled session",
      "New conversation",
      "New chat",
      "Untitled",
      "Unnamed",
      "Unnamed session",
      "New session",
      "New thread",
      "Empty conversation",
      "Default session",
      "Unknown task",
      "No subject",
      "No title",
      "Session title",
      "Conversation name",
      "Untitled chat",
      "Untitled conversation",
      "New task",
      "Unknown subject",
      "Idle",
      "Busy",
      "Initializing",
      "Terminated",
      "Hibernated",
      "Hibernating",
      "Waking",
      "Approved",
      "Rejected",
      "Denied",
      "Aborted",
      "Awaiting command",
      "Acknowledging receipt",
      "Pending approval",
      "Session initialized",
      "Request rejected",
      "Task aborted",
      "Request approved",
      "Request denied",
      'Please 1) Work Finder filters', 'Please Title: Work Finder filters',
      'Please The session involves Work Finder filters',
      '1)Work Finder filters', '1.Work Finder filters', '１２３', '١٢٣',
      'Please 1)Work Finder filters', 'Question ١٢٣',
      'I am done', 'Nothing to report', 'Ready to assist', 'No issues found',
      'Everything looks good', 'In process', 'Acknowledged', 'Understood', 'No problem',
      'Happy to help', 'Ready for your request', 'All checks look fine', 'No issues detected',
      'No further assistance needed', 'Everything appears normal',
      'I’m done', "I'm ready to assist", "We've found no issues",
      "Job completed", "Operation successful", "Activity in progress",
      "Result ready", "All requests processed", "Ready when you are",
      "No more changes needed", "No additional action needed", "Analysis complete",
      "Response provided", "Successfully processed", "Task handled",
      "Standing by", "Waiting for next instruction", "Completed as requested",
      "Execution complete", "No errors encountered", "Help available",
      "Work accomplished", "Everything working perfectly", "Nothing left to do",
      "No outstanding issues", "Pending confirmation", "Ready to answer",
      "Preparing response", "Proceeding with task", "Action taken",
      "Request accepted", "Task wrapped up", "No change required",
      "No fixes needed", "Investigation complete", "Done investigating",
      "Task completion", "Assistant ready", "Agent ready",
      '1: Work Finder filters', '1 - Work Finder filters', '(1) Work Finder filters',
      '## Work Finder filters', '١:Work Finder filters', '１: Work Finder filters',
      "Suggested title: Work Finder watchdog",
      'Topic: Work Finder watchdog',
      'Suggested topic: Work Finder watchdog',
      'Here is the suggested topic: Work Finder watchdog',
      'Tab: Work Finder watchdog',
      'Suggested tab: Work Finder watchdog',
      'Summary: Work Finder watchdog',
      'Suggested summary: Work Finder watchdog',
      "Here is the suggested title: Work Finder watchdog",
      "Recommended name for this session: Work Finder watchdog",
      "Candidate heading: Work Finder watchdog",
      "Here’s a proposed title: Work Finder watchdog",
      "Title — Work Finder watchdog",
      "Suggested title -Work Finder watchdog",
      "I've fixed Work Finder watchdog",
      "We’re investigating Work Finder watchdog",
      "You should check Work Finder watchdog",
      "1– Work Finder watchdog",
      "1 -Work Finder watchdog",
      "1—Work Finder watchdog",
      "1- Work Finder watchdog",
      "I'm fixing this",
      "Fixing this issue",
      "Reviewing this request",
      "Investigating this problem",
      "Debugging this issue",
      "Handling this request",
      "Resolving this issue",
      "Completing this task",
      "Implementing this request",
      "Processing this request",
      "Reporting this issue",
      "Assisting with this task",
      "Investigations completed",
      "Agents ready",
      "Assistants awaiting instructions",
      "Requesting assistance",
      "Needing more input",
      "Addressing this issue",
      "Helping with this request",
      "Looking at this issue",
      "Verifying this task",
      "Applying changes",
      "Accepting this request",
      "Delivering the result",
      "Executing this task",
      "Achieving completion",
      "Accomplishing this task",
      "Concluding the investigation",
      "Satisfying this request",
      "Detecting issues",
      "Observing the issue",
      "Identifying this issue",
      "Answering this request",
      "Replying to this request",
      "Wrapping up this task",
      "Resuming this task",
      "Restarting this task",
      "Stopping this task",
      "Pausing this task",
      "Cancelling this task",
      "Restoring the session",
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
      ['1.2 compatibility repairs', '1.2 compatibility repairs'],
      ['OAuth2 HTTP 500', 'OAuth2 HTTP 500'],
      ['Angular ２２ migration', 'Angular ２２ migration'],
      ['Report pagination', 'Report pagination'], ['Work Finder issues found', 'Work Finder issues found'],
      ['HTTP process diagnostics', 'HTTP process diagnostics'], ['404 error diagnostics', '404 error diagnostics'],
      ['HTTP 500: gateway faults', 'HTTP 500: gateway faults'], ['3D renderer fixes', '3D renderer fixes'],
      ['Job runner metrics', 'Job runner metrics'], ['Operation logs routing', 'Operation logs routing'],
      ['Analysis dashboard layout', 'Analysis dashboard layout'], ['Result table sorting', 'Result table sorting'],
      ['Execution trace viewer', 'Execution trace viewer'], ['Agent settings editor', 'Agent settings editor'],
      ["I/O stream diagnostics", "I/O stream diagnostics"],
      ["IT inventory sync", "IT inventory sync"],
      ["2-factor authentication fixes", "2-factor authentication fixes"],
      ["64-bit migration", "64-bit migration"],
      ["3-D renderer faults", "3-D renderer faults"],
      ["Work Finder title: parsing fixes", "Work Finder title: parsing fixes"],
      ['Work Finder topic editor', 'Work Finder topic editor'],
      ['Tab layout accessibility', 'Tab layout accessibility'],
      ['Summary dashboard rendering', 'Summary dashboard rendering'],
      ['Session-settings', 'Session-settings'],
      ["New chat message routing", "New chat message routing"],
      ["Title editor accessibility", "Title editor accessibility"],
      ["Default theme contrast", "Default theme contrast"],
      ["Unknown HTTP status handling", "Unknown HTTP status handling"],
      ["Idle timeout diagnostics", "Idle timeout diagnostics"],
      ["Permission editor accessibility", "Permission editor accessibility"],
      ["Thread restore routing", "Thread restore routing"],
      ["Untitled document rendering", "Untitled document rendering"],
      ["Chat history pagination", "Chat history pagination"],
    ])('preserves useful formatted title %s', async (text, expected) => {
      mockAuxGenerate.mockResolvedValue({ text, decision: localDecision });
      expect(await AutoTitleService.getInstance().generateLocalTitle('Work Finder watchdog faults')).toBe(expected);
    });

    it.each(['1.', '12345', '1. Work Finder filters', 'Done', 'Please implement this', '**Question 5**', 'Completed', 'Finished', 'Task complete', 'In progress', 'Success'])(
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
