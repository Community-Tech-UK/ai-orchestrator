import { describe, expect, it } from 'vitest';

import {
  CliStreamLineOverflowError,
  CliStreamLineParser,
} from './cli-stream-line-parser';

describe('CliStreamLineParser', () => {
  it('deframes complete lines while retaining a fragmented trailing line', () => {
    const parser = new CliStreamLineParser();

    expect(parser.push('{"id":1}\n{"id"')).toEqual(['{"id":1}']);
    expect(parser.hasPendingData()).toBe(true);
    expect(parser.push(':2}\n\n')).toEqual(['{"id":2}', '']);
    expect(parser.hasPendingData()).toBe(false);
  });

  it('handles CRLF without leaking carriage returns to consumers', () => {
    const parser = new CliStreamLineParser();

    expect(parser.push('first\r\nsecond\r\n')).toEqual(['first', 'second']);
  });

  it('flushes a final unterminated line exactly once', () => {
    const parser = new CliStreamLineParser();
    parser.push('trailing');

    expect(parser.flush()).toEqual(['trailing']);
    expect(parser.flush()).toEqual([]);
  });

  it('fails closed and clears retained data when the bounded buffer overflows', () => {
    const parser = new CliStreamLineParser({ maxBufferBytes: 4 });

    expect(() => parser.push('12345')).toThrow(CliStreamLineOverflowError);
    expect(parser.hasPendingData()).toBe(false);
    expect(parser.getPendingByteLength()).toBe(0);
  });
});
