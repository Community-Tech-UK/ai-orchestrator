import { describe, it, expect } from 'vitest';
import { extractChatCompletionText, suppressReasoning, NO_THINK_DIRECTIVE } from '../openai-response';

describe('suppressReasoning', () => {
  it('prepends the /no_think directive to the system prompt', () => {
    expect(suppressReasoning('You score things.')).toBe(`${NO_THINK_DIRECTIVE}\n\nYou score things.`);
  });

  it('is idempotent — does not double-add when already present', () => {
    const once = suppressReasoning('Score.');
    expect(suppressReasoning(once)).toBe(once);
  });
});

describe('extractChatCompletionText', () => {
  it('returns the assistant content', () => {
    const data = { choices: [{ message: { content: '{"score":7}' }, finish_reason: 'stop' }] };
    expect(extractChatCompletionText(data)).toBe('{"score":7}');
  });

  it('trims leading/trailing whitespace (reasoning models prefix newlines)', () => {
    const data = { choices: [{ message: { content: '\n\n{"score": 10}\n' }, finish_reason: 'stop' }] };
    expect(extractChatCompletionText(data)).toBe('{"score": 10}');
  });

  it('throws when content is empty and finish_reason is length (reasoning budget exhausted)', () => {
    const data = {
      choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }],
    };
    expect(() => extractChatCompletionText(data)).toThrowError(/empty content/);
    expect(() => extractChatCompletionText(data)).toThrowError(/finish_reason=length/);
    expect(() => extractChatCompletionText(data)).toThrowError(/maxOutputTokens|non-reasoning/);
  });

  it('throws when content is whitespace-only', () => {
    const data = { choices: [{ message: { content: '   \n ' }, finish_reason: 'stop' }] };
    expect(() => extractChatCompletionText(data)).toThrowError(/empty content/);
  });

  it('throws (not crashes) on a malformed/empty response', () => {
    expect(() => extractChatCompletionText({})).toThrowError(/empty content/);
    expect(() => extractChatCompletionText(null)).toThrowError(/empty content/);
  });
});
