import { describe, expect, it, vi } from 'vitest';
import { ContextTokenEstimator } from './context-token-estimator';

describe('ContextTokenEstimator', () => {
  it('uses an injected provider tokenizer and labels the result as provider-tokenizer', () => {
    const tokenize = vi.fn(() => 37);
    const estimator = new ContextTokenEstimator(tokenize);

    expect(estimator.estimate('fixture text')).toEqual({
      tokens: 37,
      estimateKind: 'provider-tokenizer',
    });
    expect(tokenize).toHaveBeenCalledWith('fixture text');
  });

  it.each([
    () => 0,
    () => -1,
    () => Number.NaN,
    () => 1.5,
    () => { throw new Error('fixture tokenizer failure'); },
  ])('falls back conservatively when the provider tokenizer is unusable', (tokenize) => {
    const estimator = new ContextTokenEstimator(tokenize);

    expect(estimator.estimate('twelve chars')).toEqual({
      tokens: Buffer.byteLength('twelve chars', 'utf8'),
      estimateKind: 'conservative-fallback',
    });
  });

  it('uses UTF-8 bytes as the conservative provider-neutral ceiling', () => {
    const estimator = new ContextTokenEstimator();

    expect(estimator.estimate('你好世界')).toEqual({
      tokens: Buffer.byteLength('你好世界', 'utf8'),
      estimateKind: 'conservative-fallback',
    });
    expect(estimator.estimate('')).toEqual({
      tokens: 0,
      estimateKind: 'conservative-fallback',
    });
  });

  it.each(['x_y-z.0/1', '{}[]()!@#$%^&*']) (
    'does not undercount adversarial ASCII token boundaries in %s',
    (text) => {
      const estimator = new ContextTokenEstimator();
      expect(estimator.estimate(text).tokens).toBe(Buffer.byteLength(text, 'utf8'));
    },
  );
});
