import { describe, expect, it } from 'vitest';
import {
  MAX_PARSE_LINE_CHARS,
  oversizedLineEvent,
  parseTranscriptLine,
} from './claude-transcript-usage-parser';

const TIMESTAMP = '2026-10-18T12:00:00.000Z';

/** `usage: null` builds a message with no usage block at all. */
function assistant(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> | null = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-a',
    timestamp: TIMESTAMP,
    requestId: 'req_1',
    isSidechain: false,
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'PRIVATE-REPLY-TEXT' }],
      ...(usage ? {
        usage: { input_tokens: 12, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 45_000, output_tokens: 250, ...usage },
      } : {}),
    },
    ...overrides,
  });
}

function toolResult(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'session-a',
    timestamp: TIMESTAMP,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content }] },
    ...extra,
  });
}

describe('assistant lines', () => {
  it('reads the token counts, time, model, session and response key', () => {
    expect(parseTranscriptLine(assistant())).toEqual({
      kind: 'request',
      key: 'msg_1:req_1',
      sessionId: 'session-a',
      at: Date.parse(TIMESTAMP),
      model: 'claude-opus-5',
      input: 12,
      cacheWrite: 3_000,
      cacheRead: 45_000,
      output: 250,
      sidechain: false,
      agentId: null,
    });
  });

  it('never returns what was said', () => {
    expect(JSON.stringify(parseTranscriptLine(assistant()))).not.toContain('PRIVATE-REPLY-TEXT');
  });

  it('marks helper agent lines and keeps the helper id', () => {
    const event = parseTranscriptLine(assistant({ isSidechain: true, agentId: 'agent-7' }));
    expect(event).toMatchObject({ kind: 'request', sidechain: true, agentId: 'agent-7' });
  });

  it('adds up the split cache-write counts when the total is missing', () => {
    const event = parseTranscriptLine(assistant({}, {
      cache_creation_input_tokens: undefined,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 4_000 },
    }));
    expect(event).toMatchObject({ kind: 'request', cacheWrite: 5_000 });
  });

  it('prefers the total cache-write count when both are given', () => {
    const event = parseTranscriptLine(assistant({}, {
      cache_creation_input_tokens: 9_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 4_000 },
    }));
    expect(event).toMatchObject({ kind: 'request', cacheWrite: 9_000 });
  });

  it('treats missing or odd counts as zero', () => {
    const event = parseTranscriptLine(assistant({}, {
      input_tokens: -5,
      cache_creation_input_tokens: 'many',
      cache_read_input_tokens: null,
      output_tokens: 7.9,
    }));
    expect(event).toMatchObject({ kind: 'request', input: 0, cacheWrite: 0, cacheRead: 0, output: 7 });
  });

  it('has no key when the response id is missing, so lines are never wrongly merged', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: TIMESTAMP,
      message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 1 } },
    });
    expect(parseTranscriptLine(line)).toMatchObject({ kind: 'request', key: null, sessionId: null });
  });

  it.each([
    ['a synthetic placeholder message', assistant({}, {}).replace('claude-opus-5', '<synthetic>')],
    ['an API error message', assistant({ isApiErrorMessage: true })],
    ['a message with no usage block', assistant({}, null)],
    ['a message with no timestamp', assistant({ timestamp: undefined })],
    ['a message with an unreadable timestamp', assistant({ timestamp: 'yesterday-ish' })],
    ['a message with no model', JSON.stringify({ type: 'assistant', timestamp: TIMESTAMP, message: { usage: { input_tokens: 5 } } })],
    ['a message whose counts are all zero', assistant({}, { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })],
  ])('ignores %s', (_name, line) => {
    expect(parseTranscriptLine(line)).toEqual({ kind: 'other' });
  });
});

