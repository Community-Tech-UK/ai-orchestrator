import { describe, expect, it } from 'vitest';
import { parseJsonWithRepair, parseNdjsonLine, parseStreamingJson, NdjsonLineBuffer } from './json-parse';

describe('json stream parsing helpers', () => {
  it('parses valid JSON without marking it repaired or partial', () => {
    const result = parseJsonWithRepair<{ answer: string }>('{"answer":"ok"}');

    expect(result).toEqual({
      ok: true,
      value: { answer: 'ok' },
      repaired: false,
      partial: false,
    });
  });

  it('repairs common provider JSON defects such as trailing commas', () => {
    const result = parseJsonWithRepair<{ answer: string }>('{"answer":"ok",}');

    expect(result).toMatchObject({
      ok: true,
      value: { answer: 'ok' },
      repaired: true,
      partial: false,
    });
  });

  it('parses an incomplete streaming object as partial data', () => {
    const result = parseStreamingJson<{ type: string; text: string }>('{"type":"text","text":"hel');

    expect(result).toMatchObject({
      ok: true,
      value: { type: 'text', text: 'hel' },
      partial: true,
    });
  });

  it('returns a bounded failure object for malformed non-JSON text', () => {
    const result = parseJsonWithRepair('not-json '.repeat(40));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON/i);
      expect(result.inputExcerpt.length).toBeLessThanOrEqual(200);
      expect(result.inputExcerpt).toContain('not-json');
    }
  });

  it('never throws for malformed input', () => {
    expect(() => parseNdjsonLine('{"unterminated":')).not.toThrow();
    expect(() => parseStreamingJson('plain text')).not.toThrow();
    expect(() => parseJsonWithRepair('plain text')).not.toThrow();
  });
});

describe('NdjsonLineBuffer', () => {
  it('holds a partial last line until the next newline', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buffer.push('2}\n')).toEqual(['{"b":2}']);
    expect(buffer.flush()).toBeNull();
  });

  it('flushes a trailing unterminated fragment', () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.push('{"a":1}\n{"b":2')).toEqual(['{"a":1}']);
    expect(buffer.flush()).toBe('{"b":2');
  });
});
