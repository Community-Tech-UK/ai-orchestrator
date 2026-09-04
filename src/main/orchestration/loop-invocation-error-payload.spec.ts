import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { buildLoopInvocationErrorPayload } from './loop-invocation-error-payload';

function build(error: unknown, overrides: { model?: string } = {}) {
  return buildLoopInvocationErrorPayload({
    correlationId: 'corr-1',
    invocation: 'loop iteration',
    error,
    ...overrides,
  });
}

describe('buildLoopInvocationErrorPayload partial usage', () => {
  it('carries finite non-negative usage fields across the error boundary', () => {
    const payload = build(
      Object.assign(new Error('prompt timed out'), {
        partialUsage: {
          inputTokens: 1_200.7,
          outputTokens: 800,
          totalTokens: 2_000.7,
          isEstimated: true,
        },
        partialModel: '  grok-4.6  ',
      }),
    );

    expect(payload.partialUsage).toEqual({
      inputTokens: 1_200,
      outputTokens: 800,
      totalTokens: 2_000,
      isEstimated: true,
    });
    expect(payload.model).toBe('grok-4.6');
  });

  it('drops non-finite, negative, and non-numeric usage fields', () => {
    const payload = build(
      Object.assign(new Error('boom'), {
        partialUsage: {
          inputTokens: Number.NaN,
          outputTokens: -50,
          cacheReadTokens: '900',
          reasoningTokens: Number.POSITIVE_INFINITY,
          totalTokens: 42,
        },
      }),
    );

    expect(payload.partialUsage).toEqual({ totalTokens: 42 });
  });

  it('omits partial usage entirely when nothing positive survived sanitization', () => {
    expect(build(Object.assign(new Error('boom'), { partialUsage: { inputTokens: 0 } })).partialUsage)
      .toBeUndefined();
    expect(build(Object.assign(new Error('boom'), { partialUsage: { isEstimated: true } })).partialUsage)
      .toBeUndefined();
    expect(build(Object.assign(new Error('boom'), { partialUsage: [1, 2, 3] })).partialUsage)
      .toBeUndefined();
    expect(build(Object.assign(new Error('boom'), { partialUsage: 'lots' })).partialUsage)
      .toBeUndefined();
    expect(build(new Error('boom')).partialUsage).toBeUndefined();
  });

  it('prefers an explicitly supplied model over the adapter partial model', () => {
    const payload = build(
      Object.assign(new Error('boom'), { partialModel: 'grok-4.6' }),
      { model: 'composer-2.5' },
    );

    expect(payload.model).toBe('composer-2.5');
  });

  it('ignores a blank partial model rather than emitting an empty string', () => {
    expect(build(Object.assign(new Error('boom'), { partialModel: '   ' })).model).toBeUndefined();
  });

  it('falls back to the adapter partial model when the caller supplied a blank one', () => {
    const payload = build(
      Object.assign(new Error('boom'), { partialModel: 'grok-4.6' }),
      { model: '  ' },
    );

    expect(payload.model).toBe('grok-4.6');
  });
});
