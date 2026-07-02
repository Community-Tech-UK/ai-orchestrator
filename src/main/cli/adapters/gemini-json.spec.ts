import { describe, expect, it } from 'vitest';
import {
  geminiApiErrorMessage,
  geminiAssistantText,
  geminiErrorText,
  geminiEventType,
  geminiResultText,
  geminiToolName,
  geminiUsageTotals,
  parseGeminiNdjsonEvent,
  parseGeminiStreamingEvent,
} from './gemini-json';

describe('parseGeminiNdjsonEvent', () => {
  it('parses a valid event object', () => {
    const event = parseGeminiNdjsonEvent('{"type":"text","text":"hi"}');
    expect(event).not.toBeNull();
    expect(geminiEventType(event!)).toBe('text');
  });

  it('rejects non-object payloads', () => {
    expect(parseGeminiNdjsonEvent('"just a string"')).toBeNull();
    expect(parseGeminiNdjsonEvent('[1,2,3]')).toBeNull();
    expect(parseGeminiNdjsonEvent('42')).toBeNull();
    expect(parseGeminiNdjsonEvent('null')).toBeNull();
  });

  it('returns null for plain text without throwing', () => {
    expect(parseGeminiNdjsonEvent('not json at all')).toBeNull();
  });
});

describe('parseGeminiStreamingEvent', () => {
  it('accepts a truncated assistant message with useful content', () => {
    const event = parseGeminiStreamingEvent('{"type":"message","role":"assistant","content":"partial tex');
    expect(event).not.toBeNull();
    expect(geminiAssistantText(event!)).toContain('partial tex');
  });

  it('rejects a truncated event with no useful payload', () => {
    expect(parseGeminiStreamingEvent('{"type":"tool_call","name":"re')).toBeNull();
  });
});

describe('geminiAssistantText', () => {
  it('extracts assistant message content', () => {
    expect(geminiAssistantText({ type: 'message', role: 'assistant', content: 'hello' })).toBe('hello');
  });

  it('extracts text events', () => {
    expect(geminiAssistantText({ type: 'text', text: 'chunk' })).toBe('chunk');
  });

  it('returns null for wrong-typed content instead of leaking objects', () => {
    expect(geminiAssistantText({ type: 'message', role: 'assistant', content: { nested: true } })).toBeNull();
    expect(geminiAssistantText({ type: 'message', role: 'assistant', content: 42 })).toBeNull();
    expect(geminiAssistantText({ type: 'text', text: ['a'] })).toBeNull();
  });

  it('returns null for user messages and empty strings', () => {
    expect(geminiAssistantText({ type: 'message', role: 'user', content: 'hi' })).toBeNull();
    expect(geminiAssistantText({ type: 'message', role: 'assistant', content: '' })).toBeNull();
  });
});

describe('geminiToolName', () => {
  it('reads the tool/name/toolName variants in order', () => {
    expect(geminiToolName({ tool: 'read_file' })).toBe('read_file');
    expect(geminiToolName({ name: 'grep' })).toBe('grep');
    expect(geminiToolName({ toolName: 'bash' })).toBe('bash');
    expect(geminiToolName({ data: { toolName: 'nested' } })).toBe('nested');
  });

  it('falls back to unknown for missing or wrong-typed names', () => {
    expect(geminiToolName({})).toBe('unknown');
    expect(geminiToolName({ tool: 7, name: null, data: 'string' })).toBe('unknown');
    expect(geminiToolName({ data: { toolName: 99 } })).toBe('unknown');
  });
});

describe('geminiErrorText', () => {
  it('handles string errors', () => {
    expect(geminiErrorText({ error: 'boom' })).toBe('boom');
  });

  it('handles {message} error objects', () => {
    expect(geminiErrorText({ error: { message: 'model not found' } })).toBe('model not found');
  });

  it('falls back to the top-level message field', () => {
    expect(geminiErrorText({ message: 'top-level' })).toBe('top-level');
  });

  it('serializes unrecognized payloads instead of throwing', () => {
    expect(geminiErrorText({ error: { code: 429 } })).toBe('{"code":429}');
    expect(geminiErrorText({ error: 42 })).toBe('42');
  });
});

describe('geminiResultText', () => {
  it('returns string results verbatim', () => {
    expect(geminiResultText({ result: 'done' })).toBe('done');
  });

  it('serializes object results', () => {
    expect(geminiResultText({ result: { files: 3 } })).toBe('{"files":3}');
  });

  it('returns ok when no result present', () => {
    expect(geminiResultText({})).toBe('ok');
  });
});

describe('geminiApiErrorMessage', () => {
  it('extracts the message from an error result event', () => {
    expect(
      geminiApiErrorMessage({ type: 'result', status: 'error', error: { message: 'ModelNotFoundError' } }),
    ).toBe('ModelNotFoundError');
  });

  it('accepts string errors and serializes shapeless ones', () => {
    expect(geminiApiErrorMessage({ type: 'result', status: 'error', error: 'quota' })).toBe('quota');
    expect(geminiApiErrorMessage({ type: 'result', status: 'error', error: { code: 8 } })).toBe('{"code":8}');
  });

  it('returns null for success results and non-result events', () => {
    expect(geminiApiErrorMessage({ type: 'result', status: 'ok' })).toBeNull();
    expect(geminiApiErrorMessage({ type: 'error', error: 'x' })).toBeNull();
    expect(geminiApiErrorMessage({ type: 'result', status: 'error' })).toBeNull();
  });
});

describe('geminiUsageTotals', () => {
  it('reads result stats format', () => {
    expect(geminiUsageTotals({ type: 'result', stats: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }))
      .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it('reads result usageMetadata format and derives totals', () => {
    expect(geminiUsageTotals({ type: 'result', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }))
      .toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('reads turn.completed usage format', () => {
    expect(geminiUsageTotals({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 4 } }))
      .toEqual({ inputTokens: 2, outputTokens: 4, totalTokens: 6 });
  });

  it('reads a generic top-level usage object', () => {
    expect(geminiUsageTotals({ type: 'anything', usage: { promptTokenCount: 1, candidatesTokenCount: 2 } }))
      .toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('degrades gracefully on wrong-typed usage fields', () => {
    expect(geminiUsageTotals({ type: 'result', stats: { input_tokens: 'ten', output_tokens: null } }))
      .toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(geminiUsageTotals({ usage: { input_tokens: 'NaN' } })).toBeNull();
    expect(geminiUsageTotals({ usage: 'not an object' })).toBeNull();
    expect(geminiUsageTotals({})).toBeNull();
  });
});
