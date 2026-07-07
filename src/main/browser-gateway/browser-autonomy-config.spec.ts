import { describe, expect, it, vi } from 'vitest';
import {
  BrowserAutonomyConfigSchema,
  applyBrowserAutonomyConfig,
  reestablishExpiredStandingCampaigns,
  type ApplyAutonomyConfigDeps,
} from './browser-autonomy-config';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const T0 = Date.parse('2026-07-08T09:00:00Z');

function makeDeps(overrides: {
  existingProfileIds?: string[];
  existingAuthorizations?: Array<{ id: string; profileId: string; revokedAt?: number; expiresAt: number }>;
  existingCampaigns?: Array<{ label: string; status: string }>;
} = {}) {
  const createdProfiles: Array<{ id: string }> = [];
  const createdAuths: Array<{ input: unknown; id: string }> = [];
  const createdCampaigns: Array<{ label: string }> = [];
  const profileIds = new Set(overrides.existingProfileIds ?? []);
  const auths = overrides.existingAuthorizations ?? [];
  const campaigns = overrides.existingCampaigns ?? [];

  const deps: ApplyAutonomyConfigDeps = {
    now: () => T0,
    profileStore: {
      getProfile: (id: string) => (profileIds.has(id) ? ({ id } as never) : null),
      createProfile: (input) => {
        createdProfiles.push({ id: (input as { id: string }).id });
        return input as never;
      },
    },
    resolveProfileDir: (id: string) => `/managed/${id}`,
    authorizations: {
      list: (profileId?: string) =>
        auths.filter((a) => !profileId || a.profileId === profileId) as never,
      create: (input, id) => {
        createdAuths.push({ input, id });
        return { ...input, id } as never;
      },
    },
    campaigns: {
      list: () => campaigns as never,
      create: (input) => {
        createdCampaigns.push({ label: input.label });
        return input as never;
      },
    },
  };
  return { deps, createdProfiles, createdAuths, createdCampaigns };
}

const FULL_CONFIG = BrowserAutonomyConfigSchema.parse({
  masterPasswordFile: '/creds/bw.txt',
  profiles: [
    {
      id: 'aio-procurement',
      label: 'AIO Procurement',
      allowedOrigins: [{ scheme: 'https', hostPattern: '*.in-tendhost.co.uk', includeSubdomains: true }],
    },
  ],
  credentialAuthorizations: [
    {
      profileId: 'aio-procurement',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'in-tendhost.co.uk', includeSubdomains: true }],
      purposes: ['login', 'register', 'email_code'],
      vaultFolder: 'AIO-Agent',
      expiresInDays: 90,
    },
  ],
  campaigns: [
    {
      label: 'Overnight registrations',
      profileId: 'aio-procurement',
      allowedOrigins: ['https://in-tendhost.co.uk'],
      allowedActionClasses: ['navigate', 'input', 'submit'],
      budget: { maxActions: 500, maxSubmits: 20, maxNewAccounts: 3, maxUploads: 20, maxDurationHours: 12 },
    },
  ],
});

describe('BrowserAutonomyConfigSchema', () => {
  it('applies defaults (mode, browser, includeSubdomains, vaultFolder, expiry)', () => {
    const parsed = BrowserAutonomyConfigSchema.parse({
      profiles: [
        { id: 'p', label: 'P', allowedOrigins: [{ scheme: 'https', hostPattern: 'x.com' }] },
      ],
      credentialAuthorizations: [
        {
          profileId: 'p',
          allowedOrigins: [{ scheme: 'https', hostPattern: 'x.com' }],
          purposes: ['login'],
        },
      ],
    });
    expect(parsed.profiles[0]).toMatchObject({ mode: 'isolated', browser: 'chrome' });
    expect(parsed.credentialAuthorizations[0]).toMatchObject({ vaultFolder: 'AIO-Agent', expiresInDays: 90 });
  });

  it('rejects unknown top-level keys', () => {
    expect(() => BrowserAutonomyConfigSchema.parse({ bogus: true })).toThrow();
  });
});

