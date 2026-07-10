import { describe, expect, it } from 'vitest';
import { extractReviewJson } from './review-json-extract';

describe('extractReviewJson', () => {
  it('prefers the final JSON fence when a reviewer quotes code first', () => {
    const raw = [
      'The reviewed code contains this example:',
      '```json',
      '{"example":true}',
      '```',
      '```json',
      '{"issues":[]}',
      '```',
    ].join('\n');

    expect(extractReviewJson(raw)).toBe('{"issues":[]}');
  });

  it('prefers a balanced payload shaped like review findings over earlier prose JSON', () => {
    const raw = 'Metadata {"attempt":1}. Final: {"issues":[]}';

    expect(extractReviewJson(raw)).toBe('{"issues":[]}');
  });

  it('prefers a later bare payload over an earlier fenced example', () => {
    const raw = [
      'Earlier example:',
      '```json',
      '{"issues":[{"title":"example only"}]}',
      '```',
      'Final answer: {"issues":[]}',
    ].join('\n');

    expect(extractReviewJson(raw)).toBe('{"issues":[]}');
  });

  it('returns null when no parseable JSON payload exists', () => {
    expect(extractReviewJson('not JSON { unfinished')).toBeNull();
  });
});
