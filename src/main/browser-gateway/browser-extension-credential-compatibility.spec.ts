import { describe, expect, it, vi } from 'vitest';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import {
  confirmBrowserExtensionCredentialWrite,
  isExactSecureCredentialWriteCompletion,
  supportsSecureBrowserExtensionCredentialFill,
} from './browser-extension-credential-compatibility';

function contactState(
  extensionVersion: string | undefined,
  fresh = true,
  extensionStartedAt: number | null = 1_000,
): BrowserExtensionContactStateReader {
  return {
    getLastExtensionContactAt: vi.fn(() => Date.now()),
    isExtensionContactFresh: vi.fn(() => fresh),
    describeExtensionContact: vi.fn((nodeId: string) => ({
      nodeId,
      lastContactAt: Date.now(),
      silent: !fresh,
    })),
    getContactGapStats: vi.fn(() => ({ gapCount: 0, longestGapMs: 0 })),
    getExtensionRuntime: vi.fn(() => extensionVersion || extensionStartedAt !== null
      ? {
          ...(extensionVersion ? { extensionVersion } : {}),
          ...(extensionStartedAt !== null ? { extensionStartedAt } : {}),
        }
      : undefined),
  };
}

describe('browser extension credential compatibility', () => {
  it.each(['0.2.18', '0.3.0', '1.0.0'])(
    'accepts a fresh secure extension runtime at %s',
    (version) => {
      expect(supportsSecureBrowserExtensionCredentialFill(contactState(version), 'local'))
        .toBe(true);
    },
  );

  it.each([
    ['old', '0.2.17', true, 1_000],
    ['prerelease floor', '0.2.18-rc.1', true, 1_000],
    ['malformed', 'not-a-version', true, 1_000],
    ['missing', undefined, true, 1_000],
    ['missing generation', '0.2.18', true, null],
    ['negative generation', '0.2.18', true, -1],
    ['fractional generation', '0.2.18', true, 1.5],
    ['stale', '0.2.18', false, 1_000],
  ])('rejects a %s extension runtime', (_case, version, fresh, startedAt) => {
    expect(
      supportsSecureBrowserExtensionCredentialFill(
        contactState(version, fresh, startedAt),
        'local',
      ),
    ).toBe(false);
  });

  it('reads runtime evidence from the exact remote contact channel', () => {
    const state = contactState('0.2.18');
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc')).toBe(true);
    expect(state.getExtensionRuntime).toHaveBeenCalledWith('windows-pc');
  });

  it('accepts only the exact fixed two-field taint completion', () => {
    const exact = {
      completed: true,
      observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
    };
    expect(isExactSecureCredentialWriteCompletion(exact)).toBe(true);
    expect(isExactSecureCredentialWriteCompletion({ ...exact, valueApplied: true })).toBe(false);
    expect(isExactSecureCredentialWriteCompletion({ valueApplied: true })).toBe(false);
    expect(isExactSecureCredentialWriteCompletion(null)).toBe(false);
    expect(isExactSecureCredentialWriteCompletion([])).toBe(false);
  });

  it('confirms public and sensitive writes through distinct fail-closed contracts', () => {
    const exact = {
      completed: true,
      observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
    };
    expect(confirmBrowserExtensionCredentialWrite({ valueApplied: true }, 'public')).toBe(true);
    expect(confirmBrowserExtensionCredentialWrite(exact, 'public')).toBe(true);
    expect(confirmBrowserExtensionCredentialWrite(exact, 'password')).toBe(true);
    expect(() => confirmBrowserExtensionCredentialWrite({ valueApplied: true }, 'password'))
      .toThrow('shared_tab_secure_credential_write_not_confirmed');
    expect(() => confirmBrowserExtensionCredentialWrite({ ...exact, valueApplied: true }, 'public'))
      .toThrow('shared_tab_public_credential_write_not_confirmed');
  });
});
