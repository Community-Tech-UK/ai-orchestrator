import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeResumeConfigFingerprint } from './session-recovery';

/**
 * The fingerprint is stamped on a persisted resume cursor and compared against
 * the live config before a native resume. Adding a field to it is therefore a
 * BACKWARDS-COMPATIBILITY event: if every existing cursor stops matching, native
 * resume is blocked app-wide on the first launch after the change.
 */
describe('computeResumeConfigFingerprint — backwards compatibility', () => {
  /** The exact string the pre-Copilot-routing implementation hashed. */
  function legacyFingerprint(provider: string, model: string, cwd: string, mcp = ''): string {
    return createHash('sha256')
      .update(`${provider}\0${model}\0${cwd}\0${mcp}`)
      .digest('hex')
      .slice(0, 16);
  }

  it('is byte-identical to the previous implementation for a non-Copilot session', () => {
    expect(
      computeResumeConfigFingerprint({
        provider: 'claude',
        model: 'opus',
        cwd: '/workspace',
      }),
    ).toBe(legacyFingerprint('claude', 'opus', '/workspace'));
  });

  it('is unchanged when copilotProfileId is explicitly empty or whitespace', () => {
    const expected = legacyFingerprint('codex', 'gpt-5.6', '/w');
    expect(
      computeResumeConfigFingerprint({
        provider: 'codex',
        model: 'gpt-5.6',
        cwd: '/w',
        copilotProfileId: '',
      }),
    ).toBe(expected);
    expect(
      computeResumeConfigFingerprint({
        provider: 'codex',
        model: 'gpt-5.6',
        cwd: '/w',
        copilotProfileId: '   ',
      }),
    ).toBe(expected);
  });

  it('still returns undefined when there is nothing to fingerprint', () => {
    expect(computeResumeConfigFingerprint({})).toBeUndefined();
    expect(computeResumeConfigFingerprint({ copilotProfileId: '' })).toBeUndefined();
  });
});

describe('computeResumeConfigFingerprint — cross-account resume guard', () => {
  const base = { provider: 'copilot', model: 'auto', cwd: '/workspace' } as const;

  it('changes when the Copilot account profile changes', () => {
    const personal = computeResumeConfigFingerprint({ ...base, copilotProfileId: 'personal' });
    const enterprise = computeResumeConfigFingerprint({ ...base, copilotProfileId: 'enterprise' });
    expect(personal).toBeDefined();
    expect(personal).not.toBe(enterprise);
  });

  it('differs from the same session with no profile at all', () => {
    expect(computeResumeConfigFingerprint({ ...base, copilotProfileId: 'personal' })).not.toBe(
      computeResumeConfigFingerprint(base),
    );
  });

  it('fingerprints a profile-only input', () => {
    expect(computeResumeConfigFingerprint({ copilotProfileId: 'personal' })).toBeDefined();
  });

  it('uses NUL separators so a value containing a space cannot collide', () => {
    // `provider='a b'` must not hash the same as `provider='a', model='b'`.
    expect(computeResumeConfigFingerprint({ provider: 'a b' })).not.toBe(
      computeResumeConfigFingerprint({ provider: 'a', model: 'b' }),
    );
    expect(
      computeResumeConfigFingerprint({ provider: 'p', copilotProfileId: 'x' }),
    ).not.toBe(computeResumeConfigFingerprint({ provider: 'p', mcpFingerprint: 'x' }));
  });
});
