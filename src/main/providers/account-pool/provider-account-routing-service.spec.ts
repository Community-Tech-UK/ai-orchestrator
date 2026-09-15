import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));
vi.mock('../../core/system/provider-limit-ledger', () => ({ getProviderLimitLedgerPort: vi.fn() }));
vi.mock('./account-quota-evidence', () => ({ readAccountQuotaEvidence: vi.fn(() => null) }));

import { ProviderAccountStore } from './provider-account-store';
import { ProviderAccountRoutingService } from './provider-account-routing-service';
import type { ProviderAccountBindingService } from './provider-account-binding-service';

function profile(id: string, priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

let profiles: ProviderAccountProfile[];
let bindingStates: Record<string, AccountBindingStatus['state']>;
let parked: string[];
const checkBinding = vi.fn(async (entry: ProviderAccountProfile) => ({
  provider: entry.provider, profileId: entry.id, nodeId: 'local', state: bindingStates[entry.id] ?? 'authenticated', checkedAt: 1,
}) as AccountBindingStatus);

function service(): ProviderAccountRoutingService {
  const pools = defaultProviderAccountPools();
  const store = new ProviderAccountStore({
    read: () => ({ profiles, pools }),
    write: () => undefined,
  });
  return new ProviderAccountRoutingService({
    store,
    bindingService: { checkBinding, invalidate: vi.fn() } as unknown as ProviderAccountBindingService,
    getParkedProfileIds: () => parked,
    getSoonestResumeAt: (_provider, _model, ids) => (ids[0] === 'max-b' ? 1000 : 5000),
  });
}

beforeEach(() => {
  profiles = [profile('legacy', 0), profile('max-b', 1)];
  bindingStates = {};
  parked = [];
  checkBinding.mockClear();
});

describe('ProviderAccountRoutingService', () => {
  it('returns the legacy route with no binding check while only the legacy profile exists', async () => {
    profiles = [profile('legacy', 0)];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toEqual({ ok: true, route: expect.objectContaining({ profileId: 'legacy', source: 'legacy' }) });
    expect(checkBinding).not.toHaveBeenCalled();
  });

  it('keeps a persisted profile even when a higher-priority one is free', async () => {
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', persistedProfileId: 'max-b' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'persisted' } });
  });

  it('refuses a persisted profile that was removed rather than moving the thread', async () => {
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', persistedProfileId: 'gone' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-missing' });
  });

  it('admission never substitutes: an unauthenticated explicit profile fails', async () => {
    bindingStates = { 'max-b': 'unauthenticated' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', explicitProfileId: 'max-b' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-unauthenticated', profileId: 'max-b' });
  });

  it('refuses a disabled or automation-disallowed explicit profile', async () => {
    profiles = [profile('legacy', 0), profile('max-b', 1, { enabled: false }), profile('max-c', 2, { automationPolicy: 'manual-only' })];
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', explicitProfileId: 'max-b' }))
      .resolves.toMatchObject({ code: 'profile-disabled' });
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'automation', explicitProfileId: 'max-c' }))
      .resolves.toMatchObject({ code: 'automation-disallowed' });
  });

  it('defaults past a parked profile to the next in priority', async () => {
    parked = ['legacy'];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'default', profileLabel: 'Label max-b' } });
  });

  it('routes to the soonest reset when every signed-in profile is parked', async () => {
    parked = ['legacy', 'max-b'];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b' } });
  });

  it('fails with a typed reason when no profile is signed in', async () => {
    bindingStates = { legacy: 'unauthenticated', 'max-b': 'identity-mismatch' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-unauthenticated' });
  });

  it('skips binding checks for remote placement', async () => {
    bindingStates = { legacy: 'unauthenticated' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', executionNodeId: 'node-1' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'legacy', executionNodeId: 'node-1' } });
    expect(checkBinding).not.toHaveBeenCalled();
  });
});
