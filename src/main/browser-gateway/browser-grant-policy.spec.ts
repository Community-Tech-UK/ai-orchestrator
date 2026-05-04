import { describe, expect, it } from 'vitest';
import type { BrowserPermissionGrant } from '@contracts/types/browser';
import { findMatchingBrowserGrant } from './browser-grant-policy';

function grant(overrides: Partial<BrowserPermissionGrant> = {}): BrowserPermissionGrant {
  return {
    id: 'grant-1',
    mode: 'session',
    instanceId: 'instance-1',
    provider: 'copilot',
    profileId: 'profile-1',
    allowedOrigins: [
      {
        scheme: 'https',
        hostPattern: 'play.google.com',
        includeSubdomains: true,
      },
    ],
    allowedActionClasses: ['input'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'user',
    decidedBy: 'user',
    decision: 'allow',
    expiresAt: 10_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('browser-grant-policy', () => {
  it('matches only active grants for the same instance profile origin and action class', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).grant?.id,
    ).toBe('grant-1');

    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'other',
        provider: 'copilot',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');

    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        provider: 'claude',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });

  it('rejects expired revoked consumed and unsafe autonomous grants', () => {
    for (const candidate of [
      grant({ expiresAt: 1_999 }),
      grant({ revokedAt: 1_500 }),
      grant({ consumedAt: 1_500 }),
      grant({ autonomous: true, allowedActionClasses: ['input'] }),
    ]) {
      expect(
        findMatchingBrowserGrant({
          grants: [candidate],
          instanceId: 'instance-1',
          profileId: 'profile-1',
          origin: 'https://play.google.com',
          actionClass: 'submit',
          autonomousRequired: true,
          now: 2_000,
        }).grant,
      ).toBeUndefined();
    }
  });

  it('requires explicit autonomous dangerous action classes', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [
          grant({
            mode: 'autonomous',
            autonomous: true,
            allowedActionClasses: ['input', 'submit'],
          }),
        ],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'submit',
        autonomousRequired: true,
        now: 2_000,
      }).grant?.id,
    ).toBe('grant-1');

    expect(
      findMatchingBrowserGrant({
        grants: [
          grant({
            mode: 'autonomous',
            autonomous: true,
            allowedActionClasses: ['input'],
          }),
        ],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'submit',
        autonomousRequired: true,
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });

  it('stops when the live origin no longer matches the classified origin', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        liveOrigin: 'https://evil.example',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('origin_changed_before_execution');
  });
});
