import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMService } from './llm-service';
import { SUBQUERY_SYSTEM_PROMPT, SUMMARIZE_SYSTEM_PROMPT } from './llm-service.constants';
import { logPromptInjection } from '../logging/prompt-injection-log';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../logging/prompt-injection-log', () => ({ logPromptInjection: vi.fn() }));
vi.mock('./auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({
    generate: vi.fn(async () => ({ text: 'aux answer', decision: { source: 'local', allowFrontierFallback: false } })),
  }),
}));

describe('helper prompt injection log', () => {
  beforeEach(() => {
    LLMService._resetForTesting();
    vi.mocked(logPromptInjection).mockClear();
  });

  it('logs the summary helper prompt once per summarize call', async () => {
    const service = LLMService.getInstance({ provider: 'ollama' });
    await service.summarize({ requestId: 'r1', content: 'Pinned content', targetTokens: 50 });
    expect(logPromptInjection).toHaveBeenCalledTimes(1);
    expect(logPromptInjection).toHaveBeenCalledWith('summaryHelper', SUMMARIZE_SYSTEM_PROMPT, 'r1');
  });

  it('logs the sub-query helper prompt once per routed sub-query', async () => {
    const service = LLMService.getInstance({ provider: 'ollama' });
    await service.subQueryViaAux('compression', { requestId: 'r2', context: 'ctx', prompt: 'q', depth: 0 });
    expect(logPromptInjection).toHaveBeenCalledTimes(1);
    expect(logPromptInjection).toHaveBeenCalledWith('subqueryHelper', SUBQUERY_SYSTEM_PROMPT, 'r2');
  });
});