describe('applyBrowserAutonomyConfig', () => {
  it('provisions profiles, authorizations, and campaigns from scratch', () => {
    const { deps, createdProfiles, createdAuths, createdCampaigns } = makeDeps();

    const result = applyBrowserAutonomyConfig(FULL_CONFIG, deps);

    expect(result).toEqual({ profilesCreated: 1, authorizationsCreated: 1, campaignsCreated: 1 });
    expect(createdProfiles[0]).toEqual({ id: 'aio-procurement' });
    // Authorization gets a stable content-derived id and a computed expiry.
    expect(createdAuths[0]!.id).toMatch(/^authcfg-[a-f0-9]{32}$/);
    expect((createdAuths[0]!.input as { expiresAt: number }).expiresAt).toBe(T0 + 90 * 86_400_000);
    // Campaign duration converted hours -> ms.
    expect(createdCampaigns[0]).toEqual({ label: 'Overnight registrations' });
  });

  it('is idempotent: skips existing profiles, live authorizations, and active campaigns', () => {
    // First run to learn the stable authorization id.
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const authId = probe.createdAuths[0]!.id;

    const { deps, createdProfiles, createdAuths, createdCampaigns } = makeDeps({
      existingProfileIds: ['aio-procurement'],
      existingAuthorizations: [
        { id: authId, profileId: 'aio-procurement', expiresAt: T0 + 1_000_000 },
      ],
      existingCampaigns: [{ label: 'Overnight registrations', status: 'active' }],
    });

    const result = applyBrowserAutonomyConfig(FULL_CONFIG, deps);

    expect(result).toEqual({ profilesCreated: 0, authorizationsCreated: 0, campaignsCreated: 0 });
    expect(createdProfiles).toHaveLength(0);
    expect(createdAuths).toHaveLength(0);
    expect(createdCampaigns).toHaveLength(0);
  });

  it('re-creates an authorization whose prior copy is expired or revoked', () => {
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const authId = probe.createdAuths[0]!.id;

    const expired = makeDeps({
      existingProfileIds: ['aio-procurement'],
      existingAuthorizations: [
        { id: authId, profileId: 'aio-procurement', expiresAt: T0 - 1 }, // expired
      ],
      existingCampaigns: [{ label: 'Overnight registrations', status: 'active' }],
    });
    expect(applyBrowserAutonomyConfig(FULL_CONFIG, expired.deps).authorizationsCreated).toBe(1);

    const revoked = makeDeps({
      existingProfileIds: ['aio-procurement'],
      existingAuthorizations: [
        { id: authId, profileId: 'aio-procurement', revokedAt: T0 - 10, expiresAt: T0 + 1_000_000 },
      ],
      existingCampaigns: [{ label: 'Overnight registrations', status: 'active' }],
    });
    expect(applyBrowserAutonomyConfig(FULL_CONFIG, revoked.deps).authorizationsCreated).toBe(1);
  });

  it('creates a fresh campaign when the prior one has ended (killed/expired/completed)', () => {
    const { deps, createdCampaigns } = makeDeps({
      existingProfileIds: ['aio-procurement'],
      existingCampaigns: [{ label: 'Overnight registrations', status: 'expired' }],
    });

    applyBrowserAutonomyConfig(FULL_CONFIG, deps);

    expect(createdCampaigns).toHaveLength(1);
  });
});

describe('reestablishExpiredStandingCampaigns', () => {
  it('rolls a fresh campaign once the prior window has expired', () => {
    const { deps, createdCampaigns } = makeDeps({
      existingCampaigns: [{ label: 'Overnight registrations', status: 'expired' }],
    });

    expect(reestablishExpiredStandingCampaigns(deps, FULL_CONFIG)).toBe(1);
    expect(createdCampaigns).toEqual([{ label: 'Overnight registrations' }]);
  });

  it('leaves an active or paused standing campaign untouched', () => {
    for (const status of ['active', 'paused']) {
      const { deps, createdCampaigns } = makeDeps({
        existingCampaigns: [{ label: 'Overnight registrations', status }],
      });
      expect(reestablishExpiredStandingCampaigns(deps, FULL_CONFIG)).toBe(0);
      expect(createdCampaigns).toHaveLength(0);
    }
  });

  it('never resurrects a killed campaign (respects the kill switch)', () => {
    const { deps, createdCampaigns } = makeDeps({
      // Both a killed and an expired copy present: killed must win and block.
      existingCampaigns: [
        { label: 'Overnight registrations', status: 'expired' },
        { label: 'Overnight registrations', status: 'killed' },
      ],
    });
    expect(reestablishExpiredStandingCampaigns(deps, FULL_CONFIG)).toBe(0);
    expect(createdCampaigns).toHaveLength(0);
  });

  it('does not create anything before the boot-time apply has ever provisioned it', () => {
    const { deps, createdCampaigns } = makeDeps({ existingCampaigns: [] });
    expect(reestablishExpiredStandingCampaigns(deps, FULL_CONFIG)).toBe(0);
    expect(createdCampaigns).toHaveLength(0);
  });
});
