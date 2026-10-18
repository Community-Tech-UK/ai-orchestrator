import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMService } from './llm-service';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { clearModelRateOverlay, registerProviderModelRates } from '../../shared/data/model-pricing';
import { _resetCostAttributionForTesting, getCostAttributionFilePath, type CostAttributionRecord } from '../core/system/cost-attribution';
import { CostPurposeSummaryService, getCostPurposeSummary } from '../core/system/cost-purpose-summary';
import { normalizeOpenAiHelperUsage } from './llm-service-ladder-recording';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('public OpenAI helper usage through the real cost log and summary', () => {
  let directory: string;
  const model = 'disposable-helper-price-fixture';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aio-openai-usage-'));
    vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory);
    _resetCostAttributionForTesting();
    LLMService._resetForTesting();
    CostPurposeSummaryService._resetForTesting();
    clearModelRateOverlay();
    registerProviderModelRates([{ provider: 'openai', id: model, rate: { input: 1, output: 2 } }]);
    for (const provider of ['anthropic', 'openai', 'ollama']) getCircuitBreakerRegistry().getBreaker(`llm-${provider}`).reset();
  });
  afterEach(() => {
    LLMService._resetForTesting();
    CostPurposeSummaryService._resetForTesting();
    clearModelRateOverlay();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetCostAttributionForTesting();
    rmSync(directory, { recursive: true, force: true });
  });

  const cases = [
    { name: 'cached input and reasoning', details: { prompt_tokens_details: { cached_tokens: 8192 }, completion_tokens_details: { reasoning_tokens: 20 } }, input: 1808, output: 80, cache: 8192, reasoning: 20, cost: 0.0028272 },
    { name: 'no details', details: {}, input: 10000, output: 100, cache: 0, reasoning: 0, cost: 0.0102 },
    { name: 'reasoning only', details: { completion_tokens_details: { reasoning_tokens: 20 } }, input: 10000, output: 80, cache: 0, reasoning: 20, cost: 0.0102 },
    { name: 'zero details', details: { prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }, input: 10000, output: 100, cache: 0, reasoning: 0, cost: 0.0102 },
  ];

  it.each(['generate', 'subQueryStreaming'] as const)('%s preserves separate native buckets and records exactly one row per call', async method => {
    let usage: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/tags')) return new Response('', { status: 503 });
      if (method === 'generate') return Response.json({ choices: [{ message: { content: 'fixture answer' } }], usage });
      const events = [{ choices: [{ delta: { content: 'fixture answer' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null }, { choices: [], usage }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    }));
    const service = LLMService.getInstance({ provider: 'openai', anthropicApiKey: '', openaiApiKey: 'test-placeholder', model });
    await service.checkOllamaHealth();
    const summary = getCostPurposeSummary();
    expect(summary.getSummary().totals.calls).toBe(0);
    for (const [index, fixture] of cases.entries()) {
      usage = { prompt_tokens: 10000, completion_tokens: 100, total_tokens: 10100, ...fixture.details };
      if (method === 'generate') expect(await service.generate('system', 'user')).toBe('fixture answer');
      else {
        const chunks = [];
        for await (const chunk of service.subQueryStreaming({ requestId: `fixture-${index}`, prompt: 'question', context: 'context', depth: 0 })) chunks.push(chunk);
        expect(chunks.map(chunk => chunk.chunk).join('')).toBe('fixture answer');
        expect(chunks.at(-1)).toMatchObject({ done: true });
      }
      const records = readFileSync(getCostAttributionFilePath()!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CostAttributionRecord);
      expect(records, fixture.name).toHaveLength(index + 1);
      const record = records[index];
      expect(record).toMatchObject({ purpose: 'helper', provider: 'openai', model, outcome: 'success', costSource: 'priced', costKnown: true });
      expect(record.usage?.inputTokens, fixture.name).toBe(fixture.input);
      expect(record.usage?.outputTokens, fixture.name).toBe(fixture.output);
      expect(record.usage?.cacheReadTokens ?? 0, fixture.name).toBe(fixture.cache);
      expect(record.usage?.reasoningTokens ?? 0, fixture.name).toBe(fixture.reasoning);
      expect(record.usage?.totalTokens).toBe(10100);
      expect(record.usage?.cost, fixture.name).toBeCloseTo(fixture.cost, 12);
    }
    const result = summary.getSummary();
    for (const row of [result.totals, result.byPurpose[0], result.byProvider[0]]) {
      expect(row).toMatchObject({ calls: 4, inputTokens: 31808, cacheReadTokens: 8192, outputTokens: 360, reasoningTokens: 40, unknownCostCalls: 0 });
      expect(row.cost).toBeCloseTo(0.0334272, 12);
    }
    expect(result.byPurpose[0].key).toBe('helper');
    expect(result.byProvider[0].key).toBe('openai');
  });

  it('bounds native details, drops invalid counts and keeps canonical buckets stable on a second pass', () => {
    const bounded = normalizeOpenAiHelperUsage({ prompt_tokens: 100, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 50 } });
    expect(bounded).toMatchObject({ inputTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 20, outputTokens: 0, reasoningTokens: 20 });
    expect(normalizeOpenAiHelperUsage(bounded)).toEqual(bounded);
    expect(normalizeOpenAiHelperUsage({ prompt_tokens: 100, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: -1, cache_write_tokens: '50' }, completion_tokens_details: { reasoning_tokens: Infinity } }))
      .toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined });
    expect(normalizeOpenAiHelperUsage({ prompt_tokens_details: { cached_tokens: 10 } })).toBeUndefined();
    expect(normalizeOpenAiHelperUsage(null)).toBeUndefined();
  });
});
