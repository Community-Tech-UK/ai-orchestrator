import { describe, it, expect } from 'vitest';
import { isReviewerRateLimitError } from './cross-model-review-service.constants';

describe('isReviewerRateLimitError', () => {
  it.each([
    'HTTP 429 Too Many Requests',
    'Error: rate limit exceeded',
    'quota exceeded for this key',
    'Grok Build: usage limit reached for your subscription',
    'You have hit your daily limit reached',
    'resource exhausted',
    'insufficient_quota',
    'Model overloaded, try again later',
  ])('flags %s as a rate limit', (msg) => {
    expect(isReviewerRateLimitError(msg)).toBe(true);
  });

  it.each([
    'spawn agy ENOENT',
    'Reviewer returned unparseable output',
    'Antigravity CLI timeout',
  ])('does not flag %s', (msg) => {
    expect(isReviewerRateLimitError(msg)).toBe(false);
  });
});
