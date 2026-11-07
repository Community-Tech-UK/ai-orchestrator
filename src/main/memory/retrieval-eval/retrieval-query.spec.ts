import { describe, expect, it } from 'vitest';
import { prepareRetrievalQuery } from './retrieval-query';
describe('shared retrieval query', () => {
  it('recovers the last question after a pasted log', () => {
    const result = prepareRetrievalQuery('log context '.repeat(180) + '\nWhy are migrations failing after restart?');
    expect(result.query).toBe('Why are migrations failing after restart?');
    expect(result.strategy).toBe('last-question');
    expect(result.terms).not.toContain('are');
    expect(result.terms).toContain('migration');
  });

  it('retains meaningful short technical terms', () => {
    const result = prepareRetrievalQuery('ci db');
    expect(result.terms).toContain('ci');
    expect(result.terms).toContain('db');
  });

  it('keeps nonempty stopword-only queries termless', () => {
    const result = prepareRetrievalQuery('the and to');
    expect(result.query).toBe('the and to');
    expect(result.terms).toEqual([]);
  });
});
