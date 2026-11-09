import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { MobileSessionOwners } from './mobile-gateway-member-routes';
import { MOBILE_PROFILE_METADATA_KEY } from './mobile-gateway-session-visibility';

describe('MobileSessionOwners', () => {
  function setup() {
    const live = new Map<string, Instance>();
    const people = new Set(['owner', 'member']);
    const owners = new MobileSessionOwners(
      (instanceId) => live.get(instanceId),
      (profileId) => people.has(profileId),
    );
    const add = (id: string, profileId?: string) =>
      live.set(id, { id, metadata: profileId ? { [MOBILE_PROFILE_METADATA_KEY]: profileId } : {} } as Instance);
    return { live, people, owners, add };
  }

  it("remembers a removed session's person until told to forget it", () => {
    const { live, owners, add } = setup();
    add('member-session', 'member');

    expect(owners.profileOf('member-session')).toBe('member');
    live.delete('member-session');
    expect(owners.profileOf('member-session')).toBe('member');
    expect(owners.owns('member', 'member-session')).toBe(false);

    owners.forget('member-session');
    expect(owners.profileOf('member-session')).toBe('owner');
  });

  it('gives unstamped sessions and those of a removed person to the owner', () => {
    const { people, owners, add } = setup();
    add('desktop-session');
    add('member-session', 'member');

    expect(owners.profileOf('desktop-session')).toBe('owner');
    people.delete('member');
    expect(owners.profileOf('member-session')).toBe('owner');
    expect(owners.owns('owner', 'member-session')).toBe(true);
  });
});
