import { describe, expect, it } from 'vitest';
import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import {
  accountPreferencesFor, accountRuleTier, choiceBlockedByNeverUse, describeAccountRules,
} from './plan-queue-account-rules';

const pool = (id: string, provider: 'claude' | 'codex' | 'opencode', extra: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile => ({
  id, provider, label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
  priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false, createdAt: 1, updatedAt: 1, ...extra,
} as ProviderAccountProfile);

const rules = (never: PlanQueueAccountRules['never'] = [], last: PlanQueueAccountRules['last'] = []): PlanQueueAccountRules => ({ never, last });

describe('accountRuleTier', () => {
  it('reads each list by provider and id', () => {
    const r = rules([{ provider: 'claude', accountId: 'a' }], [{ provider: 'claude', accountId: 'b' }]);
    expect(accountRuleTier(r, 'claude', 'a')).toBe('never');
    expect(accountRuleTier(r, 'claude', 'b')).toBe('last');
    expect(accountRuleTier(r, 'codex', 'a')).toBeNull();
  });
});

describe('accountPreferencesFor', () => {
  it('carries only the ids for the session\'s own provider', () => {
    const r = rules([{ provider: 'claude', accountId: 'a' }, { provider: 'copilot', accountId: 'c' }], [{ provider: 'claude', accountId: 'b' }]);
    expect(accountPreferencesFor(r, 'claude')).toEqual({ avoid: ['a'], last: ['b'] });
    expect(accountPreferencesFor(r, 'copilot')).toEqual({ avoid: ['c'], last: [] });
  });

  it('is null when the lists name none of the provider\'s accounts', () => {
    expect(accountPreferencesFor(rules([{ provider: 'codex', accountId: 'x' }]), 'claude')).toBeNull();
    expect(accountPreferencesFor(rules(), 'claude')).toBeNull();
  });
});

describe('choiceBlockedByNeverUse', () => {
  const never = rules([{ provider: 'claude', accountId: 'suas' }, { provider: 'copilot', accountId: 'work' }]);
  const pools = [pool('suas', 'claude'), pool('other', 'claude')];
  const copilot = [{ id: 'work', label: 'Work seat', automationPolicy: 'allow-routed' } as never];

  it('blocks a ticked never-use account by its label', () => {
    expect(choiceBlockedByNeverUse({ provider: 'claude', accountProfileIds: ['suas'] }, 'claude', never, pools, copilot))
      .toBe('the claude account "Label suas" is on your never-use list');
  });

  it('allows a choice whose ticked accounts are fine', () => {
    expect(choiceBlockedByNeverUse({ provider: 'claude', accountProfileIds: ['other'] }, 'claude', never, pools, copilot)).toBeNull();
  });

  it('blocks a Copilot choice on a never-use account', () => {
    expect(choiceBlockedByNeverUse({ provider: 'copilot', copilotProfileId: 'work' }, 'copilot', never, [], copilot))
      .toBe('the Copilot account "Work seat" is on your never-use list');
  });

  it('blocks a pooled choice with no account ticked only when every usable account is on the list', () => {
    const allBanned = rules([{ provider: 'claude', accountId: 'suas' }, { provider: 'claude', accountId: 'other' }]);
    expect(choiceBlockedByNeverUse({ provider: 'claude' }, 'claude', allBanned, pools, copilot)).toBe('every claude account this choice can use is on your never-use list');
    expect(choiceBlockedByNeverUse({ provider: 'claude' }, 'claude', never, pools, copilot)).toBeNull();
  });

  it('ignores accounts that are off or manual-only when deciding every usable account is banned', () => {
    const offAndBanned = [pool('suas', 'claude'), pool('off', 'claude', { enabled: false }), pool('manual', 'claude', { automationPolicy: 'manual-only' })];
    const onlyUsableBanned = rules([{ provider: 'claude', accountId: 'suas' }]);
    expect(choiceBlockedByNeverUse({ provider: 'claude' }, 'claude', onlyUsableBanned, offAndBanned, copilot))
      .toBe('every claude account this choice can use is on your never-use list');
  });

  it('does not block an OpenCode choice on a non-MiMo model, which ignores pool accounts', () => {
    const banned = rules([{ provider: 'opencode', accountId: 'mimo' }]);
    expect(choiceBlockedByNeverUse({ provider: 'opencode', model: 'opencode/big-pickle' }, 'opencode', banned, [pool('mimo', 'opencode')], copilot)).toBeNull();
  });
});

describe('describeAccountRules', () => {
  it('is null when no rule is set', () => {
    expect(describeAccountRules(rules(), () => 'x')).toBeNull();
  });

  it('names each list with account labels', () => {
    const r = rules([{ provider: 'claude', accountId: 'suas' }], [{ provider: 'codex', accountId: 'pro-2' }]);
    expect(describeAccountRules(r, (ref) => (ref.accountId === 'suas' ? 'SuasClaude' : 'Codex Pro 2')))
      .toBe('never use: SuasClaude; use last: Codex Pro 2');
  });
});
