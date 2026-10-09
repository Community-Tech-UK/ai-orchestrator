import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JSON_STRING_CHUNK_CHARS,
  stringifyContinuityEnvelope,
  stringifyJsonStringLiteral,
} from './continuity-payload-envelope';

const SAMPLES = [
  '',
  'plain ascii',
  'quotes " and \\ backslashes',
  'control \u0000\u0001\b\f\n\r\t\u001b[31m chars',
  'latin-1 é ü ß and line separators \u2028\u2029',
  'emoji 😀 and box drawing ─┼─ and CJK 漢字',
  'lone high \ud83d then text',
  'text then lone low \ude00',
  '\ud83d😀\ude00',
  '</script><!-- html-ish -->',
];

describe('stringifyJsonStringLiteral', () => {
  it('matches JSON.stringify for short strings', () => {
    for (const sample of SAMPLES) {
      expect(stringifyJsonStringLiteral(sample)).toBe(JSON.stringify(sample));
    }
  });

  it('matches JSON.stringify byte-for-byte at every chunk size', () => {
    const joined = SAMPLES.join('|');
    for (let chunkChars = 1; chunkChars <= joined.length + 1; chunkChars++) {
      expect(stringifyJsonStringLiteral(joined, chunkChars)).toBe(JSON.stringify(joined));
    }
  });

  it('never splits a surrogate pair across slices', () => {
    // The pair straddles the first slice boundary for chunkChars = 3.
    const value = 'ab😀cd😀';
    expect(stringifyJsonStringLiteral(value, 3)).toBe(JSON.stringify(value));
    expect(stringifyJsonStringLiteral(value, 3)).not.toContain('\\ud83d');
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => stringifyJsonStringLiteral('abc', 0)).toThrow(RangeError);
    expect(() => stringifyJsonStringLiteral('abc', 1.5)).toThrow(RangeError);
  });
});

describe('stringifyContinuityEnvelope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces the exact bytes of the previous JSON.stringify envelope', () => {
    const data = JSON.stringify({ conversation: SAMPLES, nested: { a: 'x"y' } });
    expect(stringifyContinuityEnvelope(false, data)).toBe(JSON.stringify({ encrypted: false, data }));
    expect(stringifyContinuityEnvelope(true, 'YmFzZTY0')).toBe(
      JSON.stringify({ encrypted: true, data: 'YmFzZTY0' }),
    );
  });

  it('round-trips a payload larger than one slice', () => {
    const payload = { content: '─😀"\\\n'.repeat(Math.ceil(JSON_STRING_CHUNK_CHARS / 3)) };
    const data = JSON.stringify(payload);
    expect(data.length).toBeGreaterThan(JSON_STRING_CHUNK_CHARS);

    const envelope = stringifyContinuityEnvelope(false, data);

    expect(envelope).toBe(JSON.stringify({ encrypted: false, data }));
    const parsed = JSON.parse(envelope) as { encrypted: boolean; data: string };
    expect(parsed.encrypted).toBe(false);
    expect(JSON.parse(parsed.data)).toEqual(payload);
  });

  it('never hands JSON.stringify a string longer than one slice', () => {
    const data = 'x─'.repeat(JSON_STRING_CHUNK_CHARS * 2);
    const longest: number[] = [];
    const real = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
      if (typeof value === 'string') longest.push(value.length);
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) {
          if (typeof child === 'string') longest.push(child.length);
        }
      }
      return (real as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify);

    stringifyContinuityEnvelope(false, data);

    expect(longest.length).toBeGreaterThan(1);
    expect(Math.max(...longest)).toBeLessThanOrEqual(JSON_STRING_CHUNK_CHARS + 1);
  });
});
