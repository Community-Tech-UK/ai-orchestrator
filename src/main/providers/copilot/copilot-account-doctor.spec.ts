import { describe, expect, it } from 'vitest';
import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
} from '../../../shared/types/copilot-account.types';
import {
  buildCopilotAccountDoctorReport,
  detectAmbientCopilotTokenVariables,
  summarizeCopilotAccountReport,
} from './copilot-account-doctor';

function profile(
  id: string,
  overrides: Partial<CopilotAccountProfile> = {},
): CopilotAccountProfile {
  return {
    id,
    label: id,
    expectedLogin: id,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function report(options: {
  profiles?: CopilotAccountProfile[];
  rules?: CopilotAccountRoutingRule[];
  states?: Record<string, CopilotAccountBindingStatus['state']>;
  plaintext?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  return buildCopilotAccountDoctorReport({
    readSettings: () => ({
      profiles: options.profiles ?? [],
      rules: options.rules ?? [],
    }),
    checkBinding: async (target, nodeId) => ({
      profileId: target.id,
      nodeId,
      state: options.states?.[target.id] ?? 'authenticated',
      checkedAt: 1,
      ...(options.plaintext?.includes(target.id) ? { storesTokenPlaintext: true } : {}),
    }),
    env: options.env ?? {},
  });
}

describe('aggregate authentication status', () => {
  it('is not-configured with no profiles, and says the single account is still in use', async () => {
    const result = await report({});
    expect(result.aggregate).toBe('not-configured');
    expect(result.legacyMigrationInUse).toBe(true);
    expect(summarizeCopilotAccountReport(result)).toContain('existing single Copilot account');
  });

  it('is available when every profile is signed in', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
    });
    expect(result.aggregate).toBe('available');
  });

  it('is partially-configured when some profiles are healthy and others are not', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
      states: { enterprise: 'unauthenticated' },
    });
    expect(result.aggregate).toBe('partially-configured');
    // The unhealthy account is named — "some account works" must not read as
    // "the account you need works".
    expect(summarizeCopilotAccountReport(result)).toContain('enterprise');
  });

  it('is auth-required when no profile is healthy', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      states: { personal: 'unauthenticated' },
    });
    expect(result.aggregate).toBe('auth-required');
  });
});

describe('per-profile reporting', () => {
  it('reports identity, policy, and binding without any secret', async () => {
    const result = await report({
      profiles: [
        profile('enterprise', {
          label: 'Enterprise',
          accountKind: 'enterprise',
          scopePolicy: 'matched-only',
          automationPolicy: 'manual-only',
          host: 'ghe.example.com',
        }),
      ],
    });
    expect(result.profiles[0]).toMatchObject({
      profileId: 'enterprise',
      label: 'Enterprise',
      expectedLogin: 'enterprise',
      host: 'ghe.example.com',
      accountKind: 'enterprise',
      scopePolicy: 'matched-only',
      automationPolicy: 'manual-only',
      bindingState: 'authenticated',
    });
    // No filesystem path anywhere in the report.
    expect(JSON.stringify(result)).not.toMatch(/\/(Users|home|var)\//);
  });

  it('warns about a profile that stores its token in plaintext', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      plaintext: ['personal'],
    });
    expect(result.profiles[0].storesTokenPlaintext).toBe(true);
    expect(result.warnings.join(' ')).toContain('plaintext');
  });

  it('warns about an identity mismatch', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      states: { personal: 'identity-mismatch' },
    });
    expect(result.warnings.join(' ')).toContain('different GitHub identity');
  });
});

