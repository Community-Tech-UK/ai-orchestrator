import { describe, expect, it } from 'vitest';
import {
  ProviderAccountCreatePayloadSchema,
  ProviderAccountPoolsSchema,
  ProviderAccountProfileSchema,
  ProviderAccountProfilesSchema,
  ProviderAccountLaunchLoginPayloadSchema,
  ProviderAccountRefPayloadSchema,
  ProviderAccountUpdatePayloadSchema,
} from '../provider-account.schemas';

const legacyClaude = {
  id: 'legacy',
  provider: 'claude',
  label: 'Existing Claude account',
  expectedIdentity: null,
  expectedAccountKey: null,
  planLabel: null,
  priority: 0,
  enabled: true,
  automationPolicy: 'allow-routed',
  isLegacy: true,
  createdAt: 1,
  updatedAt: 1,
} as const;

const policy = {
  failoverMode: 'ask',
  continuation: 'shared-store',
  preemptive: { newSessions: true, liveSessionsAtTurnBoundary: false, thresholdPct: 90 },
  switchCooldownMs: 300_000,
  maxSwitchesPerTurn: 3,
  acknowledgedOwnershipAt: null,
} as const;

describe('ProviderAccountProfileSchema', () => {
  it('accepts a valid profile and rejects unknown fields', () => {
    expect(ProviderAccountProfileSchema.safeParse(legacyClaude).success).toBe(true);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, home: '/tmp/x' }).success).toBe(false);
  });

  it('binds legacy to the id', () => {
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, isLegacy: false }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, id: 'max-a' }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, id: 'max-a', isLegacy: false }).success).toBe(true);
  });

  it('rejects unsafe ids', () => {
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, id: '../x', isLegacy: false }).success).toBe(false);
  });

  it('requires region on OpenCode/MiMo profiles and forbids it elsewhere', () => {
    const legacyOpenCode = {
      ...legacyClaude,
      provider: 'opencode',
      label: 'Existing MiMo account (ams)',
      region: 'ams',
    } as const;
    expect(ProviderAccountProfileSchema.safeParse(legacyOpenCode).success).toBe(true);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyOpenCode, region: 'moon' }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyOpenCode, region: undefined }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, region: 'ams' }).success).toBe(false);
    const derived = {
      ...legacyOpenCode,
      id: 'max-b-1a2b',
      isLegacy: false,
      chromeProfile: 'Profile 1',
    } as const;
    expect(ProviderAccountProfileSchema.safeParse(derived).success).toBe(true);
    expect(ProviderAccountProfileSchema.safeParse({ ...derived, chromeProfile: '../evil' }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...derived, chromeProfile: 'C:\\Users\\x' }).success).toBe(false);
    expect(ProviderAccountProfileSchema.safeParse({ ...legacyClaude, id: 'max-a-1a2b', isLegacy: false, chromeProfile: 'Default' }).success).toBe(false);
  });
});

describe('ProviderAccountProfilesSchema', () => {
  it('allows the same id under different providers', () => {
    const result = ProviderAccountProfilesSchema.safeParse([
      legacyClaude,
      { ...legacyClaude, provider: 'codex', label: 'Existing Codex account' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects duplicate ids and duplicate priorities within a provider', () => {
    expect(ProviderAccountProfilesSchema.safeParse([legacyClaude, legacyClaude]).success).toBe(false);
    expect(ProviderAccountProfilesSchema.safeParse([
      legacyClaude,
      { ...legacyClaude, id: 'max-a', isLegacy: false },
    ]).success).toBe(false);
  });

  it('caps profiles per provider', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...legacyClaude,
      id: index === 0 ? 'legacy' : `max-${index}`,
      isLegacy: index === 0,
      priority: index,
    }));
    expect(ProviderAccountProfilesSchema.safeParse(many).success).toBe(false);
    expect(ProviderAccountProfilesSchema.safeParse(many.slice(0, 8)).success).toBe(true);
  });
});

describe('ProviderAccountPoolsSchema', () => {
  it('requires every pooled provider and a bounded threshold', () => {
    expect(ProviderAccountPoolsSchema.safeParse({ claude: policy, codex: policy, opencode: policy }).success).toBe(true);
    expect(ProviderAccountPoolsSchema.safeParse({ claude: policy, codex: policy }).success).toBe(false);
    expect(ProviderAccountPoolsSchema.safeParse({
      claude: { ...policy, preemptive: { ...policy.preemptive, thresholdPct: 0 } },
      codex: policy,
      opencode: policy,
    }).success).toBe(false);
  });
});

describe('IPC payloads', () => {
  it('accept the preload auth token and reject paths or unknown fields', () => {
    expect(ProviderAccountCreatePayloadSchema.safeParse({ ipcAuthToken: 't', provider: 'claude', label: 'Max A' }).success).toBe(true);
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'claude', label: 'Max A', home: '/x' }).success).toBe(false);
    expect(ProviderAccountRefPayloadSchema.safeParse({ ipcAuthToken: 't', provider: 'codex', profileId: 'max-a' }).success).toBe(true);
    expect(ProviderAccountRefPayloadSchema.safeParse({ provider: 'copilot', profileId: 'max-a' }).success).toBe(false);
    expect(ProviderAccountLaunchLoginPayloadSchema.safeParse({ ipcAuthToken: 't', provider: 'claude', profileId: 'max-a' }).success).toBe(true);
    expect(ProviderAccountLaunchLoginPayloadSchema.safeParse({ provider: 'claude', profileId: 'max-a', openTerminal: true }).success).toBe(true);
    expect(ProviderAccountLaunchLoginPayloadSchema.safeParse({ provider: 'claude', profileId: 'max-a', command: 'x' }).success).toBe(false);
  });

  it('require at least one field on update', () => {
    expect(ProviderAccountUpdatePayloadSchema.safeParse({ provider: 'claude', profileId: 'max-a' }).success).toBe(false);
    expect(ProviderAccountUpdatePayloadSchema.safeParse({ provider: 'claude', profileId: 'max-a', enabled: true }).success).toBe(true);
    expect(ProviderAccountUpdatePayloadSchema.safeParse({ provider: 'opencode', profileId: 'max-b', chromeProfile: 'Profile 2' }).success).toBe(true);
    expect(ProviderAccountUpdatePayloadSchema.safeParse({ provider: 'claude', profileId: 'max-a', chromeProfile: 'Profile 2' }).success).toBe(false);
    // `null` removes the explicit MiMo Chrome profile association.
    expect(ProviderAccountUpdatePayloadSchema.safeParse({ provider: 'opencode', profileId: 'max-b', chromeProfile: null }).success).toBe(true);
  });

  it('require region exactly for OpenCode/MiMo creates', () => {
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'opencode', label: 'MiMo B', region: 'sgp' }).success).toBe(true);
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'opencode', label: 'MiMo B' }).success).toBe(false);
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'claude', label: 'Max A', region: 'ams' }).success).toBe(false);
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'opencode', label: 'MiMo B', region: 'cn', chromeProfile: 'Default' }).success).toBe(true);
    expect(ProviderAccountCreatePayloadSchema.safeParse({ provider: 'opencode', label: 'MiMo B', region: 'cn', chromeProfile: '../x' }).success).toBe(false);
  });
});
