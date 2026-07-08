import { describe, expect, it } from 'vitest';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { findExistingTabCandidate } from './browser-gateway-target-utils';

describe('findExistingTabCandidate', () => {
  it('does not treat a cross-origin URL prefix as a match', () => {
    const spoofed = makeTab({
      targetId: 'spoofed',
      url: 'https://app.example.com.evil/session',
      origin: 'https://app.example.com.evil',
      updatedAt: 20,
    });
    const sameOrigin = makeTab({
      targetId: 'same-origin',
      url: 'https://app.example.com/dashboard',
      origin: 'https://app.example.com',
      updatedAt: 10,
    });

    const result = findExistingTabCandidate(
      [spoofed, sameOrigin],
      'https://app.example.com',
      undefined,
    );

    expect(result?.targetId).toBe('same-origin');
  });

  it('still accepts same-origin URL prefixes before falling back to origin only', () => {
    const prefixMatch = makeTab({
      targetId: 'prefix',
      url: 'https://app.example.com/dashboard/settings',
      origin: 'https://app.example.com',
      updatedAt: 10,
    });
    const newerOriginOnly = makeTab({
      targetId: 'origin',
      url: 'https://app.example.com/account',
      origin: 'https://app.example.com',
      updatedAt: 20,
    });

    const result = findExistingTabCandidate(
      [newerOriginOnly, prefixMatch],
      'https://app.example.com/dashboard',
      undefined,
    );

    expect(result?.targetId).toBe('prefix');
  });
});

function makeTab(
  overrides: Partial<BrowserExistingTabAttachment>,
): BrowserExistingTabAttachment {
  return {
    profileId: 'existing-tab:1:1',
    targetId: 'existing-tab:1:1:target',
    tabId: 1,
    windowId: 1,
    title: 'Tab',
    url: 'https://app.example.com',
    origin: 'https://app.example.com',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'app.example.com', includeSubdomains: false }],
    attachedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
