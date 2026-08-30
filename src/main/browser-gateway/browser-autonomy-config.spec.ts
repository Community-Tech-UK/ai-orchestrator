import { describe, expect, it, vi } from 'vitest';
import {
  BrowserAutonomyConfigSchema,
  applyBrowserAutonomyConfig,
  reestablishExpiredStandingCampaigns,
  type ApplyAutonomyConfigDeps,
} from './browser-autonomy-config';
import { BrowserCampaignService } from './browser-campaign-store';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const NODE_ID = 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be';
vi.mock('../remote-node/remote-node-roster-service', () => ({
  getRemoteNodeRosterService: () => ({ list: () => [{ id: NODE_ID, name: 'windows-pc' }] }),
}));
vi.mock('./browser-profile-store', () => ({
  getBrowserProfileStore: () => ({ listProfiles: () => [{ id: 'aio-procurement' }] }),
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
      // Mirrors the real store: `get` sees every row, including revoked and
      // expired ones. The old double could not reproduce the failures it was
      // written to pin, because it hid nothing and never conflicted on id.
      find: (id: string) => auths.find((a) => a.id === id) as never,
      // Mirrors INSERT ... ON CONFLICT(id) DO UPDATE: replaces any prior row.
      recreate: (input, id) => {
        const row = {
          id,
          profileId: (input as { profileId: string }).profileId,
          expiresAt: (input as { expiresAt: number }).expiresAt,
        };
        const index = auths.findIndex((a) => a.id === id);
        if (index >= 0) auths[index] = row; else auths.push(row);
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

  it('re-creates an authorization whose prior copy has EXPIRED', () => {
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
  });

  it('does NOT re-create one the operator revoked', () => {
    // BEHAVIOUR CHANGE, 2026-08-30. This test used to assert that a revoked
    // grant is re-minted, on the reading that the config file is the source of
    // truth. That reading loses to a simpler one: a revoke is also an operator
    // action, and it is the more recent one. Under the old behaviour, revoking a
    // live grant during an incident and then restarting the app silently
    // restored it with a fresh full-length expiry, with nothing to signal it.
    // Removing the entry from the config is how an operator retires it for good.
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const authId = probe.createdAuths[0]!.id;

    const revoked = makeDeps({
      existingProfileIds: ['aio-procurement'],
      existingAuthorizations: [
        { id: authId, profileId: 'aio-procurement', revokedAt: T0 - 10, expiresAt: T0 + 1_000_000 },
      ],
      existingCampaigns: [{ label: 'Overnight registrations', status: 'active' }],
    });
    expect(applyBrowserAutonomyConfig(FULL_CONFIG, revoked.deps).authorizationsCreated).toBe(0);
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

  it('rolls an elapsed active campaign without requiring canProceed first', () => {
    let now = T0;
    let nextId = 0;
    const campaigns = new BrowserCampaignService({
      now: () => now,
      idFactory: () => `campaign-${++nextId}`,
    });
    const deps: ApplyAutonomyConfigDeps = { ...makeDeps().deps, campaigns };
    applyBrowserAutonomyConfig(FULL_CONFIG, deps);
    now += 12 * 60 * 60 * 1000 + 1;

    expect(reestablishExpiredStandingCampaigns(deps, FULL_CONFIG)).toBe(1);
    expect(campaigns.list({ status: 'expired' })).toHaveLength(1);
    expect(campaigns.list({ status: 'active' })).toHaveLength(1);
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

describe('applyBrowserAutonomyConfig scope resolution is idempotent across boots', () => {
  // The bug this pins: the existence check looked the grant up by the RAW config
  // value while creation stored the RESOLVED one. With a friendly node name the
  // two differ, so boot 2 never found what boot 1 wrote, re-inserted the same
  // primary key and threw. That throw escapes to the caller, so every later
  // authorization and every campaign stopped provisioning on every boot after
  // the first, and the grant's expiry could never be refreshed.
  const configWithNodeName = {
    ...FULL_CONFIG,
    credentialAuthorizations: [
      { ...FULL_CONFIG.credentialAuthorizations[0]!, profileId: 'windows-pc' },
    ],
  };

  it('stores the resolved node id, not the friendly name', () => {
    const probe = makeDeps();
    applyBrowserAutonomyConfig(configWithNodeName, probe.deps);
    expect(probe.createdAuths).toHaveLength(1);
    expect(probe.createdAuths[0]!.input).toMatchObject({ profileId: NODE_ID });
  });

  it('does not re-create the grant on the next boot', () => {
    const first = makeDeps();
    applyBrowserAutonomyConfig(configWithNodeName, first.deps);
    const created = first.createdAuths[0]!;

    // Boot 2: the store now holds the row boot 1 wrote, under the resolved id.
    const second = makeDeps({
      existingAuthorizations: [
        { id: created.id, profileId: NODE_ID, expiresAt: T0 + 90 * 24 * 60 * 60 * 1000 },
      ],
    });
    const result = applyBrowserAutonomyConfig(configWithNodeName, second.deps);

    expect(second.createdAuths).toHaveLength(0);
    expect(result.authorizationsCreated).toBe(0);
    // The rest of the run must still complete rather than abort.
    expect(result.campaignsCreated).toBe(FULL_CONFIG.campaigns.length);
  });

  it('still resolves a managed profile id unchanged', () => {
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    expect(probe.createdAuths[0]!.input).toMatchObject({ profileId: 'aio-procurement' });
  });
});

describe('applyBrowserAutonomyConfig survives a stale row under the same id', () => {
  // The id is a content hash, so it never changes; the store hides revoked rows
  // and the predicate hid expired ones, so the row was invisible and the bare
  // INSERT hit the primary key. That throw abandoned every remaining
  // authorization AND every campaign on every boot thereafter.
  function idOfFullConfigAuth(): string {
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    return probe.createdAuths[0]!.id;
  }

  it('re-creates rather than throwing when the prior copy has expired', () => {
    const id = idOfFullConfigAuth();
    const expired = makeDeps({
      existingAuthorizations: [{ id, profileId: 'aio-procurement', expiresAt: T0 - 1 }],
    });

    const result = applyBrowserAutonomyConfig(FULL_CONFIG, expired.deps);

    expect(result.authorizationsCreated).toBe(1);
    expect(expired.createdAuths[0]!.input).toMatchObject({
      expiresAt: T0 + 90 * 24 * 60 * 60 * 1000,
    });
    // The rest of the run must still complete.
    expect(result.campaignsCreated).toBe(FULL_CONFIG.campaigns.length);
  });

  it('completes the whole run on a second boot with a live grant', () => {
    const id = idOfFullConfigAuth();
    const second = makeDeps({
      existingAuthorizations: [
        { id, profileId: 'aio-procurement', expiresAt: T0 + 90 * 24 * 60 * 60 * 1000 },
      ],
    });

    const result = applyBrowserAutonomyConfig(FULL_CONFIG, second.deps);

    expect(result.authorizationsCreated).toBe(0);
    expect(second.createdAuths).toHaveLength(0);
    expect(result.campaignsCreated).toBe(FULL_CONFIG.campaigns.length);
  });
});

describe('applyBrowserAutonomyConfig respects a revocation', () => {
  it('does not resurrect a grant the operator revoked', () => {
    // `recreate` clears revokedAt, so re-minting here would silently undo a
    // revocation on the next ordinary restart, with a fresh full-length expiry
    // and nothing to signal it. An earlier fix traded a loud crash for exactly
    // that, which is worse.
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const id = probe.createdAuths[0]!.id;

    const revoked = makeDeps({
      existingAuthorizations: [
        { id, profileId: 'aio-procurement', revokedAt: T0 - 1, expiresAt: T0 + 1_000_000 },
      ],
    });
    const result = applyBrowserAutonomyConfig(FULL_CONFIG, revoked.deps);

    expect(result.authorizationsCreated).toBe(0);
    expect(revoked.createdAuths).toHaveLength(0);
    // The rest of the run must still complete.
    expect(result.campaignsCreated).toBe(FULL_CONFIG.campaigns.length);
  });

  it('skips an entry whose scope cannot be resolved rather than writing a dead grant', () => {
    // The lenient resolver returned the raw name on failure, so provisioning
    // upserted a grant the fill can never look up and reported it as created.
    const unresolvable = {
      ...FULL_CONFIG,
      credentialAuthorizations: [
        { ...FULL_CONFIG.credentialAuthorizations[0]!, profileId: 'no-such-scope' },
      ],
    };
    const probe = makeDeps();

    const result = applyBrowserAutonomyConfig(unresolvable, probe.deps);

    expect(result.authorizationsCreated).toBe(0);
    expect(probe.createdAuths).toHaveLength(0);
    expect(result.campaignsCreated).toBe(FULL_CONFIG.campaigns.length);
  });
});

describe('applyBrowserAutonomyConfig repairs a grant stored under a stale scope', () => {
  it('re-mints a live row whose stored scope the fill can never look up', () => {
    // The older lenient resolver stored the raw node name on a roster read
    // failure. Such a row is live for its full lifetime but dead to the fill,
    // and the id-only lookup skipped it in silence on every boot.
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const id = probe.createdAuths[0]!.id;

    const stale = makeDeps({
      existingAuthorizations: [
        { id, profileId: 'windows-pc', expiresAt: T0 + 1_000_000 }, // raw name, not the id
      ],
    });
    const result = applyBrowserAutonomyConfig(FULL_CONFIG, stale.deps);

    expect(result.authorizationsCreated).toBe(1);
    expect(stale.createdAuths[0]!.input).toMatchObject({ profileId: 'aio-procurement' });
  });

  it('leaves a live row alone when the scope already matches', () => {
    const probe = makeDeps();
    applyBrowserAutonomyConfig(FULL_CONFIG, probe.deps);
    const id = probe.createdAuths[0]!.id;

    const matching = makeDeps({
      existingAuthorizations: [
        { id, profileId: 'aio-procurement', expiresAt: T0 + 1_000_000 },
      ],
    });

    expect(applyBrowserAutonomyConfig(FULL_CONFIG, matching.deps).authorizationsCreated).toBe(0);
  });
});
