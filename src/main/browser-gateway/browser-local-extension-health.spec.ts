import { describe, expect, it } from 'vitest';
import {
  describeLocalExtensionHealth,
  isLocalExtensionChannelProvablyDown,
  type BrowserLocalExtensionHealthInput,
} from './browser-local-extension-health';
import { BROWSER_EXTENSION_CONTACT_FRESH_MS } from './browser-extension-contact-state';

const NOW = 1_700_000_000_000;
const USER_DATA = '/tmp/aio-test-userdata';
const CHROME_DIR = '/tmp/aio-test-chrome/NativeMessagingHosts';
const WRAPPER = `${USER_DATA}/browser-gateway/native-host/ai-orchestrator-browser-host`;
const RUNTIME_CONFIG = `${USER_DATA}/browser-gateway/native-host/runtime.json`;
const SOCKET = '/tmp/aio-test-userdata/bg-abc123.sock';

function contactState(overrides: {
  lastContactAt?: number;
  extensionVersion?: string;
} = {}) {
  return {
    getLastExtensionContactAt: () => overrides.lastContactAt,
    isExtensionContactFresh: () =>
      overrides.lastContactAt !== undefined
      && NOW - overrides.lastContactAt <= BROWSER_EXTENSION_CONTACT_FRESH_MS,
    describeExtensionContact: () => ({ nodeId: 'local', silent: true }),
    getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
    getLastDisconnect: () => undefined,
    getExtensionRuntime: () =>
      overrides.extensionVersion ? { extensionVersion: overrides.extensionVersion } : undefined,
  };
}

function health(
  overrides: Partial<BrowserLocalExtensionHealthInput> & {
    existingPaths?: string[];
    installed?: boolean;
  } = {},
) {
  const existingPaths = new Set(
    overrides.existingPaths ?? [WRAPPER, RUNTIME_CONFIG, SOCKET],
  );
  return describeLocalExtensionHealth({
    userDataPath: USER_DATA,
    chromeNativeMessagingDir: CHROME_DIR,
    extensionContactState: contactState(),
    extensionCommandStore: {
      describeQueue: (queueKey) => ({
        queueKey,
        queuedCount: 0,
        inFlightCount: 0,
        waitingPollerCount: 1,
      }),
    },
    countSharedLocalTabs: () => 0,
    now: () => NOW,
    fileExists: (path) => existingPaths.has(path),
    readRuntimeSocketPath: () => (existingPaths.has(RUNTIME_CONFIG) ? SOCKET : undefined),
    manifestOwned: () => overrides.installed ?? true,
    ...overrides,
  });
}

describe('describeLocalExtensionHealth', () => {
  it('reports not_installed when this install owns no native-host manifest', () => {
    const result = health({ installed: false });

    expect(result.state).toBe('not_installed');
    expect(result.installed).toBe(false);
    expect(result.registered).toBe(false);
    expect(result.remediation).toContain('Install the Harness Chrome extension');
    expect(isLocalExtensionChannelProvablyDown(result)).toBe(true);
  });

  it('reports registration_broken with socket-specific repair when the socket is gone', () => {
    const result = health({ existingPaths: [WRAPPER, RUNTIME_CONFIG] });

    expect(result.state).toBe('registration_broken');
    expect(result.installed).toBe(true);
    expect(result.registered).toBe(false);
    // The stale-socket outage: an app restart moved the socket while a native
    // host process kept the old path.
    expect(result.remediation).toContain('socket that no longer exists');
    expect(isLocalExtensionChannelProvablyDown(result)).toBe(true);
  });

  it('reports registration_broken when the wrapper is missing', () => {
    const result = health({ existingPaths: [] });

    expect(result.state).toBe('registration_broken');
    expect(result.remediation).toContain('native-messaging host files are incomplete');
  });

  it('reports silent when the chain is intact but the extension never polled', () => {
    const result = health();

    expect(result.state).toBe('silent');
    expect(result.registered).toBe(true);
    expect(result.polling).toBe(false);
    expect(result.summary).toContain('no contact recorded');
    // A silent channel may be an MV3 service worker mid-recovery, so it must
    // NOT short-circuit the undelivered-wait that exists to ride that out.
    expect(isLocalExtensionChannelProvablyDown(result)).toBe(false);
  });

  it('reports silent once contact ages past the freshness window', () => {
    const result = health({
      extensionContactState: contactState({
        lastContactAt: NOW - BROWSER_EXTENSION_CONTACT_FRESH_MS - 1,
      }),
    });

    expect(result.state).toBe('silent');
    expect(result.contactAgeMs).toBe(BROWSER_EXTENSION_CONTACT_FRESH_MS + 1);
  });

  it('reports ready with the extension version while contact is fresh', () => {
    const result = health({
      extensionContactState: contactState({
        lastContactAt: NOW - 1_000,
        extensionVersion: '0.2.1',
      }),
      countSharedLocalTabs: () => 2,
    });

    expect(result.state).toBe('ready');
    expect(result.polling).toBe(true);
    expect(result.contactAgeMs).toBe(1_000);
    expect(result.extensionVersion).toBe('0.2.1');
    expect(result.sharedTabCount).toBe(2);
    expect(result.remediation).toBeUndefined();
    expect(isLocalExtensionChannelProvablyDown(result)).toBe(false);
  });

  it('reports queue load against the reserved local channel id', () => {
    const result = health({
      extensionCommandStore: {
        describeQueue: (queueKey) => ({
          queueKey,
          queuedCount: 3,
          inFlightCount: 1,
          waitingPollerCount: 0,
        }),
      },
    });

    expect(result.channelId).toBe('local');
    expect(result.queue).toEqual({ queuedCount: 3, inFlightCount: 1, waitingPollerCount: 0 });
  });
});
