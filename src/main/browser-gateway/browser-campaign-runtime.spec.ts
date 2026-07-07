import { describe, expect, it, vi } from 'vitest';
import type { BrowserPermissionGrant } from '@contracts/types/browser';
import {
  BrowserCampaignRuntime,
  CAMPAIGN_GRANT_REQUESTED_BY_PREFIX,
  CAMPAIGN_LEASE_MS,
  campaignIdFromGrant,
  campaignOriginToGrantOrigin,
} from './browser-campaign-runtime';
import {
  BrowserCampaignService,
  InMemoryBrowserCampaignStore,
} from './browser-campaign-store';
import type { BrowserGrantStore, BrowserGrantInput } from './browser-grant-store';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const T0 = Date.parse('2026-07-07T20:00:00Z');

class FakeGrantStore implements Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'revokeGrant'> {
  grants: BrowserPermissionGrant[] = [];
  private counter = 0;
  now = T0;

  createGrant(input: BrowserGrantInput): BrowserPermissionGrant {
    const grant: BrowserPermissionGrant = {
      ...input,
      id: `grant-${++this.counter}`,
      createdAt: this.now,
    };
    this.grants.unshift(grant); // newest first, like the SQL store
    return grant;
  }

  listGrants(filter: { profileId?: string; includeExpired?: boolean }): BrowserPermissionGrant[] {
    return this.grants.filter((grant) => {
      if (filter.profileId && grant.profileId !== filter.profileId) return false;
      if (!filter.includeExpired) {
        if (grant.decision !== 'allow') return false;
        if (grant.expiresAt <= this.now) return false;
        if (grant.revokedAt || grant.consumedAt) return false;
      }
      return true;
    });
  }

  revokeGrant(grantId: string, reason?: string): BrowserPermissionGrant | null {
    const grant = this.grants.find((candidate) => candidate.id === grantId);
    if (grant) {
      grant.revokedAt = this.now;
      if (reason) grant.reason = reason;
    }
    return grant ?? null;
  }
}

function makeRuntime(nowRef = { now: T0 }) {
  const store = new InMemoryBrowserCampaignStore();
  const campaigns = new BrowserCampaignService({ store, now: () => nowRef.now });
  const grantStore = new FakeGrantStore();
  const runtime = new BrowserCampaignRuntime({
    campaigns,
    grantStore,
    now: () => nowRef.now,
  });
  const campaign = campaigns.create({
    label: 'Overnight registrations',
    profileId: 'profile-1',
    allowedOrigins: ['https://in-tendhost.co.uk', '*.procontract.due-north.com'],
    allowedActionClasses: ['navigate', 'input', 'submit'],
    budget: {
      maxActions: 10,
      maxSubmits: 2,
      maxNewAccounts: 1,
      maxUploads: 1,
      maxDurationMs: 8 * 60 * 60 * 1000,
    },
  });
  return { runtime, campaigns, grantStore, campaign, nowRef };
}

describe('campaignOriginToGrantOrigin', () => {
  it('parses full origins, bare hosts, and wildcard hosts', () => {
    expect(campaignOriginToGrantOrigin('https://portal.example.gov.uk')).toEqual({
      scheme: 'https',
      hostPattern: 'portal.example.gov.uk',
      includeSubdomains: false,
    });
    expect(campaignOriginToGrantOrigin('example.com')).toMatchObject({
      scheme: 'https',
      hostPattern: 'example.com',
    });
    expect(campaignOriginToGrantOrigin('https://*.example.com')).toEqual({
      scheme: 'https',
      hostPattern: 'example.com',
      includeSubdomains: true,
    });
    expect(campaignOriginToGrantOrigin('ftp://example.com')).toBeNull();
    expect(campaignOriginToGrantOrigin('')).toBeNull();
  });
});

describe('BrowserCampaignRuntime.claimLease', () => {
  it('issues an autonomous lease linked to the campaign', () => {
    const { runtime, campaign } = makeRuntime();

    const result = runtime.claimLease({
      campaignId: campaign.id,
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(result.granted).toBe(true);
    if (!result.granted) return;
    expect(result.grant).toMatchObject({
      mode: 'autonomous',
      autonomous: true,
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: 'profile-1',
      requestedBy: `${CAMPAIGN_GRANT_REQUESTED_BY_PREFIX}${campaign.id}`,
      decidedBy: 'user',
      decision: 'allow',
      expiresAt: T0 + CAMPAIGN_LEASE_MS,
    });
    expect(result.grant.allowedOrigins).toHaveLength(2);
    expect(campaignIdFromGrant(result.grant)).toBe(campaign.id);
  });

  it('is idempotent while the current lease is fresh', () => {
    const { runtime, campaign } = makeRuntime();
    const first = runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });
    const second = runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });

    expect(first.granted && second.granted).toBe(true);
    if (!first.granted || !second.granted) return;
    expect(second.grant.id).toBe(first.grant.id);
    expect(second.renewed).toBe(false);
  });

  it('refuses when the campaign is missing, paused, or out of budget', () => {
    const { runtime, campaigns, campaign } = makeRuntime();

    expect(runtime.claimLease({ campaignId: 'nope', instanceId: 'i' })).toMatchObject({
      granted: false,
      reason: 'campaign_not_found',
    });

    campaigns.pause(campaign.id);
    expect(runtime.claimLease({ campaignId: campaign.id, instanceId: 'i' })).toMatchObject({
      granted: false,
    });

    campaigns.resume(campaign.id);
    campaigns.recordAction(campaign.id, 'submit');
    campaigns.recordAction(campaign.id, 'submit'); // submits budget (2) now exhausted
    const result = runtime.claimLease({ campaignId: campaign.id, instanceId: 'i' });
    expect(result.granted).toBe(false);
  });

  it('caps the lease at the campaign expiry', () => {
    const { runtime, campaign, nowRef } = makeRuntime();
    nowRef.now = campaign.expiresAt - 5 * 60 * 1000; // 5min before campaign end

    const result = runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });

    expect(result.granted).toBe(true);
    if (!result.granted) return;
    expect(result.grant.expiresAt).toBe(campaign.expiresAt);
  });
});

