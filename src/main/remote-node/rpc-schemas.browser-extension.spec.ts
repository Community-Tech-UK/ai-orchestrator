import { describe, expect, it } from 'vitest';
import { BrowserExtAttachTabParamsSchema, RPC_PARAM_SCHEMAS, validateRpcParams } from './rpc-schemas';

const PROFILE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tab = { tabId: 42, windowId: 7, url: 'https://example.test/page' };

describe('browser extension attach-tab relay params', () => {
  it('is the schema the router applies to browser.ext.attachTab', () => {
    expect(RPC_PARAM_SCHEMAS['browser.ext.attachTab']).toBe(BrowserExtAttachTabParamsSchema);
  });

  it('keeps the Chrome profile id the relay sends beside the payload', () => {
    const parsed = validateRpcParams(BrowserExtAttachTabParamsSchema, {
      extensionVersion: '0.2.42',
      extensionStartedAt: 1,
      extensionInstanceId: PROFILE,
      payload: tab,
    });
    expect(parsed).toMatchObject({ extensionInstanceId: PROFILE, payload: tab });
  });

  it('accepts and drops an id nested in the payload by an older relay', () => {
    // A new native host behind a not-yet-restarted relay: the strict tab schema
    // must not reject every report from that worker.
    const parsed = validateRpcParams(BrowserExtAttachTabParamsSchema, {
      extensionVersion: '0.2.42',
      payload: { ...tab, extensionInstanceId: PROFILE },
    });
    expect(parsed.payload).toEqual(tab);
    expect(parsed).not.toHaveProperty('extensionInstanceId');
  });

  it('still rejects any other unknown tab field', () => {
    expect(() => validateRpcParams(BrowserExtAttachTabParamsSchema, {
      payload: { ...tab, somethingElse: true },
    })).toThrow();
  });
});
