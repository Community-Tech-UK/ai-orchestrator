import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HostStore, isSameEndpoint } from './host-store';
import type { PairedHost } from './models';

function host(overrides: Partial<PairedHost> = {}): PairedHost {
  return {
    id: 'device-1',
    name: 'macbook-pro',
    host: '100.68.10.5',
    port: 4879,
    token: 'token-1',
    addedAt: 1000,
    ...overrides,
  };
}

function store(): HostStore {
  TestBed.resetTestingModule();
  return TestBed.inject(HostStore);
}

describe('isSameEndpoint', () => {
  it('matches the same address and port regardless of casing or padding', () => {
    expect(isSameEndpoint({ host: '100.68.10.5', port: 4879 }, { host: '100.68.10.5', port: 4879 })).toBe(true);
    expect(isSameEndpoint({ host: 'Mac-Mini.tail.ts.net', port: 4879 }, { host: 'mac-mini.tail.ts.net ', port: 4879 })).toBe(true);
  });

  it('treats a different port or address as a different host', () => {
    expect(isSameEndpoint({ host: '100.68.10.5', port: 4879 }, { host: '100.68.10.5', port: 4880 })).toBe(false);
    expect(isSameEndpoint({ host: '100.68.10.5', port: 4879 }, { host: '100.68.10.9', port: 4879 })).toBe(false);
  });
});

describe('HostStore.addHost re-pairing', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  /**
   * The reported bug: every `/pair` mints a new deviceId, so re-pairing the same
   * Mac used to append a second entry and strand the expired one in the list
   * with no way to delete it.
   */
  it('replaces the expired entry when the same host is paired again', async () => {
    const s = store();
    await s.addHost(host({ id: 'old-device', token: 'expired', addedAt: 1000 }));
    await s.addHost(host({ id: 'new-device', token: 'fresh', addedAt: 5000 }));

    expect(s.hosts()).toHaveLength(1);
    expect(s.hosts()[0].id).toBe('new-device');
    expect(s.hosts()[0].token).toBe('fresh');
  });

  it('keeps the original pairing date — it is the same host, not a new one', async () => {
    const s = store();
    await s.addHost(host({ id: 'old-device', addedAt: 1000 }));
    await s.addHost(host({ id: 'new-device', addedAt: 5000 }));

    // Assert the collapse too: with the old append behaviour hosts()[0] was the
    // stale entry, which carries addedAt 1000 anyway and passed for free.
    expect(s.hosts()).toHaveLength(1);
    expect(s.hosts()[0].id).toBe('new-device');
    expect(s.hosts()[0].addedAt).toBe(1000);
  });

  it('moves the active selection onto the replacement', async () => {
    const s = store();
    await s.addHost(host({ id: 'old-device' }));
    await s.setActive('old-device');

    await s.addHost(host({ id: 'new-device' }));

    // Left pointing at the removed id, the app would have no active host at all.
    expect(s.activeId()).toBe('new-device');
    expect(s.activeHost()?.id).toBe('new-device');
  });

  it('leaves a genuinely different host alone', async () => {
    const s = store();
    await s.addHost(host({ id: 'mac', host: '100.68.10.5' }));
    await s.addHost(host({ id: 'linux-box', host: '100.124.239.43', name: 'amoracall-dev' }));

    expect(s.hosts().map((h) => h.id).sort()).toEqual(['linux-box', 'mac']);
  });

  it('collapses duplicates that an earlier build already stranded', async () => {
    const s = store();
    // Two dead entries for one machine, as the old append-only behaviour produced.
    await s.addHost(host({ id: 'dead-1', addedAt: 1000 }));
    await s.addHost(host({ id: 'dead-2', addedAt: 2000, port: 4880 }));
    await s.addHost(host({ id: 'dead-3', addedAt: 3000 }));
    expect(s.hosts().length).toBeGreaterThan(1);

    await s.addHost(host({ id: 'live', addedAt: 9000 }));

    // The 4880 entry is a different endpoint and legitimately survives.
    expect(s.hosts().map((h) => h.id).sort()).toEqual(['dead-2', 'live']);
  });
});

describe('HostStore.removeHost', () => {
  beforeEach(() => localStorage.clear());

  it('drops the host and repoints the active selection', async () => {
    const s = store();
    await s.addHost(host({ id: 'a', host: '100.0.0.1' }));
    await s.addHost(host({ id: 'b', host: '100.0.0.2' }));
    await s.setActive('b');

    await s.removeHost('b');

    expect(s.hosts().map((h) => h.id)).toEqual(['a']);
    expect(s.activeId()).toBe('a');
  });

  it('leaves no active host when the last one is removed', async () => {
    const s = store();
    await s.addHost(host({ id: 'only' }));
    await s.setActive('only');

    await s.removeHost('only');

    expect(s.hosts()).toEqual([]);
    expect(s.activeId()).toBeNull();
    expect(s.activeHost()).toBeNull();
  });
});
