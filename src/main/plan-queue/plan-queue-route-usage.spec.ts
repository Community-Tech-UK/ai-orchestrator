import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../shared/types/provider-account.types';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../shared/types/provider-quota.types';
import type { ProviderLimitEvent } from '../core/system/provider-limit-ledger';

vi.mock('../providers/account-pool/provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));
vi.mock('../providers/account-pool/account-quota-evidence', () => ({ readAccountQuotaEvidence: vi.fn(() => null) }));

import { ProviderAccountBindingService } from '../providers/account-pool/provider-account-binding-service';
import { ProviderAccountRoutingService } from '../providers/account-pool/provider-account-routing-service';
import type { AccountQuotaEvidence } from '../providers/account-pool/provider-account-selector';
import { ProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { parseCursorUsageSummaryPayload } from '../core/system/provider-quota/cursor-usage-summary-probe';
import { parseGrokBillingPayload } from '../core/system/provider-quota/grok-billing-probe';
import { pickRouteChoice, planQueueRouteUsage, type PlanQueueRouteUsageDeps } from './plan-queue-route-usage';

function profile(id: string, provider: ProviderAccountProfile['provider'], priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null, priority,
    enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function window(id: string, used: number, resetsAt: number | null, overage = false): ProviderQuotaWindow {
  return { kind: 'calendar-period', id, label: id, unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt, overage };
}

function snapshot(provider: ProviderQuotaSnapshot['provider'], windows: ProviderQuotaWindow[]): ProviderQuotaSnapshot {
  return { provider, takenAt: 10, source: 'admin-api', ok: true, windows };
}

let profiles: ProviderAccountProfile[];
let parked: string[];
let quota: Record<string, AccountQuotaEvidence>;
let limits: (Omit<ProviderLimitEvent, 'id' | 'detectedAt' | 'source' | 'instanceId'> & { detectedAt?: number })[];
/** The model the spawn's own resolver would start a session on, per provider (absent = the choice's own model). */
let spawnModels: Record<string, string>;
let accountQuota: Record<string, AccountQuotaEvidence>;
let providerQuota: Record<string, ProviderQuotaSnapshot>;
const getActive = vi.fn((query: { provider: string; model: string | null; accountProfileId?: string | null; includeAccountWideFallback?: boolean }) => {
  const profileId = query.accountProfileId ?? null;
  const found = limits.find((limit) => limit.provider === query.provider
    && (limit.accountProfileId ?? null) === profileId
    && (limit.model === query.model || (limit.model === null && query.includeAccountWideFallback !== false)));
  return found ? { ...found, id: 'limit', detectedAt: found.detectedAt ?? 1, source: 'test', instanceId: null } : null;
});
const getParkedSince = vi.fn((query: { provider: string; model: string | null }) => new Map(limits
  .filter((limit) => limit.provider === query.provider && (limit.model === query.model || limit.model === null))
  .map((limit) => [limit.accountProfileId ?? 'legacy', limit.detectedAt ?? 1] as const)));

function deps(): PlanQueueRouteUsageDeps {
  const routing = new ProviderAccountRoutingService({
    store: new ProviderAccountStore({ read: () => ({ profiles, pools: defaultProviderAccountPools() }), write: () => undefined }),
    bindingService: {
      checkBinding: async (entry: ProviderAccountProfile) => ({ provider: entry.provider, profileId: entry.id, nodeId: 'local', state: 'authenticated', checkedAt: 1 }) as AccountBindingStatus,
      invalidate: vi.fn(),
    } as unknown as ProviderAccountBindingService,
    getParkedProfileIds: () => parked,
    getQuotaEvidence: (_provider, id) => quota[id] ?? null,
  });
  return {
    previewAccountRoute: (request) => routing.preview(request),
    accountRules: () => ({ never: [], last: [] }),
    copilotProfileFor: () => null,
    ledger: { getActive, getParkedSince } as unknown as PlanQueueRouteUsageDeps['ledger'],
    spawnModel: async (choice) => choice.model ?? spawnModels[choice.provider] ?? null,
    quotaEvidence: (provider, accountProfileId) => accountQuota[`${provider}:${accountProfileId ?? 'legacy'}`] ?? null,
    providerQuota: (provider) => providerQuota[provider] ?? null,
    now: () => 100,
  };
}

beforeEach(() => {
  profiles = [];
  parked = [];
  quota = {};
  limits = [];
  spawnModels = {};
  accountQuota = {};
  providerQuota = {};
  getActive.mockClear();
});

describe('planQueueRouteUsage — account pools', () => {
  it('has usage when the pool can pick one of the choice\'s accounts', async () => {
    profiles = [profile('max-a', 'claude', 0), profile('max-b', 'claude', 1)];
    parked = ['max-a'];
    expect(await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
  });

  it('has no usage when every account it may use is parked or exhausted, and says when the pool\'s pick lifts', async () => {
    profiles = [profile('max-a', 'claude', 0), profile('max-b', 'claude', 1)];
    parked = ['max-a'];
    quota = { 'max-b': { weeklyPct: 100 } };
    limits = [{ provider: 'claude', model: null, accountProfileId: 'max-a', resumeAt: 5000 }];
    expect(await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 5000 });
    // The fence matters: the free account outside it does not count.
    quota = {};
    expect(await planQueueRouteUsage({ provider: 'claude', accountProfileIds: ['max-a'] }, 'automation', { allowLast: true }, deps()))
      .toEqual({ usable: false, resumeAt: 5000 });
    expect(await planQueueRouteUsage({ provider: 'claude', accountProfileIds: ['max-b'] }, 'automation', { allowLast: true }, deps()))
      .toEqual({ usable: true, resumeAt: null });
  });

  it('treats an account that could run only on purchased credits as no usage for queue work', async () => {
    profiles = [profile('pro-1', 'codex', 0)];
    quota = { 'pro-1': { usable: true, creditsOnly: true } };
    expect(await planQueueRouteUsage({ provider: 'codex' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: null });
  });

  it('has no usage when no account of the choice can start at all', async () => {
    profiles = [profile('max-a', 'claude', 0, { automationPolicy: 'manual-only' })];
    expect(await planQueueRouteUsage({ provider: 'claude' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: null });
  });

  it('reads the ledger for a provider with only its pre-pools sign-in', async () => {
    profiles = [profile('legacy', 'codex', 0)];
    expect(await planQueueRouteUsage({ provider: 'codex', model: 'gpt-6.1-sol' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    limits = [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileId: null, resumeAt: 700 }];
    expect(await planQueueRouteUsage({ provider: 'codex', model: 'gpt-6.1-sol' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 700 });
  });

  it('checks an OpenCode choice against its MiMo accounts only for a MiMo model', async () => {
    profiles = [profile('mimo-a', 'opencode', 0, { region: 'ams' })];
    quota = { 'mimo-a': { allowancePct: 100 } };
    expect(await planQueueRouteUsage({ provider: 'opencode', model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' }, 'automation', { allowLast: true }, deps()))
      .toEqual({ usable: false, resumeAt: null });
    // Another OpenCode model never uses those accounts, so their usage does not apply.
    expect(await planQueueRouteUsage({ provider: 'opencode', model: 'openai/gpt-5.5' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
  });
});

describe('planQueueRouteUsage — providers without an account pool', () => {
  it('has no usage while the ledger holds an active limit for the provider and model', async () => {
    limits = [{ provider: 'cursor', model: 'composer-2', accountProfileId: null, resumeAt: 900 }];
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'composer-2' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 900 });
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'composer-1' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    limits = [{ provider: 'cursor', model: null, accountProfileId: null, resumeAt: 400 }];
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'composer-1' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 400 });
  });

  it('checks a choice without a model under the model a new session would start on', async () => {
    // James's real case: no remembered Grok model, so the spawn falls back to the provider default.
    spawnModels = { grok: 'grok-4.7' };
    limits = [{ provider: 'grok', model: 'grok-4.7', accountProfileId: null, resumeAt: 300 }];
    expect(await planQueueRouteUsage({ provider: 'grok' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 300 });
    expect(getActive).toHaveBeenCalledWith(expect.objectContaining({ provider: 'grok', model: 'grok-4.7', now: 100 }));
  });

  it('counts a limit the provider has since lifted as usage left, but never on purchased credits alone', async () => {
    limits = [{ provider: 'grok', model: 'grok-4.7', accountProfileId: null, resumeAt: 900, detectedAt: 50 }];
    accountQuota = { 'grok:legacy': { usable: true, observedAt: 80 } };
    expect(await planQueueRouteUsage({ provider: 'grok', model: 'grok-4.7' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    accountQuota = { 'grok:legacy': { usable: true, creditsOnly: true, observedAt: 80 } };
    expect(await planQueueRouteUsage({ provider: 'grok', model: 'grok-4.7' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 900 });
    // Evidence older than the limit proves nothing.
    accountQuota = { 'grok:legacy': { usable: true, observedAt: 40 } };
    expect(await planQueueRouteUsage({ provider: 'grok', model: 'grok-4.7' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 900 });
  });

  it('never treats usage figures as lifting a Copilot rate limit, as the send path does not', async () => {
    limits = [{ provider: 'copilot', model: 'gpt-6-astra', accountProfileId: null, resumeAt: 900, detectedAt: 50 }];
    accountQuota = { 'copilot:legacy': { usable: true, observedAt: 80 } };
    getActive.mockImplementationOnce(() => ({ ...limits[0]!, id: 'limit', detectedAt: 50, source: 'copilot-rate-limit', instanceId: null }));
    expect(await planQueueRouteUsage({ provider: 'copilot', model: 'gpt-6-astra' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 900 });
    // Any other Copilot limit is lifted by newer evidence like other providers'.
    expect(await planQueueRouteUsage({ provider: 'copilot', model: 'gpt-6-astra' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
  });

  it('has no usage when the provider\'s figures show its whole plan spent, until that plan resets', async () => {
    // James's real case: Cursor at 100% of included usage, on-demand spend also used up.
    providerQuota = { cursor: snapshot('cursor', [window('cursor.included', 100, 5000), window('cursor.on-demand', 100, 5000, true)]) };
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'grok-4.7-high' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 5000 });
    providerQuota = { cursor: snapshot('cursor', [window('cursor.included', 90, 5000)]) };
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'grok-4.7-high' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    providerQuota = { grok: snapshot('grok', [window('grok.monthly', 100, 7000)]) };
    expect(await planQueueRouteUsage({ provider: 'grok', model: 'grok-4.7' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 7000 });
  });

  it('reads the windows the Cursor and Grok usage probes actually produce', async () => {
    // The shape Cursor's usage page returned on 2026-10-28, when the queue started a worker anyway.
    const cursorEnd = '2026-11-03T15:09:40.000Z';
    providerQuota = { cursor: snapshot('cursor', parseCursorUsageSummaryPayload({
      billingCycleEnd: cursorEnd,
      individualUsage: { plan: { enabled: true, used: 7000, limit: 7000, totalPercentUsed: 100 }, onDemand: { enabled: true, used: 10028, limit: 10000 } },
    })) };
    expect(await planQueueRouteUsage({ provider: 'cursor', model: 'grok-4.7-high' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: Date.parse(cursorEnd) });
    const grokEnd = '2026-11-01T00:00:00.000Z';
    providerQuota = { grok: snapshot('grok', parseGrokBillingPayload({ config: { used: { val: 50 }, monthlyLimit: { val: 50 }, billingPeriodEnd: grokEnd } })) };
    expect(await planQueueRouteUsage({ provider: 'grok', model: 'grok-4.7' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: Date.parse(grokEnd) });
  });

  it('never counts paid on-demand spend as usage left once the plan is spent', async () => {
    providerQuota = { cursor: snapshot('cursor', [window('cursor.included', 100, 5000), window('cursor.on-demand', 20, 5000, true)]) };
    expect(await planQueueRouteUsage({ provider: 'cursor' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 5000 });
  });

  it('ignores model-specific windows, failed readings and readings from before a reset that has passed', async () => {
    providerQuota = { copilot: snapshot('copilot', [window('copilot.premium-interactions', 100, 5000)]) };
    expect(await planQueueRouteUsage({ provider: 'copilot', model: 'gpt-6-astra' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    providerQuota = { cursor: { ...snapshot('cursor', [window('cursor.included', 100, 5000)]), ok: false } };
    expect(await planQueueRouteUsage({ provider: 'cursor' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
    // Read at 10, reset at 50, now 100: the plan has reset since.
    providerQuota = { cursor: snapshot('cursor', [window('cursor.included', 100, 50)]) };
    expect(await planQueueRouteUsage({ provider: 'cursor' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
  });

  it('keeps the ledger\'s reset time when a recorded limit is also active', async () => {
    limits = [{ provider: 'cursor', model: null, accountProfileId: null, resumeAt: 400 }];
    providerQuota = { cursor: snapshot('cursor', [window('cursor.included', 100, 5000)]) };
    expect(await planQueueRouteUsage({ provider: 'cursor' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 400 });
  });

  it('honours a lifted limit for a provider with only its pre-pools sign-in too', async () => {
    profiles = [profile('legacy', 'codex', 0)];
    limits = [{ provider: 'codex', model: null, accountProfileId: null, resumeAt: 700, detectedAt: 10 }];
    expect(await planQueueRouteUsage({ provider: 'codex' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: false, resumeAt: 700 });
    accountQuota = { 'codex:legacy': { usable: true, observedAt: 20 } };
    expect(await planQueueRouteUsage({ provider: 'codex' }, 'automation', { allowLast: true }, deps())).toEqual({ usable: true, resumeAt: null });
  });
});

describe('pickRouteChoice', () => {
  const choices = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor' }];
  const usage = (table: Record<string, { usable: boolean; resumeAt: number | null }>) => vi.fn(async (choice: { provider: string }) => table[choice.provider]!);

  it('stops at the first choice with usage left', async () => {
    const check = usage({ claude: { usable: false, resumeAt: 50 }, codex: { usable: true, resumeAt: null }, cursor: { usable: true, resumeAt: null } });
    expect(await pickRouteChoice(choices, 'automation', check)).toEqual({ choice: { provider: 'codex' }, index: 1, usable: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('with none left, waits on the soonest known reset, keeping list order on ties', async () => {
    expect(await pickRouteChoice(choices, 'automation', usage({
      claude: { usable: false, resumeAt: 80 }, codex: { usable: false, resumeAt: 20 }, cursor: { usable: false, resumeAt: 20 },
    }))).toEqual({ choice: { provider: 'codex' }, index: 1, usable: false });
    expect(await pickRouteChoice(choices, 'automation', usage({
      claude: { usable: false, resumeAt: null }, codex: { usable: false, resumeAt: null }, cursor: { usable: false, resumeAt: null },
    }))).toEqual({ choice: { provider: 'claude' }, index: 0, usable: false });
  });

  it('returns nothing for an empty list', async () => {
    expect(await pickRouteChoice([], 'automation', usage({}))).toBeNull();
  });
});
