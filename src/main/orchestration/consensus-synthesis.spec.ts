import { describe, expect, it } from 'vitest';
import {
  computeAgreementScore,
  extractSharedTerms,
  identifyDissent,
  synthesizeFromResponses,
  truncateContent,
  truncateToFirstParagraph,
} from './consensus-synthesis';
import type { ConsensusProviderResponse } from './consensus.types';

function response(provider: string, content: string, success = true): ConsensusProviderResponse {
  return {
    provider,
    content,
    success,
    durationMs: 10,
  };
}

describe('consensus-synthesis', () => {
  it('reports total failure when every provider failed', () => {
    const result = synthesizeFromResponses([
      response('claude', '', false),
      response('codex', '', false),
    ]);
    expect(result.consensus).toContain('All providers failed');
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
  });

  it('returns raw stacked responses for the all strategy', () => {
    const result = synthesizeFromResponses([
      response('claude', 'Use a lock'),
      response('codex', 'Use a queue'),
    ], 'all');
    expect(result.consensus).toContain('[claude]');
    expect(result.consensus).toContain('Use a lock');
    expect(result.agreement).toBe(0);
  });

  it('scores identical long-form answers as high agreement', () => {
    const text = 'Shared recommendation about retrying the failed request carefully';
    expect(computeAgreementScore([
      response('claude', text),
      response('codex', text),
    ])).toBe(1);
  });

  it('extracts majority terms and dissent on shallow vs deep answers', () => {
    const short = 'retry later maybe';
    const long = 'retry later maybe after checking the timeout caveat: the queue can overflow.';
    const terms = extractSharedTerms([
      response('claude', long),
      response('codex', long),
      response('gemini', short),
    ]);
    expect(terms).toContain('retry');
    expect(identifyDissent([
      response('claude', long.repeat(20)),
      response('codex', short),
    ], 0.4)).toEqual(expect.arrayContaining([
      'Responses varied significantly in depth/detail',
      'Low vocabulary overlap suggests fundamentally different perspectives',
    ]));
  });

  it('truncates long content and first paragraphs', () => {
    expect(truncateContent('abcdef', 4)).toBe('abcd...');
    expect(truncateToFirstParagraph('first\n\nsecond', 20)).toBe('first...');
  });
});
