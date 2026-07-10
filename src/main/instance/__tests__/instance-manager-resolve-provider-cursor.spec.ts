/**
 * Verifies that resolveProviderName routes the 'cursor' instanceProvider to the
 * 'cursor' ProviderName so that provider runtime envelopes for Cursor-backed
 * instances reach the renderer instead of being dropped by the
 * unsupported-provider fallback.
 *
 * resolveProviderName is a pure function (it only touches the module-level
 * logger), so we import and call it directly — no InstanceManager construction
 * or electron mocking required.
 */

import { describe, it, expect } from 'vitest';

import { resolveProviderName } from '../provider-runtime-helpers';

describe('resolveProviderName - cursor', () => {
  it('returns cursor when instanceProvider = cursor (implicit)', () => {
    expect(resolveProviderName('test-instance-id', undefined, 'cursor')).toBe('cursor');
  });

  it('returns cursor when explicitProvider = cursor', () => {
    expect(resolveProviderName('test-instance-id', 'cursor', undefined)).toBe('cursor');
  });
});
