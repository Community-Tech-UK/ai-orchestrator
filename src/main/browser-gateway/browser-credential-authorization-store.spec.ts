import { describe, expect, it } from 'vitest';
import {
  CredentialAuthorizationService,
  InMemoryCredentialAuthorizationStore,
  MAX_AUTHORIZATION_LIFETIME_MS,
  assertAuthorizationExpiry,
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

  it('returns the declared one-time-code senders on the authorized decision', () => {
    // The fill path needs these to accept a shared notification platform (GOV.UK
    // Notify) whose domain is unrelated to the service's own.
    const { service } = makeService();
    service.create(
      {
        ...baseAuth(),
        purposes: ['login', 'email_code'],
        allowedSenderDomains: ['notifications.service.gov.uk'],
      },
      'auth-notify',
    );
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'email_code',
      }),
    ).toEqual({
      authorized: true,
      authorizationId: 'auth-notify',
      allowedSenderDomains: ['notifications.service.gov.uk'],
    });
  });

  it('omits the sender list when the authorization declares none', () => {
    const { service } = makeService();
    service.create({ ...baseAuth(), purposes: ['email_code'] }, 'auth-plain');
    const decision = service.check({
      profileId: 'profile-1',
      origin: 'https://portal.example.gov.uk',
      purpose: 'email_code',
    });
    expect(decision.authorized).toBe(true);
    expect(decision).not.toHaveProperty('allowedSenderDomains');
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

describe('CredentialAuthorizationService.check — secret_fill binding', () => {
  function secretFillAuth(overrides: Partial<CredentialAuthorization> = {}) {
    const { service } = makeService();
    service.create(
      {
        ...baseAuth(),
        purposes: ['secret_fill'],
        allowedSecretTypes: ['bank_account_number', 'iban'],
        ...overrides,
      },
      'auth-1',
    );
    return service;
  }

  it('authorizes a secret_fill for a permitted secret type', () => {
    const service = secretFillAuth();
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
        secretType: 'iban',
      }).authorized,
    ).toBe(true);
  });

  it('refuses a secret type not on the authorization', () => {
    const service = secretFillAuth();
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
        secretType: 'tax_identifier',
      }),
    ).toMatchObject({ authorized: false, reason: 'secret_type_not_authorized' });
  });

  it('refuses a secret_fill with no secret type at all', () => {
    const service = secretFillAuth();
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
      }),
    ).toMatchObject({ authorized: false, reason: 'secret_type_not_authorized' });
  });

  it('enforces a selector allowlist when present', () => {
    const service = secretFillAuth({ allowedSelectors: ['#iban'] });
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
        secretType: 'iban',
        selector: '#iban',
      }).authorized,
    ).toBe(true);
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
        secretType: 'iban',
        selector: '#somewhere-else',
      }),
    ).toMatchObject({ authorized: false, reason: 'selector_not_authorized' });
  });

  it('does not let a login authorization satisfy a secret_fill check', () => {
    const { service } = makeService();
    service.create(baseAuth(), 'auth-login'); // purposes: login/register only
    expect(
      service.check({
        profileId: 'profile-1',
        origin: 'https://portal.example.gov.uk',
        purpose: 'secret_fill',
        secretType: 'iban',
      }),
    ).toMatchObject({ authorized: false, reason: 'purpose_not_authorized' });
  });
});

describe('assertAuthorizationExpiry', () => {
  // Extracted here 2026-08-29 because there are now two doors onto
  // authorization creation: the renderer IPC handler and the privileged
  // `aio-mcp browser-credentials authorize` CLI. A duplicated bound would drift
  // and leave one door able to mint a grant the other refuses.
  const NOW = 1_700_000_000_000;
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it('exports the one-year cap both doors share', () => {
    expect(MAX_AUTHORIZATION_LIFETIME_MS).toBe(YEAR_MS);
  });

  it('accepts an expiry in the future and inside the cap', () => {
    expect(() => assertAuthorizationExpiry(NOW + 1, NOW)).not.toThrow();
    expect(() => assertAuthorizationExpiry(NOW + 90 * 24 * 60 * 60 * 1000, NOW)).not.toThrow();
    expect(() => assertAuthorizationExpiry(NOW + YEAR_MS, NOW)).not.toThrow();
  });

  it('refuses an expiry in the past or exactly now', () => {
    expect(() => assertAuthorizationExpiry(NOW, NOW)).toThrow(/must be in the future/);
    expect(() => assertAuthorizationExpiry(NOW - 1, NOW)).toThrow(/must be in the future/);
  });

  it('refuses standing consent beyond a year', () => {
    expect(() => assertAuthorizationExpiry(NOW + YEAR_MS + 1, NOW))
      .toThrow(/more than 1 year/);
  });
});
