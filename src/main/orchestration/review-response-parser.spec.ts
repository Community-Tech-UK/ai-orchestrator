import { describe, it, expect } from 'vitest';
import { isLikelyReviewRefusal, parseCrossModelReviewResponse } from './review-response-parser';

const validTiered = {
  scores: {
    correctness: { reasoning: 'ok', score: 4, issues: [] },
    completeness: { reasoning: 'ok', score: 4, issues: [] },
    security: { reasoning: 'ok', score: 4, issues: [] },
    consistency: { reasoning: 'ok', score: 4, issues: [] },
  },
  overall_verdict: 'APPROVE',
  summary: 'All good',
};

describe('parseCrossModelReviewResponse', () => {
  it('normalizes bounded assumption/risk variants to the canonical shape', () => {
    const result = parseCrossModelReviewResponse('antigravity', JSON.stringify({
      ...validTiered,
      assumptions: [
        'The API remains available',
        { description: 'The caller supplies a workspace', severity: 'HIGH' },
        { assumption: 'Authorization is configured', severity: 'critical' },
      ],
      integration_risks: [{ risk: 'A downstream schema may lag' }],
    }), 'tiered', 10);

    expect(result).toMatchObject({
      assumptions: [
        { assumption: 'The API remains available', severity: 'medium' },
        { assumption: 'The caller supplies a workspace', severity: 'high' },
        { assumption: 'Authorization is configured', severity: 'critical' },
      ],
      integrationRisks: ['A downstream schema may lag'],
    });
  });

  it('returns null for an unknown assumption object shape', () => {
    const result = parseCrossModelReviewResponse('antigravity', JSON.stringify({
      ...validTiered,
      assumptions: [{ foo: 'bar', severity: 'high' }],
    }), 'tiered', 10);

    expect(result).toBeNull();
  });

  it('returns null for an unrecognized assumption severity', () => {
    const result = parseCrossModelReviewResponse('antigravity', JSON.stringify({
      ...validTiered,
      assumptions: [{ assumption: 'Authorization is configured', severity: 'urgent' }],
    }), 'tiered', 10);

    expect(result).toBeNull();
  });

  it('returns null for an invalid overall_verdict', () => {
    const result = parseCrossModelReviewResponse('antigravity', JSON.stringify({
      ...validTiered,
      overall_verdict: 'MAYBE',
    }), 'tiered', 10);

    expect(result).toBeNull();
  });

  it('returns null for an integration-risk alias that resolves to an empty string', () => {
    const result = parseCrossModelReviewResponse('antigravity', JSON.stringify({
      ...validTiered,
      integration_risks: [{ risk: '   ' }],
    }), 'tiered', 10);

    expect(result).toBeNull();
  });

  it('returns null for a plain-text refusal', () => {
    const result = parseCrossModelReviewResponse(
      'antigravity',
      'I cannot fulfill this request.',
      'tiered',
      10,
    );

    expect(result).toBeNull();
  });
});

describe('isLikelyReviewRefusal', () => {
  it('detects the observed refusal phrasings', () => {
    expect(isLikelyReviewRefusal('I cannot fulfill this request.')).toBe(true);
    expect(isLikelyReviewRefusal("I'm unable to assist with that.")).toBe(true);
    expect(isLikelyReviewRefusal('Sorry, I cannot assist with this task.')).toBe(true);
  });

  it('does not flag ordinary review prose', () => {
    expect(isLikelyReviewRefusal('{"overall_verdict":"APPROVE"}')).toBe(false);
    expect(isLikelyReviewRefusal('')).toBe(false);
  });
});
