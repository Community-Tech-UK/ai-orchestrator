import { describe, expect, it } from 'vitest';
import * as path from 'path';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserProfileRegistry } from './browser-profile-registry';

class MemoryProfileStore {
  private profiles: BrowserProfile[] = [];

  listProfiles(): BrowserProfile[] {
    return [...this.profiles];
  }

  createProfile(input: {
    id?: string;
    label: string;
    mode: BrowserProfile['mode'];
    browser: BrowserProfile['browser'];
    allowedOrigins: BrowserProfile['allowedOrigins'];
    defaultUrl?: string;
    userDataDir?: string;
  }): BrowserProfile {
    const profile: BrowserProfile = {
      id: input.id ?? `profile-${this.profiles.length + 1}`,
      label: input.label,
      mode: input.mode,
      browser: input.browser,
      userDataDir: input.userDataDir,
      allowedOrigins: input.allowedOrigins,
      defaultUrl: input.defaultUrl,
      status: 'stopped',
      createdAt: 1,
      updatedAt: 1,
    };
    this.profiles.push(profile);
    return profile;
  }
}

describe('BrowserProfileRegistry', () => {
  it('resolves managed profile directories under userData/browser-profiles', () => {
    const registry = new BrowserProfileRegistry({
      store: new MemoryProfileStore(),
      userDataPath: '/tmp/orchestrator-user-data',
    });

    expect(registry.resolveProfileDir('profile-1')).toBe(
      path.join('/tmp/orchestrator-user-data', 'browser-profiles', 'profile-1'),
    );
  });

  it('rejects path traversal and absolute profile directories outside the managed root', () => {
    const registry = new BrowserProfileRegistry({
      store: new MemoryProfileStore(),
      userDataPath: '/tmp/orchestrator-user-data',
    });

    expect(() => registry.resolveProfileDir('../escape')).toThrow(/outside managed browser profile root/);
    expect(() => registry.resolveProfileDir('/tmp/outside')).toThrow(/outside managed browser profile root/);
  });

  it('rejects empty and duplicate labels case-insensitively', () => {
    const store = new MemoryProfileStore();
    const registry = new BrowserProfileRegistry({
      store,
      userDataPath: '/tmp/orchestrator-user-data',
    });

    expect(() =>
      registry.createProfile({
        label: '  ',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
      }),
    ).toThrow(/label is required/);

    registry.createProfile({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
    });
    expect(store.listProfiles()[0]?.userDataDir).toMatch(
      /\/tmp\/orchestrator-user-data\/browser-profiles\//,
    );

    expect(() =>
      registry.createProfile({
        label: 'google play',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
      }),
    ).toThrow(/already exists/);
  });
});
