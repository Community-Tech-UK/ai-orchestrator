import { describe, expect, it } from 'vitest';
import { BrowserCreateAgentCredentialRequestSchema } from '../browser-form-fill.schemas';

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
