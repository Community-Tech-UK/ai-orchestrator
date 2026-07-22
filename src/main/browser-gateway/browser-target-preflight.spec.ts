import { describe, expect, it } from 'vitest';
import type { BrowserTarget } from '@contracts/types/browser';
import {
  identifyBrowserTarget,
  selectBrowserTargetForUrl,
} from './browser-target-preflight';

const URL = 'https://procontract.example/activities/PA23-07A';

function target(overrides: Partial<BrowserTarget> = {}): BrowserTarget {
  return {
    id: 'target-1',
    mode: 'existing-tab',
    driver: 'extension',
    status: 'available',
    lastSeenAt: 1_000,
    url: URL,
    ...overrides,
  };
}

describe('identifyBrowserTarget', () => {
  it('distinguishes local extension, remote extension, and managed profiles', () => {
    expect(identifyBrowserTarget(target())).toEqual({
      channel: 'local-extension',
      computer: 'local',
      usesRealUserSession: true,
    });
    expect(identifyBrowserTarget(target({ nodeId: 'node-1', nodeName: 'windows-pc' }))).toEqual({
      channel: 'remote-extension',
      computer: 'windows-pc',
      usesRealUserSession: true,
    });
    expect(identifyBrowserTarget(target({ driver: 'cdp', mode: 'session' }))).toMatchObject({
      channel: 'managed-profile',
      usesRealUserSession: false,
    });
  });
});

describe('selectBrowserTargetForUrl', () => {
  it('prefers the exact-origin real session and explains each rejection', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [
        target({ id: 'other-site', url: 'https://example.com/' }),
        target({ id: 'managed', driver: 'cdp', mode: 'session' }),
        target({ id: 'wanted', lastSeenAt: 5_000 }),
      ],
    });

    expect(result.selected).toMatchObject({
      targetId: 'wanted',
      channel: 'local-extension',
      computer: 'local',
      usesRealUserSession: true,
    });
    expect(result.rejected.map((entry) => [entry.targetId, entry.reason])).toEqual([
      ['other-site', 'different_origin'],
      ['managed', 'managed_profile_is_not_the_user_session'],
    ]);
    expect(
      result.rejected.find((entry) => entry.targetId === 'managed')?.explanation,
    ).toContain('usually signed out');
  });

  it('never silently falls back from the local Mac to a managed profile', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [target({ id: 'managed', driver: 'cdp', mode: 'session' })],
      requestedComputer: { localOnly: true },
    });

    expect(result.selected).toBeNull();
    expect(result.summary).toContain('managed_profile_is_not_the_user_session');
  });

  it('never silently falls back from the local Mac to a remote node', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [target({ id: 'remote', nodeId: 'node-1', nodeName: 'windows-pc' })],
      requestedComputer: { localOnly: true },
    });

    expect(result.selected).toBeNull();
    expect(result.rejected[0]).toMatchObject({
      targetId: 'remote',
      reason: 'different_computer',
      computer: 'windows-pc',
    });
  });

  it('rejects a stale target rather than handing back a tab that may be gone', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [target({ id: 'stale', stale: true })],
    });

    expect(result.selected).toBeNull();
    expect(result.rejected[0]).toMatchObject({ reason: 'channel_stale' });
    expect(result.rejected[0]!.explanation).toContain('refresh');
  });

  it('accepts a same-host tab but ranks an exact-origin tab above it', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [
        target({ id: 'same-host', url: 'http://procontract.example/other' }),
        target({ id: 'exact', url: 'https://procontract.example/home' }),
      ],
    });

    expect(result.selected?.targetId).toBe('exact');
  });

  it('tells the caller to share or open a tab when nothing exists at all', () => {
    const result = selectBrowserTargetForUrl({ url: URL, targets: [] });

    expect(result.selected).toBeNull();
    expect(result.rejected).toEqual([]);
    expect(result.summary).toContain('share the tab');
  });

  it('skips closed and errored tabs', () => {
    const result = selectBrowserTargetForUrl({
      url: URL,
      targets: [
        target({ id: 'closed', status: 'closed' }),
        target({ id: 'errored', status: 'error' }),
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.rejected.every((entry) => entry.reason === 'not_available')).toBe(true);
  });
});
