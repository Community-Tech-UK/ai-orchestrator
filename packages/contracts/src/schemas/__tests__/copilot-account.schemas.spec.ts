import { describe, expect, it } from 'vitest';
import {
  CopilotAccountProfileSchema,
  CopilotAccountProfilesSchema,
  CopilotAccountRoutingRuleSchema,
  CopilotAccountRoutingRulesSchema,
  CopilotHostSchema,
  CopilotProfileIdSchema,
  CopilotRoutingMatcherSchema,
  assertCopilotRoutingConsistency,
  copilotMatcherKey,
} from '../copilot-account.schemas';

const baseProfile = {
  id: 'personal',
  label: 'Personal',
  expectedLogin: 'octocat',
  host: 'github.com',
  accountKind: 'personal',
  scopePolicy: 'default-eligible',
  automationPolicy: 'allow-routed',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
} as const;

const baseRule = {
  id: 'rule-1',
  profileId: 'personal',
  matcher: { type: 'owner', host: 'github.com', owner: 'octocat' },
  isProtected: false,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe('CopilotProfileIdSchema', () => {
  it('accepts safe slugs', () => {
    for (const id of ['personal', 'enterprise-2', 'a', 'legacy']) {
      expect(CopilotProfileIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects IDs that could escape or rename a directory', () => {
    for (const id of [
      '..',
      '../escape',
      'has/slash',
      'has\\backslash',
      '/absolute',
      'Upper',
      '-leading-hyphen',
      'has space',
      'has.dot',
      'a'.repeat(64),
      '',
    ]) {
      expect(CopilotProfileIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe('CopilotHostSchema', () => {
  it('accepts exact lowercase hostnames', () => {
    expect(CopilotHostSchema.safeParse('github.com').success).toBe(true);
    expect(CopilotHostSchema.safeParse('github.enterprise.example').success).toBe(true);
  });

  it('rejects near-miss and non-exact host inputs', () => {
    for (const host of [
      'GitHub.com',
      'https://github.com',
      'github.com/owner',
      'github.com:443',
      'github.com.',
      'user@github.com',
      '-github.com',
      'github..com',
      '',
    ]) {
      expect(CopilotHostSchema.safeParse(host).success, host).toBe(false);
    }
  });

  it('accepts hosts that merely CONTAIN github.com as distinct values', () => {
    // These parse as valid hostnames — the point is they are not equal to
    // github.com, so exact matching in the resolver keeps them apart.
    expect(CopilotHostSchema.safeParse('github.com.evil.example').success).toBe(true);
    expect(CopilotHostSchema.safeParse('notgithub.com').success).toBe(true);
    expect('github.com.evil.example').not.toBe('github.com');
  });
});

describe('CopilotRoutingMatcherSchema', () => {
  it('rejects path traversal in a canonical path', () => {
    for (const canonicalPath of [
      '/Users/me/work/../../etc',
      'relative/path',
      '..',
      '/has\0null',
      '',
    ]) {
      const result = CopilotRoutingMatcherSchema.safeParse({ type: 'path-prefix', canonicalPath });
      expect(result.success, canonicalPath).toBe(false);
    }
  });

  it('accepts absolute POSIX and Windows paths', () => {
    expect(
      CopilotRoutingMatcherSchema.safeParse({ type: 'path-prefix', canonicalPath: '/Users/me/work' })
        .success,
    ).toBe(true);
    expect(
      CopilotRoutingMatcherSchema.safeParse({
        type: 'path-prefix',
        canonicalPath: 'C:\\Users\\me\\work',
      }).success,
    ).toBe(true);
  });

  it('requires both owner and repo on a repository matcher', () => {
    expect(
      CopilotRoutingMatcherSchema.safeParse({
        type: 'repository',
        host: 'github.com',
        owner: 'octocat',
      }).success,
    ).toBe(false);
    expect(
      CopilotRoutingMatcherSchema.safeParse({
        type: 'repository',
        host: 'github.com',
        owner: 'octocat',
        repo: 'hello-world',
      }).success,
    ).toBe(true);
  });

  it('builds distinct keys per matcher shape', () => {
    expect(copilotMatcherKey({ type: 'owner', host: 'github.com', owner: 'octocat' })).toBe(
      'owner:github.com/octocat',
    );
    expect(
      copilotMatcherKey({
        type: 'repository',
        host: 'github.com',
        owner: 'octocat',
        repo: 'hello-world',
      }),
    ).toBe('repository:github.com/octocat/hello-world');
    expect(copilotMatcherKey({ type: 'path-prefix', canonicalPath: '/w' })).toBe('path-prefix:/w');
  });
});

describe('CopilotAccountProfileSchema', () => {
  it('accepts a valid profile', () => {
    expect(CopilotAccountProfileSchema.safeParse(baseProfile).success).toBe(true);
  });

  it('accepts a not-yet-authenticated profile', () => {
    expect(
      CopilotAccountProfileSchema.safeParse({ ...baseProfile, expectedLogin: null }).success,
    ).toBe(true);
  });

  it('rejects unknown fields, so a token can never ride along', () => {
    const result = CopilotAccountProfileSchema.safeParse({
      ...baseProfile,
      oauthToken: 'placeholder-value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a filesystem path masquerading as an ID', () => {
    expect(
      CopilotAccountProfileSchema.safeParse({ ...baseProfile, id: '/etc/passwd' }).success,
    ).toBe(false);
  });
});

describe('CopilotAccountProfilesSchema', () => {
  it('rejects two default profiles', () => {
    const result = CopilotAccountProfilesSchema.safeParse([
      baseProfile,
      { ...baseProfile, id: 'second', label: 'Second' },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects a matched-only default', () => {
    const result = CopilotAccountProfilesSchema.safeParse([
      { ...baseProfile, scopePolicy: 'matched-only' },
    ]);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('default-eligible');
  });

  it('rejects duplicate profile IDs', () => {
    const result = CopilotAccountProfilesSchema.safeParse([
      baseProfile,
      { ...baseProfile, isDefault: false },
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts zero profiles and one default plus one matched-only', () => {
    expect(CopilotAccountProfilesSchema.safeParse([]).success).toBe(true);
    expect(
      CopilotAccountProfilesSchema.safeParse([
        baseProfile,
        {
          ...baseProfile,
          id: 'enterprise',
          label: 'Enterprise',
          accountKind: 'enterprise',
          scopePolicy: 'matched-only',
          isDefault: false,
          expectedLogin: null,
        },
      ]).success,
    ).toBe(true);
  });
});

describe('CopilotAccountRoutingRulesSchema', () => {
  it('accepts a valid rule set', () => {
    expect(CopilotAccountRoutingRulesSchema.safeParse([baseRule]).success).toBe(true);
  });

  it('rejects two rules with an identical matcher', () => {
    const result = CopilotAccountRoutingRulesSchema.safeParse([
      baseRule,
      { ...baseRule, id: 'rule-2', profileId: 'enterprise' },
    ]);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Duplicate routing matcher');
  });

  it('rejects duplicate rule IDs', () => {
    const result = CopilotAccountRoutingRulesSchema.safeParse([
      baseRule,
      { ...baseRule, matcher: { type: 'owner', host: 'github.com', owner: 'other' } },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields on a rule', () => {
    expect(
      CopilotAccountRoutingRuleSchema.safeParse({ ...baseRule, protected: true }).success,
    ).toBe(false);
  });
});

describe('assertCopilotRoutingConsistency', () => {
  it('rejects an orphan rule', () => {
    expect(() =>
      assertCopilotRoutingConsistency([baseProfile], [{ ...baseRule, profileId: 'missing' }]),
    ).toThrow(/unknown profile/);
  });

  it('accepts rules that reference existing profiles', () => {
    expect(() => assertCopilotRoutingConsistency([baseProfile], [baseRule])).not.toThrow();
  });
});
