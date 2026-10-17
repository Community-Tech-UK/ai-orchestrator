import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { defaultProviderAccountPools, type ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { AccountFailoverCoordinator, type AccountFailoverParams } from './account-failover-coordinator';
import type { ProviderAccountBindingService } from './provider-account-binding-service';
import type { AccountQuotaEvidence } from './provider-account-selector';
import { ProviderAccountStore } from './provider-account-store';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: () => undefined }));

function harness(initialQuota: AccountQuotaEvidence, freshQuota = initialQuota) {
  const profiles: ProviderAccountProfile[] = ['legacy', 'alternative'].map((id, priority) => ({
    id, provider: 'claude', label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  }));
  const pools = defaultProviderAccountPools();
  pools.claude = { ...pools.claude, failoverMode: 'automatic', acknowledgedOwnershipAt: 1 };
  const store = new ProviderAccountStore({ read: () => ({ profiles, pools }) });
  const instance = { id: 'session', provider: 'claude', accountProfileId: 'legacy', status: 'idle' } as Instance;
  const resent: string[] = [];
  let quota = initialQuota;
  const bindings = {
    getCached: () => null,
    checkBinding: async () => ({ state: 'authenticated' }),
  } as unknown as ProviderAccountBindingService;
  const coordinator = new AccountFailoverCoordinator({
    store: () => store,
    bindings: () => bindings,
    getParkedProfileIds: () => [],
    getQuotaEvidence: (_provider, id) => id === 'alternative' ? quota : null,
    refreshQuotaEvidence: async () => { quota = freshQuota; },
    getInstance: () => instance,
    applyRuntimeChange: async (_id, desired) => {
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    },
    resendInput: (_id, prompt) => { resent.push(prompt); },
    notify: () => undefined,
  });
  return { coordinator, instance, resent };
}

function params(allowCredits: boolean | undefined): AccountFailoverParams {
  return {
    instanceId: 'session', provider: 'claude', model: null, exhaustedProfileId: 'legacy', resumeAt: null,
    resumePrompt: 'continue', reason: 'usage limit', ...(allowCredits === undefined ? {} : { allowCredits }),
  };
}

const creditsOnly: AccountQuotaEvidence = { weeklyPct: 100, usable: true, creditsOnly: true };
const creditPolicies = [
  { label: 'disallowed', allowCredits: false, eligible: false },
  { label: 'allowed', allowCredits: true, eligible: true },
  { label: 'unspecified', allowCredits: undefined, eligible: true },
];

describe('AccountFailoverCoordinator credit policy', () => {
  it('keeps the same-turn cap and preserves the cooldown when a new input starts', async () => {
    const h = harness({ weeklyPct: 20, usable: true });
    const request = params(false);
    expect(await h.coordinator.perform(request)).toMatchObject({ outcome: 'switched' });
    const nextStop = { ...request, exhaustedProfileId: 'alternative' };

    h.coordinator.observeInput('session', 'continue');
    expect(h.coordinator.plan(nextStop)).toEqual({ kind: 'none', reason: 'cap-reached' });
    h.coordinator.observeInput('session', 'a different user input');
    expect(h.coordinator.plan(nextStop)).toEqual({ kind: 'none', reason: 'cooldown' });
  });

  it.each(creditPolicies)('keeps credits $label when planning a switch', async ({ allowCredits, eligible }) => {
    const h = harness(creditsOnly);
    const request = params(allowCredits);

    expect(h.coordinator.plan(request)).toEqual(eligible ? { kind: 'switch' } : { kind: 'none', reason: 'no-candidate' });
    const outcome = await h.coordinator.perform(request);

    if (eligible) {
      expect(outcome).toMatchObject({ outcome: 'switched', toProfileId: 'alternative' });
      expect(h.instance.accountProfileId).toBe('alternative');
      expect(h.resent).toEqual(['continue']);
    } else {
      expect(outcome).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate' });
      expect(h.instance.accountProfileId).toBe('legacy');
      expect(h.resent).toEqual([]);
    }
  });

  it.each(creditPolicies)('keeps credits $label after the fresh quota check', async ({ allowCredits, eligible }) => {
    const h = harness({ weeklyPct: 20, usable: true }, creditsOnly);
    const request = params(allowCredits);
    expect(h.coordinator.plan(request)).toEqual({ kind: 'switch' });

    const outcome = await h.coordinator.perform(request);

    if (eligible) {
      expect(outcome).toMatchObject({ outcome: 'switched', toProfileId: 'alternative' });
      expect(h.instance.accountProfileId).toBe('alternative');
      expect(h.resent).toEqual(['continue']);
    } else {
      expect(outcome).toMatchObject({
        outcome: 'not-switched', reason: 'no-candidate',
        considered: expect.arrayContaining([{ profileId: 'alternative', vetoReason: 'credits-only' }]),
      });
      expect(h.instance.accountProfileId).toBe('legacy');
      expect(h.resent).toEqual([]);
    }
  });
});
