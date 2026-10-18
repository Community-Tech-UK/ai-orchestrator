import { describe, expect, it } from 'vitest';
import {
  BrowserCreateAgentCredentialRequestSchema,
  BrowserFillHttpAuthRequestSchema,
} from '../browser-form-fill.schemas';

describe('BrowserCreateAgentCredentialRequestSchema', () => {
  it('accepts non-secret vault metadata and rejects model-supplied passwords', () => {
    const request = {
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      itemTitle: 'Instagram — 12 Steps',
      loginUri: 'https://www.instagram.com/',
      username: '12steps.life',
    };

    expect(BrowserCreateAgentCredentialRequestSchema.parse(request)).toEqual(request);
    expect(() => BrowserCreateAgentCredentialRequestSchema.parse({
      ...request,
      password: 'TEST_ONLY_MODEL_SUPPLIED_SECRET',
    })).toThrow();
    expect(() => BrowserCreateAgentCredentialRequestSchema.parse({
      ...request,
      loginUri: 'not-a-url',
    })).toThrow();
  });
});

describe('BrowserFillHttpAuthRequestSchema', () => {
  const request = {
    profileId: 'existing-tab:n.windows-pc:7:42',
    targetId: 'existing-tab:n.windows-pc:7:42:target',
    vaultItemRef: 'opaque-vault-ref',
  };

  it('accepts the opaque references and an optional url', () => {
    expect(BrowserFillHttpAuthRequestSchema.parse(request)).toEqual(request);
    expect(BrowserFillHttpAuthRequestSchema.parse({
      ...request,
      url: 'https://portal.example.gov.uk/admin/report',
    })).toEqual({
      ...request,
      url: 'https://portal.example.gov.uk/admin/report',
    });
  });

  it('is strict: no origin field and no credential values may be supplied', () => {
    // The receiving origin comes from `url` + the live tab, never the caller.
    expect(() => BrowserFillHttpAuthRequestSchema.parse({
      ...request,
      origin: 'https://portal.example.gov.uk',
    })).toThrow();
    expect(() => BrowserFillHttpAuthRequestSchema.parse({
      ...request,
      username: 'test-only-user',
      password: 'TEST_ONLY_MODEL_SUPPLIED_SECRET',
    })).toThrow();
    expect(() => BrowserFillHttpAuthRequestSchema.parse({
      ...request,
      url: 'not-a-url',
    })).toThrow();
    expect(() => BrowserFillHttpAuthRequestSchema.parse({
      profileId: 'p',
      targetId: 't',
    })).toThrow();
  });
});
