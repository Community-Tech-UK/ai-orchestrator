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
  it('requires both providers and a bounded threshold', () => {
    expect(ProviderAccountPoolsSchema.safeParse({ claude: policy, codex: policy }).success).toBe(true);
    expect(ProviderAccountPoolsSchema.safeParse({ claude: policy }).success).toBe(false);
    expect(ProviderAccountPoolsSchema.safeParse({
      claude: { ...policy, preemptive: { ...policy.preemptive, thresholdPct: 0 } },
      codex: policy,
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
  });
});