describe('tool results', () => {
  it('measures a big text result in tokens (characters / 4)', () => {
    expect(parseTranscriptLine(toolResult('x'.repeat(50_000)))).toEqual({
      kind: 'tool-results', sidechain: false, agentId: null, bigTokens: 12_500,
    });
  });

  it('does not count a result at or under 10K tokens as big', () => {
    expect(parseTranscriptLine(toolResult('x'.repeat(40_000)))).toMatchObject({ kind: 'tool-results', bigTokens: 0 });
    expect(parseTranscriptLine(toolResult('x'.repeat(40_004)))).toMatchObject({ kind: 'tool-results', bigTokens: 10_001 });
  });

  it('adds the text blocks of a structured result and ignores images', () => {
    const content = [
      { type: 'text', text: 'a'.repeat(30_000) },
      { type: 'image', source: { type: 'base64', data: 'z'.repeat(900_000) } },
      { type: 'text', text: 'b'.repeat(30_000) },
    ];
    expect(parseTranscriptLine(toolResult(content))).toMatchObject({ kind: 'tool-results', bigTokens: 15_000 });
  });

  it('counts only the big results when a message holds several', () => {
    const line = JSON.stringify({
      type: 'user', timestamp: TIMESTAMP,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'small' },
          { type: 'tool_result', tool_use_id: 'b', content: 'y'.repeat(60_000) },
          { type: 'tool_result', tool_use_id: 'c', content: 'z'.repeat(80_000) },
        ],
      },
    });
    expect(parseTranscriptLine(line)).toMatchObject({ kind: 'tool-results', bigTokens: 15_000 + 20_000 });
  });

  it('carries the helper flag of the line', () => {
    expect(parseTranscriptLine(toolResult('hi', { isSidechain: true, agentId: 'agent-3' })))
      .toMatchObject({ kind: 'tool-results', sidechain: true, agentId: 'agent-3' });
  });

  it('never returns the result text', () => {
    expect(JSON.stringify(parseTranscriptLine(toolResult('SECRET-FILE-CONTENT ' + 'x'.repeat(50_000))))).not.toContain('SECRET');
  });

  it('ignores user messages that are not tool results', () => {
    const line = JSON.stringify({ type: 'user', timestamp: TIMESTAMP, message: { role: 'user', content: 'plain "usage" question' } });
    expect(parseTranscriptLine(line)).toEqual({ kind: 'other' });
  });
});

describe('compaction markers', () => {
  it.each([
    ['a compact boundary', JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' })],
    ['compaction metadata', JSON.stringify({ type: 'system', compactMetadata: { trigger: 'auto', preTokens: 170_000 } })],
    ['a compact summary message', JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary text' } })],
  ])('recognises %s', (_name, line) => {
    expect(parseTranscriptLine(line)).toEqual({ kind: 'compaction' });
  });
});

describe('everything else', () => {
  it('skips lines without any of the markers without decoding them', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'progress', data: { hook: 'PreToolUse' } }))).toEqual({ kind: 'other' });
    expect(parseTranscriptLine('')).toEqual({ kind: 'other' });
    expect(parseTranscriptLine('not json and no markers')).toEqual({ kind: 'other' });
  });

  it('reports a damaged line that did contain a marker', () => {
    expect(parseTranscriptLine('{"type":"assistant","message":{"usage":{"input_tokens":')).toEqual({ kind: 'invalid' });
  });

  it('ignores JSON that is not an object', () => {
    expect(parseTranscriptLine('["usage"]')).toEqual({ kind: 'other' });
  });

  it('ignores summary and other record types that mention usage', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'summary', summary: 'about "usage"' }))).toEqual({ kind: 'other' });
  });
});

describe('oversized lines', () => {
  it('judges a huge tool result by its size without decoding it', () => {
    const huge = `{"type":"user","message":{"content":[{"type":"tool_result","content":"${'x'.repeat(MAX_PARSE_LINE_CHARS)}"}]}}`;
    expect(huge.length).toBeGreaterThan(MAX_PARSE_LINE_CHARS);
    expect(parseTranscriptLine(huge)).toEqual({
      kind: 'tool-results', sidechain: false, agentId: null, bigTokens: Math.ceil(huge.length / 4),
    });
  });

  it('ignores a huge line that holds no tool result', () => {
    expect(oversizedLineEvent(MAX_PARSE_LINE_CHARS + 1, false)).toEqual({ kind: 'other' });
    expect(oversizedLineEvent(40_000, true)).toMatchObject({ kind: 'tool-results', bigTokens: 10_000 });
  });
});
