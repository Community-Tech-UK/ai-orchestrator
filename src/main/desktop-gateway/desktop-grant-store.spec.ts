import { describe, expect, it } from 'vitest';
import {
  InMemoryDesktopGrantStore,
  type DesktopPermissionGrant,
} from './desktop-grant-store';

function grant(overrides: Partial<DesktopPermissionGrant> = {}): DesktopPermissionGrant {
  return {
    id: 'grant-1',
    instanceId: 'instance-a',
    provider: 'claude',
    appId: 'darwin-app:com.apple.Preview',
    capability: 'observeAndInput',
    scope: 'session',
    createdAt: 1,
    expiresAt: 10_000,
    decidedBy: 'user',
    ...overrides,
  };
}

describe('desktop grant stores', () => {
  it('applies durable app grants to later agent sessions', () => {
    const store = new InMemoryDesktopGrantStore();
    store.createGrant(grant({ scope: 'durable' }));

    const active = store.listActiveGrants({
      context: { instanceId: 'instance-b', provider: 'codex' },
      appId: 'darwin-app:com.apple.Preview',
      now: 2,
    });

    expect(active).toHaveLength(1);
    expect(active[0]?.scope).toBe('durable');
  });

  it('keeps session grants scoped to their creating instance and provider', () => {
    const store = new InMemoryDesktopGrantStore();
    store.createGrant(grant());

    expect(store.listActiveGrants({
      context: { instanceId: 'instance-b', provider: 'claude' },
      appId: 'darwin-app:com.apple.Preview',
      now: 2,
    })).toEqual([]);
    expect(store.listActiveGrants({
      context: { instanceId: 'instance-a', provider: 'codex' },
      appId: 'darwin-app:com.apple.Preview',
      now: 2,
    })).toEqual([]);
  });
});
