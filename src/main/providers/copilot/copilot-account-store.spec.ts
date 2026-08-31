import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
} from '../../../shared/types/copilot-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => {
    throw new Error('settings-manager must not be reached in this spec');
  },
}));

const invalidateRouting = vi.fn();
const invalidateBinding = vi.fn();
vi.mock('./copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({ invalidate: invalidateRouting }),
}));
vi.mock('./copilot-account-binding-service', () => ({
  getCopilotAccountBindingService: () => ({ invalidate: invalidateBinding }),
}));

import { CopilotAccountStore, deriveCopilotProfileId } from './copilot-account-store';

function makeStore(initial: {
  profiles?: CopilotAccountProfile[];
  rules?: CopilotAccountRoutingRule[];
  inUse?: string[];
} = {}): { store: CopilotAccountStore; state: { profiles: CopilotAccountProfile[]; rules: CopilotAccountRoutingRule[] } } {
  const state = {
    profiles: initial.profiles ?? [],
    rules: initial.rules ?? [],
  };
  const store = new CopilotAccountStore({
    read: () => ({ profiles: [...state.profiles], rules: [...state.rules] }),
    write: ({ profiles, rules }) => {
      if (profiles) state.profiles = profiles;
      if (rules) state.rules = rules;
    },
    now: () => 1000,
    profilesInUse: () => initial.inUse ?? [],
  });
  return { store, state };
}

beforeEach(() => {
  invalidateRouting.mockClear();
  invalidateBinding.mockClear();
});

describe('deriveCopilotProfileId', () => {
  it('derives a safe slug from a free-form label', () => {
    expect(deriveCopilotProfileId('Work / Enterprise!', [])).toBe('work-enterprise');
    expect(deriveCopilotProfileId('  Personal  ', [])).toBe('personal');
  });

  it('falls back to a safe seed when a label has no usable characters', () => {
    expect(deriveCopilotProfileId('!!! ???', [])).toBe('account');
    expect(deriveCopilotProfileId('日本語', [])).toBe('account');
  });

  it('uniquifies against existing IDs', () => {
    expect(deriveCopilotProfileId('Work', ['work'])).toBe('work-2');
    expect(deriveCopilotProfileId('Work', ['work', 'work-2'])).toBe('work-3');
  });
});

describe('CopilotAccountStore.createProfile', () => {
  it('makes an enterprise profile matched-only by default', () => {
    const { store } = makeStore();
    const profile = store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    expect(profile.scopePolicy).toBe('matched-only');
    // …and therefore not the default, even if asked.
    expect(
      store.createProfile({
        label: 'Enterprise Two',
        accountKind: 'enterprise',
        makeDefault: true,
      }).isDefault,
    ).toBe(false);
  });

  it('makes a personal profile default-eligible', () => {
    const { store } = makeStore();
    expect(store.createProfile({ label: 'Personal', accountKind: 'personal' }).scopePolicy).toBe(
      'default-eligible',
    );
  });

  it('demotes the previous default when a new one is set at creation', () => {
    const { store, state } = makeStore();
    store.createProfile({ label: 'First', accountKind: 'personal', makeDefault: true });
    store.createProfile({ label: 'Second', accountKind: 'personal', makeDefault: true });
    expect(state.profiles.filter((profile) => profile.isDefault).map((p) => p.id)).toEqual([
      'second',
    ]);
  });

  it('normalizes the host to lowercase', () => {
    const { store } = makeStore();
    expect(
      store.createProfile({ label: 'GHE', accountKind: 'enterprise', host: 'GHE.Example.COM' })
        .host,
    ).toBe('ghe.example.com');
  });

  it('invalidates routing and binding caches on every write', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Personal', accountKind: 'personal' });
    expect(invalidateRouting).toHaveBeenCalled();
    expect(invalidateBinding).toHaveBeenCalled();
  });
});

