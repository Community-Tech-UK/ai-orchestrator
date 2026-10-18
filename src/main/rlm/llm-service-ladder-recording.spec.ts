import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMService } from './llm-service';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { withLocalAiCostCorrelation } from '../local-ai-guard/local-ai-cost-correlation';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';

vi.mock('./auxiliary-llm-service', () => ({ getAuxiliaryLlmService: () => ({ generate: async () => ({ text: '', decision: { source: 'fallback', allowFrontierFallback: true } }) }) }));

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('LLMService ladder attribution', () => {
  let records: CostAttributionRecord[];
  let stop: () => void;
  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    records = [];
    stop = subscribeCostAttribution(record => records.push(record));
    LLMService._resetForTesting();
    for (const provider of ['anthropic', 'ollama', 'openai']) getCircuitBreakerRegistry().getBreaker(`llm-${provider}`).reset();
  });
  afterEach(() => { stop(); LLMService._resetForTesting(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('records the basic summary winner as known free cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const service = LLMService.getInstance({ provider: 'local', anthropicApiKey: '', openaiApiKey: '' });
    await service.checkOllamaHealth();
    await service.generate('summarize', 'Please summarize this content. Summary:');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'helper', provider: 'aio-basic-summary', costSource: 'free', costKnown: true, usage: { cost: 0 } });
  });

  it('records Ollama tokens without charging for the fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/api/tags') ? {} : { response: 'local answer', prompt_eval_count: 101, eval_count: 33 })));
    const service = LLMService.getInstance({ provider: 'ollama', model: 'local-fixture' });
    expect(await service.generate('system', 'user')).toBe('local answer');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'ollama', model: 'local-fixture', costSource: 'free', usage: { inputTokens: 101, outputTokens: 33, cost: 0 } });
  });

  it.each([undefined, 'routing-fixture'])('records a paid winner with correlation %s', async correlationId => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/api/tags') ? {} : { content: [{ type: 'text', text: 'paid answer' }], usage: { input_tokens: 101, output_tokens: 33 } })));
    const service = LLMService.getInstance({ provider: 'anthropic', anthropicApiKey: 'test-placeholder', model: 'haiku' });
    const run = () => service.generate('system', 'user');
    expect(await (correlationId ? withLocalAiCostCorrelation(correlationId, run) : run())).toBe('paid answer');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'helper', provider: 'anthropic', model: 'haiku', usage: { inputTokens: 101, outputTokens: 33 } });
    expect(records[0]?.correlationId).toBe(correlationId);
  });
});
