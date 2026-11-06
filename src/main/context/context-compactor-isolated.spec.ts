import { beforeEach, describe, expect, it, vi } from 'vitest';

const externalAI = vi.hoisted(() => ({
  available: vi.fn<() => Promise<boolean>>(),
  generate: vi.fn<(
    slot: string,
    system: string,
    prompt: string,
    options?: { preserveInput?: boolean },
  ) => Promise<{ text: string; decision: { source: 'local' | 'fallback'; allowFrontierFallback: boolean } }>>(),
}));
const costSink = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('../rlm/llm-service', () => ({
  getLLMService: () => ({ isAvailable: externalAI.available, generate: vi.fn() }),
}));
vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate: externalAI.generate }),
}));
vi.mock('../core/system/cost-attribution', () => ({ recordCostAttribution: costSink.record }));

import { ContextCompactor } from './context-compactor';

describe('isolated forced context compaction', () => {
  beforeEach(() => {
    ContextCompactor._resetForTesting();
    externalAI.available.mockReset().mockResolvedValue(true);
    externalAI.generate.mockReset().mockResolvedValue({
      text: 'Model-written handoff',
      decision: { source: 'local', allowFrontierFallback: false },
    });
    costSink.record.mockReset();
  });

  it('summarises below the normal trigger even when the model output is larger than the source, without changing the singleton', async () => {
    const shared = ContextCompactor.getInstance();
    shared.addTurn({ role: 'user', content: 'unrelated shared task', tokenCount: 5 }, { suppressAutoCompact: true });
    const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 0 });
    isolated.addTurn({ role: 'assistant', content: 'short earlier work', tokenCount: 4 });
    externalAI.generate.mockResolvedValueOnce({
      text: 'Long model-written handoff '.repeat(30),
      decision: { source: 'local', allowFrontierFallback: false },
    });

    const result = await isolated.compact({ force: true, preserveRecentOverride: 0 });

    expect(result.summaryGenerated).toBe(true);
    expect(result.compactedTokens).toBeGreaterThan(result.originalTokens);
    expect(isolated.getState().summaries[0]?.content).toContain('Long model-written handoff');
    expect(shared.getState().turns.map(turn => turn.content)).toEqual(['unrelated shared task']);
    expect(shared.getState().summaries).toEqual([]);
  });

  it('passes an explicitly fitted prompt intact to the compression helper and carries the prior summary', async () => {
    const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 0 });
    isolated.addTurn({ role: 'assistant', content: 'new work', tokenCount: 3 });
    const priorSummary = 'Earlier decision: keep the existing API.';
    const summaryPrompt = '<prior_summary>Earlier decision: keep the existing API.</prior_summary>\n<conversation_turns>new work</conversation_turns>';
    externalAI.generate.mockImplementationOnce(async (_slot, _system, prompt, options) => ({
      text: options?.preserveInput && prompt === summaryPrompt ? 'Fitted handoff was read' : 'Prompt lost',
      decision: { source: 'local', allowFrontierFallback: false },
    }));

    await isolated.compact({ force: true, preserveRecentOverride: 0, priorSummary, summaryPrompt });

    expect(isolated.getState().summaries[0]?.content).toContain('Fitted handoff was read');
    expect(externalAI.generate).toHaveBeenCalledWith(
      'compression', expect.stringContaining('another agent can continue'), summaryPrompt, { preserveInput: true },
    );
  });

  it('Step 7 item 5: tells the compression helper a manual compaction is user-initiated, and an automatic one is not', async () => {
    const summaryPrompt = '<conversation_turns>new work</conversation_turns>';
    const run = async (options: { userInitiated?: boolean; summaryPrompt?: string }) => {
      externalAI.generate.mockClear();
      const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 0 });
      isolated.addTurn({ role: 'assistant', content: 'new work', tokenCount: 3 });
      await isolated.compact({ force: true, preserveRecentOverride: 0, ...options });
      return externalAI.generate.mock.calls[0]?.[3];
    };

    expect(await run({ userInitiated: true })).toEqual({ userInitiated: true });
    expect(await run({ userInitiated: true, summaryPrompt })).toEqual({ preserveInput: true, userInitiated: true });
    expect(await run({})).toBeUndefined();
    expect(await run({ summaryPrompt })).toEqual({ preserveInput: true });
  });

  it('uses the basic fallback while retaining the full explicit prior summary when the helper is unavailable', async () => {
    externalAI.available.mockResolvedValue(false);
    const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 0 });
    isolated.addTurn({ role: 'assistant', content: 'new work', tokenCount: 3 });
    const priorSummary = `${'Earlier state. '.repeat(70)}Final unresolved ask: restore the export.`;

    const result = await isolated.compact({ force: true, preserveRecentOverride: 0, priorSummary });

    expect(result.summaryGenerated).toBe(true);
    expect(isolated.getState().summaries[0]?.content).toContain('Final unresolved ask: restore the export.');
    expect(externalAI.generate).not.toHaveBeenCalled();
    expect(costSink.record).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'helper', provider: 'aio-basic-summary', costSource: 'free', costUsd: 0,
    }));
  });

  it('keeps the ordinary savings guard when force is omitted', async () => {
    const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 0, maxContextTokens: 1 });
    isolated.addTurn({ role: 'assistant', content: 'short work', tokenCount: 4 });
    externalAI.generate.mockResolvedValueOnce({
      text: 'Large handoff '.repeat(30),
      decision: { source: 'local', allowFrontierFallback: false },
    });

    const result = await isolated.compact();

    expect(result.summaryGenerated).toBe(false);
    expect(isolated.getState().summaries).toEqual([]);
  });

  it('keeps the ordinary latest-user protection even when the preserved tail already has a user', async () => {
    const isolated = ContextCompactor.createIsolated({ autoCompact: false, preserveRecent: 2, maxContextTokens: 1 });
    isolated.addTurn({ role: 'user', content: 'older user request', tokenCount: 100 });
    isolated.addTurn({ role: 'assistant', content: 'older answer', tokenCount: 100 });
    isolated.addTurn({ role: 'user', content: 'newer user request', tokenCount: 100 });
    isolated.addTurn({ role: 'assistant', content: 'newer answer', tokenCount: 100 });

    const result = await isolated.compact();

    expect(result.summaryGenerated).toBe(true);
    expect(isolated.getState().turns.map(turn => turn.content)).toContain('older user request');
  });
});