describe('CopilotAccountStore invariants', () => {
  it('refuses to make a matched-only profile the default', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    expect(() => store.setDefault('enterprise')).toThrow(/matched-only/);
  });

  it('clears the default when a profile is narrowed to matched-only', () => {
    const { store, state } = makeStore();
    store.createProfile({ label: 'Personal', accountKind: 'personal', makeDefault: true });
    store.updatePolicy('personal', { scopePolicy: 'matched-only' });
    expect(state.profiles[0].isDefault).toBe(false);
  });

  it('rejects a second rule for the same target', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Personal', accountKind: 'personal', makeDefault: true });
    store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    const matcher = { type: 'owner', host: 'github.com', owner: 'acme' } as const;
    store.createRule({ profileId: 'personal', matcher });
    expect(() => store.createRule({ profileId: 'enterprise', matcher })).toThrow(
      /already routed to a different Copilot account/,
    );
  });

  it('marks an enterprise rule protected by default', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    const rule = store.createRule({
      profileId: 'enterprise',
      matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
    });
    expect(rule.isProtected).toBe(true);
  });

  it('does not mark a personal rule protected by default', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Personal', accountKind: 'personal', makeDefault: true });
    expect(
      store.createRule({
        profileId: 'personal',
        matcher: { type: 'owner', host: 'github.com', owner: 'octocat' },
      }).isProtected,
    ).toBe(false);
  });

  it('rejects a rule pointing at an unknown profile', () => {
    const { store } = makeStore();
    expect(() =>
      store.createRule({
        profileId: 'nope',
        matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
      }),
    ).toThrow(/No Copilot account profile/);
  });
});

describe('CopilotAccountStore.removeProfile', () => {
  it('refuses while a live session holds the profile', () => {
    const { store } = makeStore({ inUse: ['personal'] });
    store.createProfile({ label: 'Personal', accountKind: 'personal', makeDefault: true });
    expect(() => store.removeProfile('personal')).toThrow(/in use by a running session/);
  });

  it('removes the profile and its now-orphan rules together', () => {
    const { store, state } = makeStore();
    store.createProfile({ label: 'Personal', accountKind: 'personal', makeDefault: true });
    store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    store.createRule({
      profileId: 'enterprise',
      matcher: { type: 'owner', host: 'github.com', owner: 'acme' },
    });
    store.removeProfile('enterprise');
    expect(state.profiles.map((profile) => profile.id)).toEqual(['personal']);
    // An orphan rule would route nowhere, so it goes with the account.
    expect(state.rules).toEqual([]);
  });

  it('rejects an unknown profile', () => {
    const { store } = makeStore();
    expect(() => store.removeProfile('nope')).toThrow(/No Copilot account profile/);
  });
});

describe('CopilotAccountStore.adoptObservedIdentity', () => {
  it('records the observed login and host in lowercase', () => {
    const { store } = makeStore();
    store.createProfile({ label: 'Enterprise', accountKind: 'enterprise' });
    const updated = store.adoptObservedIdentity('enterprise', {
      login: 'Acme-Bot',
      host: 'GHE.Example.com',
    });
    expect(updated.expectedLogin).toBe('acme-bot');
    expect(updated.host).toBe('ghe.example.com');
  });
});

describe('a legacy record written before host normalisation', () => {
  // The migration stamped whatever the Copilot CLI had in its own config, and
  // the CLI stores a full origin. Because `persist` re-validates the WHOLE
  // array, that single record made every subsequent mutation throw
  // "Host must be an exact lowercase hostname" — so the user could not add a
  // second account, and could not edit away the record that was blocking them.
  const legacy = (): CopilotAccountProfile => ({
    id: 'legacy',
    label: 'Existing Copilot account',
    expectedLogin: 'shutupandshave',
    host: 'https://github.com' as CopilotAccountProfile['host'],
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: true,
    isLegacy: true,
    createdAt: 1,
    updatedAt: 1,
  });

  it('does not block adding a second account', () => {
    const { store, state } = makeStore({ profiles: [legacy()] });
    expect(() =>
      store.createProfile({ label: 'LAWRENCJ_PE1', accountKind: 'enterprise' }),
    ).not.toThrow();
    expect(state.profiles).toHaveLength(2);
  });

  it('persists the repaired host, so the record heals itself', () => {
    const { store, state } = makeStore({ profiles: [legacy()] });
    store.createProfile({ label: 'LAWRENCJ_PE1', accountKind: 'enterprise' });
    expect(state.profiles[0].host).toBe('github.com');
  });

  it('heals a rule matcher carrying the same bad host', () => {
    const { store, state } = makeStore({
      profiles: [legacy()],
      rules: [
        {
          id: 'rule-legacy',
          profileId: 'legacy',
          matcher: {
            type: 'owner',
            host: 'HTTPS://GitHub.com/' as string,
            owner: 'shutupandshave',
          },
          isProtected: false,
          createdAt: 1,
          updatedAt: 1,
        } as CopilotAccountRoutingRule,
      ],
    });
    store.createProfile({ label: 'LAWRENCJ_PE1', accountKind: 'enterprise' });
    const matcher = state.rules[0].matcher as { host: string };
    expect(matcher.host).toBe('github.com');
  });

  it('still reports a genuinely unusable host rather than silently inventing one', () => {
    // Normalisation must not become a catch-all that accepts anything: a host
    // with a path or a space is a real data error and must still be refused.
    const { store } = makeStore({
      profiles: [{ ...legacy(), host: 'git hub.com/enterprise' as string }],
    });
    expect(() =>
      store.createProfile({ label: 'LAWRENCJ_PE1', accountKind: 'enterprise' }),
    ).toThrow(/Host must be an exact lowercase hostname/);
  });
});

