import { describe, expect, it } from 'vitest';
import { toJsonSafeProviderEventPayload } from './provider-event-raw-payload';

describe('toJsonSafeProviderEventPayload', () => {
  it('preserves plain nested JSON values', () => {
    expect(toJsonSafeProviderEventPayload({ a: ['x', 2, null] })).toEqual({ a: ['x', 2, null] });
  });

  it('converts Error, bigint, and cyclic values without throwing', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const result = toJsonSafeProviderEventPayload({
      error: new Error('provider failed'),
      count: 42n,
      cyclic,
    });

    expect(result).toMatchObject({
      error: { type: 'error', message: 'provider failed' },
      count: { type: 'bigint', value: '42' },
      cyclic: { self: { type: 'circular' } },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
