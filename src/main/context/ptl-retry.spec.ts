import { describe, it, expect } from 'vitest';
import {
  classifyContextOverflow,
  executeWithPTLRetry,
  extractOverflowTokenCount,
  isContextOverflowError,
  type PTLTurn,
} from './ptl-retry';

describe('context overflow classification', () => {
  it.each([
    'prompt is too long: 245,000 tokens > 200,000 maximum',
    "context_length_exceeded: This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'The input token count (1,048,577) exceeds the maximum number of tokens allowed (1,048,576).',
    'ran out of room in the context window',
    'Request exceeds context window size for this model.',
  ])('matches explicit provider overflow message: %s', message => {
    const evidence = classifyContextOverflow({ errorText: message });

    expect(evidence).toEqual({
      matched: true,
      reason: 'provider-message',
      detail: expect.stringContaining('provider overflow message'),
    });
    expect(isContextOverflowError(message)).toBe(true);
  });

  it('extracts observed and maximum token counts from provider variants', () => {
    expect(extractOverflowTokenCount('prompt is too long: 245,000 tokens > 200,000 maximum')).toEqual({
      observed: 245000,
      maximum: 200000,
    });
    expect(extractOverflowTokenCount("maximum context length is 128000 tokens. Your messages resulted in 130000 tokens.")).toEqual({
      observed: 130000,
      maximum: 128000,
    });
    expect(extractOverflowTokenCount('input token count (1,048,577) exceeds the maximum number of tokens allowed (1,048,576)')).toEqual({
      observed: 1048577,
      maximum: 1048576,
    });
  });

  it('detects silent empty output when the prompt nearly fills the context window', () => {
    const evidence = classifyContextOverflow({
      outputText: '   ',
      promptTokens: 198_200,
      contextWindowTokens: 200_000,
    });

    expect(evidence).toEqual({
      matched: true,
      reason: 'silent-empty-response',
      detail: expect.stringContaining('99.1%'),
    });
  });

  it('detects generic crashes only when token evidence is at the context ceiling', () => {
    expect(classifyContextOverflow({
      errorText: 'process exited with code 1',
      promptTokens: 199_500,
      contextWindowTokens: 200_000,
    })).toEqual({
      matched: true,
      reason: 'near-window-fill',
      detail: expect.stringContaining('99.8%'),
    });

    expect(classifyContextOverflow({
      errorText: 'process exited with code 1',
      promptTokens: 20_000,
      contextWindowTokens: 200_000,
    }).matched).toBe(false);
  });

  it('does not classify output truncation or weak silent evidence as context overflow', () => {
    expect(classifyContextOverflow({
      errorText: 'max output tokens exceeded; response was truncated',
      promptTokens: 20_000,
      contextWindowTokens: 200_000,
    }).matched).toBe(false);

    expect(classifyContextOverflow({
      outputText: '',
      promptTokens: 120_000,
      contextWindowTokens: 200_000,
    }).matched).toBe(false);
  });
});

describe('executeWithPTLRetry', () => {
  it('routes retry detection through the shared provider classifier', async () => {
    const turns: PTLTurn[] = [
      { id: 'system', role: 'system', tokenEstimate: 500, protected: true },
      { id: 'old-user', role: 'user', tokenEstimate: 1_000 },
      { id: 'old-assistant', role: 'assistant', tokenEstimate: 1_000 },
      { id: 'recent-user', role: 'user', tokenEstimate: 1_000 },
    ];
    let attempts = 0;

    const result = await executeWithPTLRetry(turns, async remainingTurns => {
      attempts++;
      if (attempts === 1) {
        throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
      }
      return remainingTurns.map(turn => turn.id);
    });

    expect(result.success).toBe(true);
    expect(result.retriesUsed).toBe(1);
    expect(result.droppedTurnIds.length).toBeGreaterThan(0);
    expect(result.result).not.toContain('old-user');
  });
});
