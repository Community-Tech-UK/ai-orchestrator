import { describe, expect, it } from 'vitest';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';

const target = { profileId: 'profile-1', targetId: 'target-1' };
const reason = 'Placing the order you asked for';

describe('a tool call that says why', () => {
  it.each([
    ['browser.click', { selector: '#buy' }],
    ['browser.type', { selector: '#name', value: 'Ada' }],
    ['browser.select', { selector: '#size', value: 'm' }],
    ['browser.fill_form', { fields: [{ selector: '#a', value: 'b' }] }],
    ['browser.evaluate', { expression: 'document.title' }],
    ['browser.navigate', { url: 'https://example.com/next' }],
    ['browser.close_tab', {}],
    ['browser.press_key', { key: 'Enter' }],
    ['browser.upload_file', { selector: '#file', filePath: '/tmp/example.txt' }],
    ['browser.download_file', { selector: '#download' }],
    ['browser.request_grant', {
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [{ scheme: 'https', hostPattern: 'shop.example.com', includeSubdomains: false }],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    }],
  ])('%s keeps the reason through validation', (method, extra) => {
    const payload = validateBrowserRpcPayload(method, { ...target, ...extra, reason });
    expect(payload['reason']).toBe(reason);
  });

  it('refuses a reason that is empty or too long, instead of dropping it', () => {
    expect(() => validateBrowserRpcPayload('browser.click', { ...target, selector: '#buy', reason: '' })).toThrow();
    expect(() => validateBrowserRpcPayload('browser.click', { ...target, selector: '#buy', reason: 'x'.repeat(1001) })).toThrow();
  });

  it('quietly drops a reason on a read-only tool, which never raises an approval', () => {
    expect(validateBrowserRpcPayload('browser.snapshot', { ...target, reason })).not.toHaveProperty('reason');
  });
});
