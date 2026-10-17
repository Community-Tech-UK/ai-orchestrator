import { expect, it } from 'vitest';
import { normalizeRecoveryNodePlacement } from './session-recovery-node-placement';
it('clones nested account preferences and version constraints without changing the saved choice', () => {
  const input = { requiresOpenCodeMajor: 2 as const, preferNodeId: 'preference-worker', prefersAccountProfile: { provider: 'opencode' as const, profileId: 'account-b' } };
  const parsed = normalizeRecoveryNodePlacement(input)!;
  expect(parsed).toEqual(input); expect(parsed).not.toBe(input); expect(parsed.prefersAccountProfile).not.toBe(input.prefersAccountProfile);
  expect(normalizeRecoveryNodePlacement(undefined)).toBeUndefined();
});
it.each([null, [], { requiresOpenCodeMajor: 3 }, { requiresOpenCodeMajor: '2' }, { requiresCli: 'other' }])('refuses corrupt placement rather than losing a required major: %j', (value) => {
  expect(() => normalizeRecoveryNodePlacement(value)).toThrow('Invalid recovery node placement');
});
