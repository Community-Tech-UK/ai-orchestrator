import { describe, expect, it } from 'vitest';
import { browserGrantLabels } from './browser-grant-labels';

describe('browser grant and request labels', () => {
  it('uses the first allowed site with wildcard and port scope', () => {
    expect(browserGrantLabels.site({ allowedOrigins: [
      { scheme: 'https', hostPattern: 'example.com', includeSubdomains: true, port: 8443 },
      { scheme: 'https', hostPattern: 'second.example.com', includeSubdomains: false },
    ] })).toBe('*.example.com:8443');
    expect(browserGrantLabels.site({ allowedOrigins: [] })).toBe('All sites');
  });

  it.each([
    ['browser.click', 'Click on a page'],
    ['browser.type', 'Type into a page'],
    ['browser.upload_file', 'Upload a file'],
    ['browser.fill_form', 'Fill in a form'],
    ['browser.request_user_login', 'Check a page login'],
    ['browser.unknown_future_tool', 'Use a browser page'],
  ])('gives %s a readable action', (toolName, label) => {
    expect(browserGrantLabels.action(toolName)).toBe(label);
  });

  it('names a pending new-login request for what it allows, and a saved-login one as before', () => {
    const access = (purposes: ('login' | 'register')[]) => ({
      toolName: 'browser.request_credential_access',
      credentialAccess: {
        taskScope: 'conversation:placeholder', sessionName: 'Example session', reason: 'Example reason',
        origin: 'https://example.com', computerName: 'Example computer', computerId: 'placeholder-computer',
        scope: 'placeholder-scope', vaultFolder: 'AIO-Agent', moveIntoFolder: false, purposes, permission: 'task' as const,
      },
    });
    expect(browserGrantLabels.request(access(['register']))).toBe('Create a new login');
    expect(browserGrantLabels.request(access(['login']))).toBe('Use saved login details');
    expect(browserGrantLabels.request({ toolName: 'browser.click' })).toBe('Click on a page');
  });
});
