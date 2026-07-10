import { describe, expect, it } from 'vitest';
import {
  CredentialAuthorizationService,
  InMemoryCredentialAuthorizationStore,
  type CredentialAuthorization,
} from './browser-credential-authorization-store';

function makeService(now = 1_000) {
  const store = new InMemoryCredentialAuthorizationStore();
  const service = new CredentialAuthorizationService(store, () => now);
  return { store, service };
}

function baseAuth(): Omit<CredentialAuthorization, 'id' | 'createdAt'> {
  return {
    profileId: 'profile-1',
    allowedOrigins: [
      { scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false },
    ],
    purposes: ['login', 'register'],
    vaultFolder: 'AIO-Agent',
    expiresAt: 1_000_000,
  };
}

describe('CredentialAuthorizationService.check', () => {
  it('authorizes a live, unrevoked, matching profile+origin+purpose', () => {
    const { service } = makeService();
    const auth = service.create(baseAuth(), 'auth-1');
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'login',
      }),
    ).toEqual({ authorized: true, authorizationId: auth.id });
  });

  it('authorizes a shared-tab node scope profile the same as a managed profile', () => {
    // Shared-tab fills key the check by the tab's stable node scope ('local' or
    // a nodeId), not its ephemeral existing-tab profileId. check() is
    // profile-agnostic, so a node-scoped authorization resolves exactly like a
    // managed one.
    const { service } = makeService();
    const auth = service.create({ ...baseAuth(), profileId: 'local' }, 'auth-local');
    expect(
      service.check({ profileId: 'local', origin: 'https://portal.example.gov.uk', purpose: 'login' }),
    ).toEqual({ authorized: true, authorizationId: auth.id });
    // A different node scope must NOT inherit it.
    expect(
      service.check({ profileId: 'node-7', origin: 'https://portal.example.gov.uk', purpose: 'login' }),
    ).toMatchObject({ authorized: false, reason: 'no_authorization_for_profile' });
  });

  it('denies when the profile has no authorization', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-1');
    expect(
      service.check({ profileId: 'other', origin: 'https://portal.example.gov.uk', purpose: 'login' }),
    ).toMatchObject({ authorized: false, reason: 'no_authorization_for_profile' });
  });

  it('denies an origin outside the authorized set', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-1');
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://evil.example', purpose: 'login' }),
    ).toMatchObject({ authorized: false, reason: 'origin_not_authorized' });
  });

  it('denies a purpose the authorization does not cover', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-1');
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://portal.example.gov.uk', purpose: 'totp' }),
    ).toMatchObject({ authorized: false, reason: 'purpose_not_authorized' });
  });

  it('denies an expired authorization', () => {
    const { service } = makeService();
    service.create({ ...baseAuth(), expiresAt: 500 }, 'auth-1');
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'login',
        now: 2_000,
      }),
    ).toMatchObject({ authorized: false, reason: 'authorization_expired' });
  });

  it('denies after revocation', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-1');
    service.revoke('auth-1');
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://portal.example.gov.uk', purpose: 'login' }),
    ).toMatchObject({ authorized: false });
  });

  it('matches subdomains only when includeSubdomains (or a wildcard pattern) is set', () => {
    const { service } = makeService();
    service.create(
      {
        ...baseAuth(),
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'example.gov.uk', includeSubdomains: true },
        ],
      },
      'auth-1',
    );
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://tenders.example.gov.uk', purpose: 'login' })
        .authorized,
    ).toBe(true);
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://example.gov.uk', purpose: 'login' })
        .authorized,
    ).toBe(true);
  });

  it('does not match a different scheme', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-1');
    expect(
      service.check({ profileId: 'profile-1', origin: 'http://portal.example.gov.uk', purpose: 'login' })
        .authorized,
    ).toBe(false);
  });

  it('does not treat a lookalike suffix as a subdomain match', () => {
    const { service } = makeService();
    service.create(
      {
        ...baseAuth(),
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'example.gov.uk', includeSubdomains: true },
        ],
      },
      'auth-1',
    );
    // notexample.gov.uk must NOT match example.gov.uk
    expect(
      service.check({ profileId: 'profile-1', origin: 'https://notexample.gov.uk', purpose: 'login' })
        .authorized,
    ).toBe(false);
  });
});
