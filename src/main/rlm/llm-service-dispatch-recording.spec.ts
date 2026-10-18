import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMService } from './llm-service';
import { generateWithAnthropic, generateWithOpenAI, streamWithAnthropic, streamWithOpenAI } from './llm-service-providers';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { withLocalAiCostCorrelation } from '../local-ai-guard/local-ai-cost-correlation';
import { getLocalAiAuxiliaryHooks, __setLocalAiAuxiliaryHooksForTesting, __resetLocalAiAuxiliaryHooksForTesting } from '../local-ai-guard/local-ai-auxiliary-bridge';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('helper ladder actual HTTP dispatch attribution', () => {
  let records: CostAttributionRecord[];
  let unsubscribe: () => void;
  const availability = () => ({ anthropicAvailable: null, openaiAvailable: null, ollamaAvailable: null });
  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    records = [];
    unsubscribe = subscribeCostAttribution(record => records.push(record));
    LLMService._resetForTesting();
    for (const provider of ['anthropic', 'openai', 'ollama']) getCircuitBreakerRegistry().getBreaker(`llm-${provider}`).reset();
  });
  afterEach(() => { unsubscribe(); LLMService._resetForTesting(); __resetLocalAiAuxiliaryHooksForTesting(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each(['anthropic', 'openai'] as const)('records the rejected %s dispatch before the free basic winner', async provider => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: false, status: 503, statusText: 'Synthetic outage' }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const service = LLMService.getInstance({ provider, anthropicApiKey: provider === 'anthropic' ? 'test-placeholder' : '',
      openaiApiKey: provider === 'openai' ? 'test-placeholder' : '', model: 'fixture-model' });
    await service.checkOllamaHealth();
    await withLocalAiCostCorrelation('routing-fixture', () => service.generate('system', 'user'));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.'))).toHaveLength(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ purpose: 'helper', provider, model: 'fixture-model', correlationId: 'routing-fixture', outcome: 'error', costSource: 'unknown', costKnown: false });
    expect(records[1]).toMatchObject({ provider: 'aio-basic-summary', costSource: 'free' });
  });

  it('preserves provider paid usage on a cancelled dispatch without a duplicate success row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError', partialUsage: { cost: 0.42, inputTokens: 100 } }); }));
    await expect(generateWithAnthropic({ provider: 'anthropic', anthropicApiKey: 'test-placeholder' }, availability(), 'system', 'user')).rejects.toThrow('Cancelled');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'anthropic', outcome: 'cancelled', costSource: 'provider', usage: { cost: 0.42, inputTokens: 100 } });
  });

  it('does not record missing credentials, breaker refusal or failed authorization before fetch', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: false }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateWithOpenAI({ provider: 'openai' }, availability(), 'system', 'user')).rejects.toThrow('not configured');
    const breaker = getCircuitBreakerRegistry().getBreaker('llm-anthropic');
    vi.spyOn(breaker, 'isAllowed').mockReturnValue(false);
    const service = LLMService.getInstance({ provider: 'anthropic', anthropicApiKey: 'test-placeholder', openaiApiKey: '' });
    await service.checkOllamaHealth();
    await service.generate('system', 'user');
    expect(records.filter(record => record.provider === 'anthropic')).toHaveLength(0);
    __setLocalAiAuxiliaryHooksForTesting({ ...getLocalAiAuxiliaryHooks(), markFallbackDispatched: async () => { throw new Error('Synthetic authorization refusal'); } });
    await expect(withLocalAiCostCorrelation('refused', () => generateWithAnthropic({ provider: 'anthropic', anthropicApiKey: 'test-placeholder' }, availability(), 'system', 'user'))).rejects.toThrow('authorization refusal');
    expect(records.filter(record => record.provider === 'anthropic')).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.'))).toHaveLength(0);
  });

  it.each(['anthropic', 'openai'] as const)('records one successful %s stream with actual usage', async provider => {
    const events = provider === 'anthropic'
      ? [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_stop' }]
      : [{ choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }, '[DONE]'];
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n`).join('')));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const stream = provider === 'anthropic' ? streamWithAnthropic : streamWithOpenAI;
    for await (const _chunk of stream({ provider, anthropicApiKey: 'test-placeholder', openaiApiKey: 'test-placeholder', model: 'fixture-model' }, availability(), 'system', 'user', 'request', new AbortController().signal)) { /* exhaust real parser */ }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider, outcome: 'success', usage: { inputTokens: 10, outputTokens: 3 } });
  });

  it.each(['anthropic', 'openai'] as const)('records interrupted %s stream once as unknown and releases the reader', async provider => {
    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: { getReader: () => ({
      read: async () => { throw Object.assign(new Error('Synthetic interrupted stream'), { name: 'AbortError' }); }, releaseLock, cancel: async () => undefined,
    }) } }) as unknown as Response));
    const run = async () => {
      const stream = provider === 'anthropic' ? streamWithAnthropic : streamWithOpenAI;
      for await (const _chunk of stream({ provider, anthropicApiKey: 'test-placeholder', openaiApiKey: 'test-placeholder' }, availability(), 'system', 'user', 'request', new AbortController().signal)) { /* exhaust real parser */ }
    };
    await expect(run()).rejects.toThrow('interrupted stream');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider, outcome: 'cancelled', costSource: 'unknown' });
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each(['anthropic', 'openai'] as const)('records an early-closed %s stream as cancelled and stops the response body', async provider => {
    const cancel = vi.fn();
    const event = provider === 'anthropic' ? { type: 'content_block_delta', delta: { text: 'partial' } }
      : { choices: [{ delta: { content: 'partial' } }] };
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n`));
    }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const stream = (provider === 'anthropic' ? streamWithAnthropic : streamWithOpenAI)(
      { provider, anthropicApiKey: 'test-placeholder', openaiApiKey: 'test-placeholder' }, availability(), 'system', 'user', 'request', new AbortController().signal);
    expect((await stream.next()).value).toMatchObject({ chunk: 'partial', done: false });
    await stream.return();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider, outcome: 'cancelled', costSource: 'unknown' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
