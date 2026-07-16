/**
 * Fable WS11.3 — never-worse guard.
 */

import { describe, expect, it } from 'vitest';
import { pickSmaller } from './never-worse';

describe('pickSmaller', () => {
  it('keeps the transformed text when it is genuinely smaller', () => {
    const result = pickSmaller('a long original text', 'short');
    expect(result).toEqual({
      content: 'short',
      picked: 'transformed',
      originalSize: 20,
      transformedSize: 5,
    });
  });

  it('falls back to the original when the transform inflated the content', () => {
    const result = pickSmaller('tiny', 'a much longer so-called summary of tiny');
    expect(result.content).toBe('tiny');
    expect(result.picked).toBe('original');
  });

  it('keeps the transformed text on a tie (assumed higher signal)', () => {
    const result = pickSmaller('abcd', 'wxyz');
    expect(result.picked).toBe('transformed');
  });

  it('respects a custom estimator (e.g. token-based)', () => {
    const words = (text: string) => text.split(/\s+/).length;
    // Transformed has fewer words but more characters.
    const result = pickSmaller('a b c d e', 'extraordinarily-long-single-word', words);
    expect(result.picked).toBe('transformed');
    expect(result.originalSize).toBe(5);
    expect(result.transformedSize).toBe(1);
  });
});
