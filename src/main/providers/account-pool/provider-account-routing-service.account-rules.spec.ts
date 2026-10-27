import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountPoolPolicy, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));
vi.mock('../../core/system/provider-limit-ledger', () => ({ getProviderLimitLedgerPort: vi.fn() }));
vi.mock('./account-quota-evidence', async (importOriginal) => ({
  ...await importOriginal<typeof import('./account-quota-evidence')>(),
  readAccountQuotaEvidence: vi.fn(() => null),
}));

import { ProviderAccountStore } from './provider-account-store';
import { ProviderAccountRoutingService, type AccountRouteRequest } from './provider-account-routing-service';
import { ProviderAccountBindingService } from './provider-account-binding-service';

function profile(id: string, priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

const checkBinding = vi.fn(async (entry: ProviderAccountProfile) => ({
  provider: entry.provider, profileId: entry.id, nodeId: 'local', state: 'authenticated', checkedAt: 1,
}) as AccountBindingStatus);

let profiles: ProviderAccountProfile[];
let parked: string[];

function serviceWith(policy: Partial<ProviderAccountPoolPolicy> = {}): ProviderAccountRoutingService {
  const pools = defaultProviderAccountPools();
  pools.claude = { ...pools.claude, ...policy };
  const store = new ProviderAccountStore({ read: () => ({ profiles, pools }), write: () => undefined });
  return new ProviderAccountRoutingService({
    store,
    bindingService: { checkBinding, invalidate: vi.fn() } as unknown as ProviderAccountBindingService,
    getParkedProfileIds: () => parked,
    getQuotaEvidence: () => null,
  });
}

const request = (overrides: Partial<AccountRouteRequest> = {}): AccountRouteRequest => ({
  provider: 'claude', origin: 'automation', newSession: true, executionNodeId: 'local', ...overrides,
});

beforeEach(() => {
  profiles = [profile('max-a', 0), profile('max-b', 1), profile('max-c', 2)];
  parked = [];
  checkBinding.mockClear();
});

describe('ProviderAccountRoutingService: never-use (avoid)', () => {
  it('picks the next allowed account when the first is on the never-use list', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ avoid: ['max-a'] }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'default' } });
  });

  it('refuses an explicitly chosen account on the list, naming it and the Plan Queue list', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ explicitProfileId: 'max-a', avoid: ['max-a'] }));
    expect(outcome).toMatchObject({
      ok: false, code: 'automation-disallowed', profileId: 'max-a',
      detail: 'The Label max-a Claude account is on your never-use list (Plan Queue page), so this session cannot use it.',
    });
  });

  it('moves a persisted session off a never-use account to an allowed one, as a failover', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ persistedProfileId: 'max-a', avoid: ['max-a'], resume: false }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'failover' } });
  });

  it('tells the user a never-use restart was for the never-use list, not a usage limit', async () => {
    const notify = vi.fn();
    const pools = defaultProviderAccountPools();
    const store = new ProviderAccountStore({ read: () => ({ profiles, pools }), write: () => undefined });
    const routing = new ProviderAccountRoutingService({
      store,
      bindingService: { checkBinding, invalidate: vi.fn() } as unknown as ProviderAccountBindingService,
      getParkedProfileIds: () => parked,
      getQuotaEvidence: () => null,
      notify,
    });
    await routing.resolveRouteForSpawn(request({ persistedProfileId: 'max-a', avoid: ['max-a'], resume: false, instanceId: 'i1' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account-switched', body: expect.stringContaining('never-use list') }));
    expect(notify.mock.calls[0]?.[0].body).not.toContain('usage limit');
  });

  it('refuses to move a resumed thread off a never-use account when its pool cannot carry the thread', async () => {
    const outcome = await serviceWith({ continuation: 'replay' as ProviderAccountPoolPolicy['continuation'] }).resolveRouteForSpawn(
      request({ persistedProfileId: 'max-a', avoid: ['max-a'], resume: true }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'automation-disallowed', profileId: 'max-a' });
  });

  it('says so plainly when every usable account is on the list', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ avoid: ['max-a', 'max-b', 'max-c'] }));
    expect(outcome).toMatchObject({
      ok: false, code: 'automation-disallowed',
      detail: 'No enabled Claude account is left for this session outside your never-use list. Remove one from that list on the Plan Queue page, or enable an account.',
    });
  });

  it('refuses the legacy sign-in when it is the only account and it is on the list', async () => {
    profiles = [profile('legacy', 0)];
    const outcome = await serviceWith().resolveRouteForSpawn(request({ avoid: ['legacy'] }));
    expect(outcome).toMatchObject({ ok: false, code: 'automation-disallowed', detail: expect.stringContaining('existing Claude account') });
  });

  it('does not change a session that has no avoid list', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ persistedProfileId: 'max-a', resume: true }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-a', source: 'persisted' } });
  });
});

describe('ProviderAccountRoutingService: use-last', () => {
  it('uses the other accounts first, even when the use-last account has the highest priority', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ useLast: ['max-a'] }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b' } });
  });

  it('uses the use-last account only when every other account is parked', async () => {
    parked = ['max-b', 'max-c'];
    const outcome = await serviceWith().resolveRouteForSpawn(request({ useLast: ['max-a'] }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-a' } });
  });

  it('uses a use-last account when it is the only one the session is limited to', async () => {
    const outcome = await serviceWith().resolveRouteForSpawn(request({ useLast: ['max-a'], restrictTo: ['max-a'] }));
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-a' } });
  });
});
