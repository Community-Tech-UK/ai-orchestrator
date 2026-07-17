import { describe, expect, it } from 'vitest';
import { sanitizeRetrievalQuery, QUERY_SANITIZE_THRESHOLD } from './query-sanitizer';

describe('sanitizeRetrievalQuery', () => {
  it('leaves short queries untouched', () => {
    const result = sanitizeRetrievalQuery('  issue session token  ');
    expect(result).toEqual({ query: 'issue session token', sanitized: false, strategy: 'unchanged' });
  });

  it('recovers the last question from a contaminated 2k-char paste', () => {
    const dump = 'x'.repeat(1_500) + '\nHere is a giant stack trace and a file.\n' +
      'How do I rotate the session token before it expires?';
    const result = sanitizeRetrievalQuery(dump);
    expect(result.sanitized).toBe(true);
    expect(result.strategy).toBe('last-question');
    expect(result.query).toBe('How do I rotate the session token before it expires?');
  });

  it('picks the LAST question when several are present', () => {
    const dump = 'y'.repeat(400) + ' What is A? Some text. What is B?';
    expect(sanitizeRetrievalQuery(dump).query).toBe('What is B?');
  });

  it('falls back to the last meaningful line when there is no question', () => {
    const dump = 'log line one\n' + 'z'.repeat(400) + '\n\n   find the backoff jitter helper   ';
    const result = sanitizeRetrievalQuery(dump);
    expect(result.strategy).toBe('tail-line');
    expect(result.query).toBe('find the backoff jitter helper');
  });

  it('strips surrounding quotes/backticks from the recovered intent', () => {
    const dump = 'w'.repeat(400) + '\n`scheduleReconnect after a link drop`';
    expect(sanitizeRetrievalQuery(dump).query).toBe('scheduleReconnect after a link drop');
  });

  it('hard-truncates when no question or short tail line exists', () => {
    const dump = 'a '.repeat(400); // one giant line, no question, no newline
    const result = sanitizeRetrievalQuery(dump);
    expect(result.strategy).toBe('truncated');
    expect(result.query.length).toBeLessThanOrEqual(300);
    expect(result.query.length).toBeGreaterThan(0);
  });

  it('threshold boundary: exactly-threshold is untouched, one over is sanitized', () => {
    const atThreshold = 'q'.repeat(QUERY_SANITIZE_THRESHOLD);
    expect(sanitizeRetrievalQuery(atThreshold).sanitized).toBe(false);
    const overThreshold = 'q'.repeat(QUERY_SANITIZE_THRESHOLD + 1);
    expect(sanitizeRetrievalQuery(overThreshold).sanitized).toBe(true);
  });
});
