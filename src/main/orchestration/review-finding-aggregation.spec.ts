import { describe, expect, it } from 'vitest';
import { aggregateReviewFindings, type AggregatableFinding } from './review-finding-aggregation';

function f(partial: Partial<AggregatableFinding> & { reviewer: string }): AggregatableFinding {
  return {
    title: 'finding',
    body: 'body',
    severity: 'medium',
    confidence: 0.5,
    source: 'remote',
    ...partial,
  };
}

describe('aggregateReviewFindings', () => {
  it('passes a single reviewer through with no agreement prefix', () => {
    const out = aggregateReviewFindings(
      [f({ reviewer: 'gemini', title: 'Null check', body: 'Add a null check before reading payload.value.', severity: 'medium' })],
      { totalReviewers: 1 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('Add a null check before reading payload.value.');
    expect(out[0].agreementCount).toBe(1);
    expect(out[0].reviewers).toEqual(['gemini']);
  });

  it('merges the same issue raised by two reviewers and annotates agreement', () => {
    const out = aggregateReviewFindings(
      [
        f({ reviewer: 'gemini', title: 'Missing null check on payload value', body: 'payload value dereferenced without null check', severity: 'medium' }),
        f({ reviewer: 'codex', title: 'Missing null check on payload value', body: 'payload value used without a null check guard', severity: 'high' }),
      ],
      { totalReviewers: 2 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].agreementCount).toBe(2);
    expect(out[0].reviewers).toEqual(['codex', 'gemini']);
    // severity = MAX across members (high), not escalated arbitrarily.
    expect(out[0].severity).toBe('high');
    expect(out[0].body).toContain('2/2 reviewers independently flagged this.');
  });

  it('keeps distinct issues separate', () => {
    const out = aggregateReviewFindings(
      [
        f({ reviewer: 'gemini', title: 'Null check', body: 'payload value dereferenced without null check' }),
        f({ reviewer: 'codex', title: 'SQL injection', body: 'user input concatenated into a SQL query string', severity: 'critical' }),
      ],
      { totalReviewers: 2 },
    );
    expect(out).toHaveLength(2);
    // Critical sorts first.
    expect(out[0].severity).toBe('critical');
    expect(out.every((finding) => finding.agreementCount === 1)).toBe(true);
  });

  it('does NOT merge similar text in different files', () => {
    const out = aggregateReviewFindings(
      [
        f({ reviewer: 'gemini', title: 'Missing null check', body: 'payload value dereferenced without null check', file: 'a.ts' }),
        f({ reviewer: 'codex', title: 'Missing null check', body: 'payload value dereferenced without null check', file: 'b.ts' }),
      ],
      { totalReviewers: 2 },
    );
    expect(out).toHaveLength(2);
  });

  it('does NOT escalate severity purely from agreement (three lows stay low)', () => {
    const out = aggregateReviewFindings(
      [
        f({ reviewer: 'a', title: 'Naming nit', body: 'variable name foo is unclear and should be renamed', severity: 'low' }),
        f({ reviewer: 'b', title: 'Naming nit', body: 'variable foo is unclear, please rename it for clarity', severity: 'low' }),
        f({ reviewer: 'c', title: 'Naming nit', body: 'the variable foo has an unclear name, rename suggested', severity: 'low' }),
      ],
      { totalReviewers: 3 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('low');
    expect(out[0].agreementCount).toBe(3);
    expect(out[0].body).toContain('3/3 reviewers independently flagged this.');
  });

  it('uses totalReviewers for the N/M ratio even when not all agreed', () => {
    const out = aggregateReviewFindings(
      [
        f({ reviewer: 'a', title: 'Race condition', body: 'two writers mutate shared state without a lock', severity: 'high' }),
        f({ reviewer: 'b', title: 'Race condition', body: 'shared state is mutated by two writers with no lock', severity: 'high' }),
      ],
      { totalReviewers: 3 },
    );
    expect(out[0].body).toContain('2/3 reviewers independently flagged this.');
  });

  it('returns an empty array for no findings', () => {
    expect(aggregateReviewFindings([], { totalReviewers: 2 })).toEqual([]);
  });

  it('marks a local-only finding advisory even when it is critical', () => {
    const [finding] = aggregateReviewFindings([
      f({
        reviewer: 'local:qwen',
        source: 'local',
        title: 'Unsafe mutation',
        body: 'shared state is mutated without synchronization',
        severity: 'critical',
      }),
    ], { totalReviewers: 3 });

    expect(finding.advisory).toBe(true);
    expect(finding.reviewerProvenance).toEqual([
      { reviewer: 'local:qwen', source: 'local' },
    ]);
  });

  it('removes advisory status when a remote reviewer corroborates a local finding', () => {
    const [finding] = aggregateReviewFindings([
      f({ reviewer: 'local:qwen', source: 'local', title: 'Missing null guard', body: 'payload value is read without a null guard' }),
      f({ reviewer: 'codex', source: 'remote', title: 'Missing null guard', body: 'payload value is read without a null guard' }),
    ], { totalReviewers: 3 });

    expect(finding.advisory).toBe(false);
    expect(finding.agreementCount).toBe(2);
    expect(finding.body).toContain('2/3 reviewers independently flagged this.');
    expect(finding.reviewerProvenance).toEqual([
      { reviewer: 'codex', source: 'remote' },
      { reviewer: 'local:qwen', source: 'local' },
    ]);
  });

  it.each([
    ['remote first', ['remote', 'local'] as const],
    ['local first', ['local', 'remote'] as const],
  ])('preserves remote authority for a repeated reviewer id (%s)', (_name, sources) => {
    const [finding] = aggregateReviewFindings(sources.map((source) => f({
      reviewer: 'same-id',
      source,
      title: 'Missing null guard',
      body: 'payload value is read without a null guard',
    })), { totalReviewers: 1 });

    expect(finding.advisory).toBe(false);
    expect(finding.reviewerProvenance).toEqual([{ reviewer: 'same-id', source: 'remote' }]);
  });
});
