import { describe, expect, it } from 'vitest';
import {
  BrowserCreateCredentialAuthorizationRequestSchema,
  BrowserEnrolCredentialRequestSchema,
} from '../browser-unattended.schemas';

describe('BrowserEnrolCredentialRequestSchema', () => {
  const valid = {
    item: 'Report MI - RM6094 Spark DPS (GCA)',
    origin: 'https://auth.reportmi.gca.gov.uk',
  };

  it('accepts an item name or id plus an origin', () => {
    expect(BrowserEnrolCredentialRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      BrowserEnrolCredentialRequestSchema.safeParse({ ...valid, moveIntoFolder: true }).success,
    ).toBe(true);
  });

  it('requires a real URL origin, not a bare host', () => {
    expect(
      BrowserEnrolCredentialRequestSchema.safeParse({ ...valid, origin: 'auth.reportmi.gca.gov.uk' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty item and unknown keys', () => {
    expect(BrowserEnrolCredentialRequestSchema.safeParse({ ...valid, item: '' }).success).toBe(false);
    expect(
      BrowserEnrolCredentialRequestSchema.safeParse({ ...valid, vaultFolder: 'Personal' }).success,
    ).toBe(false);
  });

  it('never accepts a password field — the secret must not cross IPC', () => {
    expect(
      BrowserEnrolCredentialRequestSchema.safeParse({ ...valid, password: 'hunter2' }).success,
    ).toBe(false);
  });
});

describe('BrowserCreateCredentialAuthorizationRequestSchema allowedSenderDomains', () => {
  const base = {
    profileId: 'windows-pc',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'gca.gov.uk', includeSubdomains: true }],
    purposes: ['login', 'email_code'],
    vaultFolder: 'AIO-Agent',
    expiresAt: Date.now() + 86_400_000,
  };

  it('is optional and accepts declared senders', () => {
    expect(BrowserCreateCredentialAuthorizationRequestSchema.safeParse(base).success).toBe(true);
    expect(
      BrowserCreateCredentialAuthorizationRequestSchema.safeParse({
        ...base,
        allowedSenderDomains: ['notifications.service.gov.uk'],
      }).success,
    ).toBe(true);
  });

  it('rejects empty entries and an unbounded list', () => {
    expect(
      BrowserCreateCredentialAuthorizationRequestSchema.safeParse({
        ...base,
        allowedSenderDomains: [''],
      }).success,
    ).toBe(false);
    expect(
      BrowserCreateCredentialAuthorizationRequestSchema.safeParse({
        ...base,
        allowedSenderDomains: Array.from({ length: 11 }, (_, i) => `sender-${i}.example`),
      }).success,
    ).toBe(false);
  });
});