describe('routeTarget — swapping a target between accounts', () => {
  // Reported 2026-08-30. `createRule` refuses a target that already has a rule,
  // which is right for "add a rule" and wrong for the project menu, where
  // clicking an account IS a swap. The user hit a dead end: "already routed to
  // a different Copilot account. Remove the existing rule first."
  const matcher = { type: 'owner', host: 'github.com', owner: 'acme' } as const;

  const mk = (id: string, extra: Partial<CopilotAccountProfile> = {}): CopilotAccountProfile => ({
    id,
    label: id,
    expectedLogin: null,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  const setup = () =>
    makeStore({
      profiles: [
        mk('personal', { isDefault: true }),
        mk('enterprise', { accountKind: 'enterprise', scopePolicy: 'matched-only' }),
      ],
    });

  it('moves an existing rule to the new account instead of failing', () => {
    const { store, state } = setup();
    store.createRule({ profileId: 'personal', matcher, isProtected: false });

    const moved = store.routeTarget({ profileId: 'enterprise', matcher });

    expect(moved.profileId).toBe('enterprise');
    expect(state.rules, 'the target must end up with ONE rule, not two').toHaveLength(1);
    expect(state.rules[0].profileId).toBe('enterprise');
  });

  it('keeps the rule id and creation time, so it is a move not a churn', () => {
    const { store, state } = setup();
    const original = store.createRule({ profileId: 'personal', matcher, isProtected: false });

    store.routeTarget({ profileId: 'enterprise', matcher });

    expect(state.rules[0].id).toBe(original.id);
    expect(state.rules[0].createdAt).toBe(original.createdAt);
  });

  it('is a quiet no-op when the target is already on that account', () => {
    const { store, state } = setup();
    const original = store.createRule({ profileId: 'personal', matcher, isProtected: false });

    expect(() => store.routeTarget({ profileId: 'personal', matcher })).not.toThrow();
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].id).toBe(original.id);
  });

  it('refuses to move a PROTECTED target without explicit confirmation', () => {
    // A protected scope exists so work inside an employer's org fails closed
    // rather than falling to a personal seat. A one-click swap must not undo
    // that silently.
    const { store, state } = setup();
    store.createRule({ profileId: 'enterprise', matcher, isProtected: true });

    expect(() => store.routeTarget({ profileId: 'personal', matcher })).toThrow(/protected/i);
    expect(state.rules[0].profileId, 'the protected rule must be untouched').toBe('enterprise');
  });

  it('moves a protected target once confirmed', () => {
    const { store, state } = setup();
    store.createRule({ profileId: 'enterprise', matcher, isProtected: true });

    store.routeTarget({ profileId: 'personal', matcher, confirmProtectedOverride: true });

    expect(state.rules[0].profileId).toBe('personal');
  });
});

describe('an account added from a discovery suggestion', () => {
  it('records the login, so it is not offered again forever', () => {
    // `alreadyAdded` is computed by matching `expectedLogin`. Creating the
    // profile with a null login meant it never matched itself, so the same
    // account kept appearing as a fresh suggestion — the duplicate
    // "LAWRENCJ_PE1" entry with an [Add] button beside the real one.
    const { store, state } = makeStore();
    store.createProfile({
      label: 'LAWRENCJ_PE1',
      accountKind: 'enterprise',
      expectedLogin: 'LAWRENCJ_PE1',
    });
    expect(state.profiles[0].expectedLogin).toBe('LAWRENCJ_PE1');
  });

  it('accepts an Enterprise Managed User login, which contains an underscore', () => {
    // EMU logins are `<name>_<enterprise-shortcode>` and display uppercase.
    // The profile schema validated them with the lowercase repo-OWNER pattern,
    // so recording this identity failed — and since persist() re-validates the
    // whole array, one such record would have blocked every later write.
    const { store } = makeStore();
    expect(() =>
      store.createProfile({
        label: 'Work',
        accountKind: 'enterprise',
        expectedLogin: 'LAWRENCJ_PE1',
      }),
    ).not.toThrow();
  });
});
