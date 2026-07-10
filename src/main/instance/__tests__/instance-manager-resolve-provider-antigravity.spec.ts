/**
 * Verifies that resolveProviderName routes the 'antigravity' instanceProvider to
 * the 'antigravity' ProviderName so that provider runtime envelopes for
 * Antigravity-backed instances reach the renderer instead of being dropped by
 * the unsupported-provider fallback.
 *
 * Regression: before this case was added, sending a message to an Antigravity
 * instance ran `agy` successfully but every output/status/complete envelope
 * was dropped ("Unsupported provider for runtime envelope"), so the UI showed
 * no response, no error, and no warning. Same failure mode previously hit
 * 'cursor' (see instance-manager-resolve-provider-cursor.spec.ts).
 *
 * resolveProviderName is a pure function (it only touches the module-level
 * logger), so we import and call it directly — no InstanceManager construction
 * or electron mocking required.
 */

import { describe, it, expect } from 'vitest';

import { resolveProviderName } from '../provider-runtime-helpers';

describe('resolveProviderName - antigravity', () => {
  it('returns antigravity when instanceProvider = antigravity (implicit)', () => {
    expect(resolveProviderName('test-instance-id', undefined, 'antigravity')).toBe('antigravity');
  });

  it('returns antigravity when explicitProvider = antigravity', () => {
    expect(resolveProviderName('test-instance-id', 'antigravity', undefined)).toBe('antigravity');
  });
});
