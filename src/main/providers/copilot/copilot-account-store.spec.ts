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
