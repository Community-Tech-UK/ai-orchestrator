import { describe, expect, it } from 'vitest';
import { BrowserTargetRegistry } from './browser-target-registry';

describe('BrowserTargetRegistry', () => {
  it('keeps selected target status exclusive per profile', () => {
    const registry = new BrowserTargetRegistry();
    registry.upsertTarget({
      id: 'target-1',
      profileId: 'profile-1',
      mode: 'session',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 1,
    });
    registry.upsertTarget({
      id: 'target-2',
      profileId: 'profile-1',
      mode: 'session',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 2,
    });
    registry.upsertTarget({
      id: 'target-3',
      profileId: 'profile-2',
      mode: 'session',
      driver: 'cdp',
      status: 'selected',
      lastSeenAt: 3,
    });

    registry.selectTarget('target-1');
    registry.selectTarget('target-2');

    expect(registry.listTargets('profile-1')).toEqual([
      expect.objectContaining({ id: 'target-1', status: 'available' }),
      expect.objectContaining({ id: 'target-2', status: 'selected' }),
    ]);
    expect(registry.listTargets('profile-2')).toEqual([
      expect.objectContaining({ id: 'target-3', status: 'selected' }),
    ]);
  });

  it('marks targets closed and clears a profile', () => {
    const registry = new BrowserTargetRegistry();
    registry.upsertTarget({
      id: 'target-1',
      profileId: 'profile-1',
      mode: 'session',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 1,
    });

    registry.markClosed('target-1');
    expect(registry.listTargets('profile-1')).toEqual([
      expect.objectContaining({ id: 'target-1', status: 'closed' }),
    ]);

    registry.clearProfile('profile-1');
    expect(registry.listTargets('profile-1')).toEqual([]);
  });
});