describe('rule and default diagnostics', () => {
  const rule = (
    id: string,
    profileId: string,
    owner = 'acme',
  ): CopilotAccountRoutingRule => ({
    id,
    profileId,
    matcher: { type: 'owner', host: 'github.com', owner },
    isProtected: false,
    createdAt: 1,
    updatedAt: 1,
  });

  it('reports rules pointing at a deleted profile', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      rules: [rule('r1', 'deleted')],
    });
    expect(result.unreachableRuleIds).toEqual(['r1']);
    expect(result.warnings.join(' ')).toContain('no longer exists');
  });

  it('reports two rules mapping the same target to different accounts', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
      rules: [rule('r1', 'personal'), rule('r2', 'enterprise')],
    });
    expect(result.conflictingRuleIds.sort()).toEqual(['r1', 'r2']);
    expect(result.warnings.join(' ')).toContain('ambiguous');
  });

  it('detects a conflict when one rule stores its host with a scheme', async () => {
    // The Doctor's duplicate key embeds the host. A legacy record carrying
    // `https://github.com` keyed differently from an equivalent new rule, so
    // two rules mapping the SAME target to DIFFERENT accounts were reported as
    // healthy — the one thing this check exists to catch.
    const schemeRule: CopilotAccountRoutingRule = {
      ...rule('r1', 'personal'),
      matcher: { type: 'owner', host: 'https://github.com', owner: 'acme' },
    } as CopilotAccountRoutingRule;
    const result = await report({
      profiles: [profile('personal', { isDefault: true }), profile('enterprise')],
      rules: [schemeRule, rule('r2', 'enterprise')],
    });
    expect(result.conflictingRuleIds.sort()).toEqual(['r1', 'r2']);
  });

  it('does not flag two rules for the same profile as conflicting', async () => {
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      rules: [rule('r1', 'personal'), rule('r2', 'personal')],
    });
    expect(result.conflictingRuleIds).toEqual([]);
  });

  it('reports a missing default, a matched-only default, and a disabled default', async () => {
    expect((await report({ profiles: [profile('personal')] })).invalidDefaultReason).toContain(
      'No default',
    );
    expect(
      (
        await report({
          profiles: [profile('personal', { isDefault: true, scopePolicy: 'matched-only' })],
        })
      ).invalidDefaultReason,
    ).toContain('matched-only');
    expect(
      (
        await report({
          profiles: [profile('personal', { isDefault: true, automationPolicy: 'disabled' })],
        })
      ).invalidDefaultReason,
    ).toContain('disabled');
  });
});

describe('the one-line summary the generic Doctor page shows', () => {
  it('never reports all-clear while a warning is outstanding', async () => {
    // The dedicated Copilot Accounts tab lists every warning; the generic
    // Doctor page shows only this string. Without the warnings appended, a
    // plaintext-token or rule-conflict warning was invisible to anyone who
    // never opened the Copilot tab.
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      plaintext: ['personal'],
    });
    const summary = summarizeCopilotAccountReport(result);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(summary).toContain('warning(s)');
    for (const warning of result.warnings) {
      expect(summary).toContain(warning);
    }
  });

  it('stays clean when there is nothing to warn about', async () => {
    const result = await report({ profiles: [profile('personal', { isDefault: true })] });
    expect(result.warnings).toEqual([]);
    expect(summarizeCopilotAccountReport(result)).not.toContain('warning(s)');
  });
});

describe('ambient token variable detection', () => {
  it('reports present variables by NAME only, never by value', async () => {
    const secretShaped = 'gho_NOT_A_REAL_TOKEN_placeholder';
    const result = await report({
      profiles: [profile('personal', { isDefault: true })],
      env: { GITHUB_TOKEN: secretShaped, GH_TOKEN: secretShaped, PATH: '/usr/bin' },
    });
    expect(result.ambientTokenVariablesPresent.sort()).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
    expect(JSON.stringify(result)).not.toContain(secretShaped);
    expect(result.warnings.join(' ')).toContain('stripped from every Copilot session');
  });

  it('ignores variables that are absent or empty', () => {
    expect(detectAmbientCopilotTokenVariables({ GITHUB_TOKEN: '' })).toEqual([]);
    expect(detectAmbientCopilotTokenVariables({})).toEqual([]);
  });

  it('detects all six stripped variables', () => {
    expect(
      detectAmbientCopilotTokenVariables({
        COPILOT_GITHUB_TOKEN: 'x',
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        GITHUB_COPILOT_GITHUB_TOKEN: 'x',
        GITHUB_COPILOT_API_TOKEN: 'x',
        GITHUB_TOKEN_VARNAME: 'x',
      }),
    ).toHaveLength(6);
  });
});