describe('BrowserCampaignRuntime.recordGrantedMutation', () => {
  it('ignores grants that are not campaign leases', () => {
    const { runtime, campaigns, campaign } = makeRuntime();

    runtime.recordGrantedMutation({
      grant: { requestedBy: 'instance-1' },
      actionClass: 'submit',
    });

    expect(campaigns.getCounters(campaign.id)).toMatchObject({ actions: 0, submits: 0 });
  });

  it('counts actions and double-counts submits', () => {
    const { runtime, campaigns, campaign } = makeRuntime();
    const lease = { requestedBy: `${CAMPAIGN_GRANT_REQUESTED_BY_PREFIX}${campaign.id}` };

    runtime.recordGrantedMutation({ grant: lease, actionClass: 'input' });
    runtime.recordGrantedMutation({ grant: lease, actionClass: 'submit' });
    runtime.recordGrantedMutation({ grant: lease, actionClass: 'file-upload' });

    expect(campaigns.getCounters(campaign.id)).toEqual({
      actions: 2, // input + submit (upload counts its own budget)
      submits: 1,
      newAccounts: 0,
      uploads: 1,
    });
  });

  it('pauses the campaign and revokes its leases when a budget trips', () => {
    const { runtime, campaigns, grantStore, campaign } = makeRuntime();
    const claim = runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });
    expect(claim.granted).toBe(true);
    const lease = { requestedBy: `${CAMPAIGN_GRANT_REQUESTED_BY_PREFIX}${campaign.id}` };

    runtime.recordGrantedMutation({ grant: lease, actionClass: 'submit' });
    runtime.recordGrantedMutation({ grant: lease, actionClass: 'submit' });
    runtime.recordGrantedMutation({ grant: lease, actionClass: 'submit' }); // over maxSubmits=2

    expect(campaigns.get(campaign.id)?.status).toBe('paused');
    expect(grantStore.grants.every((grant) => grant.revokedAt)).toBe(true);
  });
});

describe('BrowserCampaignRuntime.renewLeases', () => {
  it('re-issues a lease inside the renew window and leaves fresh leases alone', () => {
    const { runtime, grantStore, campaign, nowRef } = makeRuntime();
    runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });
    expect(grantStore.grants).toHaveLength(1);

    // Still fresh — nothing happens.
    runtime.renewLeases();
    expect(grantStore.grants).toHaveLength(1);

    // 5 minutes before expiry — a renewal is issued for the same instance.
    nowRef.now = T0 + CAMPAIGN_LEASE_MS - 5 * 60 * 1000;
    grantStore.now = nowRef.now;
    runtime.renewLeases();
    expect(grantStore.grants).toHaveLength(2);
    expect(grantStore.grants[0]).toMatchObject({
      instanceId: 'instance-1',
      requestedBy: `${CAMPAIGN_GRANT_REQUESTED_BY_PREFIX}${campaign.id}`,
    });
  });

  it('revokes remaining leases when the campaign has expired', () => {
    const { runtime, grantStore, campaign, nowRef } = makeRuntime();
    runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });

    // Campaign wall-clock has passed but the lease would still be "live".
    nowRef.now = campaign.expiresAt + 1;
    grantStore.grants[0]!.expiresAt = nowRef.now + 30 * 60 * 1000;
    grantStore.now = nowRef.now;

    runtime.renewLeases();

    expect(grantStore.grants[0]!.revokedAt).toBeDefined();
  });
});

describe('BrowserCampaignRuntime.handleCampaignStateChange', () => {
  it('revokes leases when a campaign leaves the active state', () => {
    const { runtime, campaigns, grantStore, campaign } = makeRuntime();
    runtime.claimLease({ campaignId: campaign.id, instanceId: 'instance-1' });

    const paused = campaigns.pause(campaign.id);
    runtime.handleCampaignStateChange(paused);

    expect(grantStore.grants[0]!.revokedAt).toBeDefined();
  });
});
