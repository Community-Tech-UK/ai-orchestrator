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

  it('prefers a copy of the page Chrome can read over a newer unloaded one', () => {
    const unloaded = makeTab({
      targetId: 'unloaded',
      url: 'https://app.example.com/bins',
      textUnavailableReason: 'tab_discarded',
      updatedAt: 20,
    });
    const readable = makeTab({
      targetId: 'readable',
      url: 'https://app.example.com/bins',
      updatedAt: 10,
    });

    const result = findExistingTabCandidate(
      [unloaded, readable],
      'https://app.example.com/bins',
      undefined,
    );

    expect(result?.targetId).toBe('readable');
  });

  it('still prefers an exact URL match that cannot be read over another page on the site', () => {
    const unloadedExact = makeTab({
      targetId: 'unloaded-exact',
      url: 'https://app.example.com/bins',
      textUnavailableReason: 'host_permission_denied',
      updatedAt: 10,
    });
    const readableOtherPage = makeTab({
      targetId: 'readable-other-page',
      url: 'https://app.example.com/account',
      updatedAt: 20,
    });

    const result = findExistingTabCandidate(
      [readableOtherPage, unloadedExact],
      'https://app.example.com/bins',
      undefined,
    );

    expect(result?.targetId).toBe('unloaded-exact');
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
