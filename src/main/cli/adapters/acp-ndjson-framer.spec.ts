import { describe, expect, it } from 'vitest';
import { AcpNdjsonFramer } from './acp-ndjson-framer';

describe('ACP NDJSON framing', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects a non-bounded record limit %s', (limit) => {
    expect(() => new AcpNdjsonFramer(limit)).toThrow(RangeError);
  });

  it('preserves Unicode code units split between copied fragments', () => {
    const framer = new AcpNdjsonFramer(4);
    const records: string[] = [];
    framer.push('\ud83d', (record) => records.push(record), () => undefined);
    framer.push('\ude42\n', (record) => records.push(record), () => undefined);
    expect(records).toEqual(['🙂']);
  });

  it('keeps fragmented records, CRLF, empty lines and subsequent partial records in order', () => {
    const framer = new AcpNdjsonFramer(16);
    const records: string[] = [];
    const oversized: number[] = [];
    const push = (chunk: string) => framer.push(chunk, (record) => records.push(record), (limit) => oversized.push(limit));
    push('abc');
    push('def\r');
    expect(framer.pendingText).toBe('abcdef\r');
    push('\n\n \t\nsecond\nthi');
    push('rd\n');
    expect(records).toEqual(['abcdef', 'second', 'third']);
    expect(oversized).toEqual([]);
    expect(framer.pendingText).toBe('');
  });

  it('discards an oversized fragmented record once, including apparent valid suffixes, until its delimiter', () => {
    const framer = new AcpNdjsonFramer(8);
    const records: string[] = [];
    const oversized: number[] = [];
    const push = (chunk: string) => framer.push(chunk, (record) => records.push(record), (limit) => oversized.push(limit));
    push('12345678');
    expect(framer.pendingText).toHaveLength(8);
    push('9');
    for (let index = 0; index < 10; index++) push('abcdefgh');
    expect(framer.pendingText).toBe('');
    push('{}\nvalid\r\n');
    expect(records).toEqual(['valid']);
    expect(oversized).toEqual([8]);
  });

  it('bounds complete records before parsing and resumes within the same chunk', () => {
    const framer = new AcpNdjsonFramer(8);
    const records: string[] = [];
    const oversized: number[] = [];
    framer.push('123456789\n12345678\nend\n', (record) => records.push(record), (limit) => oversized.push(limit));
    expect(records).toEqual(['12345678', 'end']);
    expect(oversized).toEqual([8]);
  });

  it('clears both incomplete and discard state before a replacement process', () => {
    const framer = new AcpNdjsonFramer(4);
    const records: string[] = [];
    framer.push('12345', (record) => records.push(record), () => undefined);
    framer.clear();
    framer.push('new\n', (record) => records.push(record), () => undefined);
    expect(records).toEqual(['new']);
    framer.push('part', (record) => records.push(record), () => undefined);
    framer.clear();
    expect(framer.pendingText).toBe('');
  });
});
