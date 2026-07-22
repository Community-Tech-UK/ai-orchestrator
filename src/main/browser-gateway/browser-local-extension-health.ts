import * as fs from 'node:fs';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
  BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
  describeBrowserExtensionContact,
  type BrowserExtensionContactGapStats,
  type BrowserExtensionContactStateReader,
  type BrowserExtensionDisconnectRecord,
} from './browser-extension-contact-state';
import type {
  BrowserExtensionCommandStore,
  BrowserExtensionQueueSnapshot,
} from './browser-extension-command-store';
import {
  browserExtensionNativeHostPaths,
  isBrowserExtensionNativeHostManifestOwned,
} from './browser-extension-native-runtime';
import { getBrowserExtensionCommandStore } from './browser-extension-command-store';
import { getBrowserExtensionContactState } from './browser-extension-contact-state';
import { getBrowserExtensionTabStore } from './browser-extension-tab-store';

/**
 * Health for the AIO host's OWN Chrome extension session.
 *
 * The local channel used to be entirely invisible: contact was never recorded,
 * health only enumerated worker nodes, and `list_targets` returned the same
 * empty array whether the extension was absent, installed-but-silent, or
 * healthy with nothing shared. This module makes those three states
 * distinguishable and attaches an exact repair for each.
 */

export type BrowserLocalExtensionChannelState =
  /** The probe could not run (no resolved user-data path yet). Never treated as a failure. */
  | 'unknown'
  /** No native-host registration this install owns — the extension was never set up here. */
  | 'not_installed'
  /** Registered, but the chain (wrapper → runtime config → socket) is provably broken. */
  | 'registration_broken'
  /** Registered and intact, but the extension has never polled or has gone silent. */
  | 'silent'
  /** Polling within the freshness window. */
  | 'ready';

export interface BrowserLocalExtensionHealth {
  channelId: string;
  state: BrowserLocalExtensionChannelState;
  /** True when this install owns a native-messaging manifest Chrome can see. */
  installed: boolean;
  /** True when manifest → wrapper → runtime config → socket all check out. */
  registered: boolean;
  /** True when the extension polled within the freshness window. */
  polling: boolean;
  lastContactAt?: number;
  contactAgeMs?: number;
  extensionVersion?: string;
  /** Command channel load: queued (undelivered), in-flight, waiting pollers. */
  queue: Omit<BrowserExtensionQueueSnapshot, 'queueKey'>;
  contactGaps: BrowserExtensionContactGapStats;
  lastDisconnect?: BrowserExtensionDisconnectRecord;
  /** Tabs the user has shared from the local Chrome session. */
  sharedTabCount: number;
  /** Absent when the probe could not resolve a user-data path. */
  manifestPath?: string;
  /** Why the channel is in this state, in one line. */
  summary: string;
  /** Operator-actionable repair. Empty when the channel is ready. */
  remediation?: string;
}

export interface BrowserLocalExtensionHealthInput {
  userDataPath: string;
  /** Defaults to Chrome's per-platform NativeMessagingHosts directory. */
  chromeNativeMessagingDir?: string;
  extensionContactState: BrowserExtensionContactStateReader;
  extensionCommandStore: Pick<BrowserExtensionCommandStore, 'describeQueue'>;
  countSharedLocalTabs: () => number;
  now: () => number;
  /** Injected for tests; defaults to real filesystem probes. */
  fileExists?: (path: string) => boolean;
  readRuntimeSocketPath?: (runtimeConfigPath: string) => string | undefined;
  manifestOwned?: (input: { manifestPath: string; nativeDir: string }) => boolean;
}

export function describeLocalExtensionHealth(
  input: BrowserLocalExtensionHealthInput,
): BrowserLocalExtensionHealth {
  const fileExists = input.fileExists ?? ((path: string) => fs.existsSync(path));
  const readRuntimeSocketPath = input.readRuntimeSocketPath ?? defaultReadRuntimeSocketPath;
  const manifestOwned = input.manifestOwned ?? isBrowserExtensionNativeHostManifestOwned;

  const paths = browserExtensionNativeHostPaths({
    userDataPath: input.userDataPath,
    ...(input.chromeNativeMessagingDir
      ? { chromeNativeMessagingDir: input.chromeNativeMessagingDir }
      : {}),
  });
  const installed = manifestOwned({
    manifestPath: paths.manifestPath,
    nativeDir: paths.nativeDir,
  });
  const registration = installed
    ? inspectRegistrationChain({ paths, fileExists, readRuntimeSocketPath })
    : { registered: false, brokenLink: 'manifest' as const };

  const now = input.now();
  const lastContactAt = input.extensionContactState.getLastExtensionContactAt(
    BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
  );
  const contact = describeBrowserExtensionContact(
    BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
    lastContactAt,
    now,
    BROWSER_EXTENSION_CONTACT_FRESH_MS,
  );
  const polling = !contact.silent;
  const { queueKey, ...queue } = input.extensionCommandStore.describeQueue(
    BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
  );
  void queueKey;

  const state = resolveState({ installed, registered: registration.registered, polling });
  const remediation = remediationFor(state, registration.brokenLink);
  const runtime = input.extensionContactState.getExtensionRuntime?.(
    BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
  );
  const lastDisconnect = input.extensionContactState.getLastDisconnect?.(
    BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
  );

  return {
    channelId: BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
    state,
    installed,
    registered: registration.registered,
    polling,
    ...(lastContactAt !== undefined
      ? { lastContactAt, contactAgeMs: Math.max(0, now - lastContactAt) }
      : {}),
    ...(runtime?.extensionVersion ? { extensionVersion: runtime.extensionVersion } : {}),
    queue,
    contactGaps: input.extensionContactState.getContactGapStats(
      BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
    ),
    ...(lastDisconnect ? { lastDisconnect } : {}),
    sharedTabCount: input.countSharedLocalTabs(),
    manifestPath: paths.manifestPath,
    summary: describeSummary({ state, contact: contactDescription(lastContactAt, now) }),
    ...(remediation ? { remediation } : {}),
  };
}

/**
 * Resolves the user-data path the native-host files live under. Set once from
 * the Browser Gateway runtime initializer, which already knows the effective
 * path. Kept behind a provider (rather than reaching for `electron.app` here)
 * so the probe never throws in unit tests or in any non-Electron host that
 * imports this module transitively.
 */
let userDataPathProvider: (() => string | undefined) | null = null;

export function setBrowserLocalExtensionUserDataPathProvider(
  provider: () => string | undefined,
): void {
  userDataPathProvider = provider;
}

export function _resetBrowserLocalExtensionHealthForTesting(): void {
  userDataPathProvider = null;
}

/**
 * Live local-channel health from the running singletons. Deliberately
 * uncached: the probe is a handful of stat calls plus one small read, while a
 * cache would freeze contact age and hand callers a stale verdict at exactly
 * the moment (a channel dropping) the verdict matters most.
 */
export function getBrowserLocalExtensionHealth(
  overrides: Partial<BrowserLocalExtensionHealthInput> = {},
): BrowserLocalExtensionHealth {
  const userDataPath = overrides.userDataPath ?? safeUserDataPath();
  if (userDataPath === undefined) {
    return unknownLocalExtensionHealth();
  }
  const extensionTabStore = getBrowserExtensionTabStore();
  return describeLocalExtensionHealth({
    extensionContactState: getBrowserExtensionContactState(),
    extensionCommandStore: getBrowserExtensionCommandStore(),
    countSharedLocalTabs: () =>
      extensionTabStore.listTabs().filter((tab) => !tab.nodeId).length,
    now: Date.now,
    ...overrides,
    userDataPath,
  });
}

function safeUserDataPath(): string | undefined {
  try {
    return userDataPathProvider?.();
  } catch {
    return undefined;
  }
}

/**
 * Fail-safe verdict for "we could not probe". Reports nothing as broken so
 * every caller degrades to the pre-existing behaviour (queue the command, let
 * the undelivered-wait decide) rather than inventing a failure.
 */
function unknownLocalExtensionHealth(): BrowserLocalExtensionHealth {
  return {
    channelId: BROWSER_LOCAL_EXTENSION_CHANNEL_ID,
    state: 'unknown',
    installed: false,
    registered: false,
    polling: false,
    queue: { queuedCount: 0, inFlightCount: 0, waitingPollerCount: 0 },
    contactGaps: { gapCount: 0, longestGapMs: 0 },
    sharedTabCount: 0,
    summary: 'Local extension channel state is unknown (Browser Gateway runtime not initialized).',
  };
}

/**
 * True when the local channel is provably unable to deliver a command right
 * now, so callers can fail fast with an exact repair instead of burning the
 * 90 s undelivered-wait budget on a channel with no consumer.
 *
 * Deliberately conservative: only `not_installed` and `registration_broken`
 * are provable from local state alone. A `silent` channel may still be an MV3
 * service worker mid-recovery, which the undelivered-wait exists to ride out.
 */
export function isLocalExtensionChannelProvablyDown(
  health: Pick<BrowserLocalExtensionHealth, 'state'>,
): boolean {
  return health.state === 'not_installed' || health.state === 'registration_broken';
}

function resolveState(input: {
  installed: boolean;
  registered: boolean;
  polling: boolean;
}): BrowserLocalExtensionChannelState {
  if (!input.installed) {
    return 'not_installed';
  }
  if (!input.registered) {
    return 'registration_broken';
  }
  return input.polling ? 'ready' : 'silent';
}

type RegistrationBrokenLink = 'manifest' | 'wrapper' | 'runtime_config' | 'socket' | undefined;

function inspectRegistrationChain(input: {
  paths: { wrapperPath: string; runtimeConfigPath: string };
  fileExists: (path: string) => boolean;
  readRuntimeSocketPath: (runtimeConfigPath: string) => string | undefined;
}): { registered: boolean; brokenLink: RegistrationBrokenLink } {
  if (!input.fileExists(input.paths.wrapperPath)) {
    return { registered: false, brokenLink: 'wrapper' };
  }
  const socketPath = input.readRuntimeSocketPath(input.paths.runtimeConfigPath);
  if (!socketPath) {
    return { registered: false, brokenLink: 'runtime_config' };
  }
  // Works for unix sockets and Windows named pipes alike.
  if (!input.fileExists(socketPath)) {
    return { registered: false, brokenLink: 'socket' };
  }
  return { registered: true, brokenLink: undefined };
}

function defaultReadRuntimeSocketPath(runtimeConfigPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8')) as {
      socketPath?: unknown;
    };
    return typeof parsed.socketPath === 'string' && parsed.socketPath
      ? parsed.socketPath
      : undefined;
  } catch {
    return undefined;
  }
}

function contactDescription(lastContactAt: number | undefined, now: number): string {
  if (lastContactAt === undefined) {
    return 'no contact recorded';
  }
  return `last contact ${Math.max(0, Math.round((now - lastContactAt) / 1000))}s ago`;
}

function describeSummary(input: {
  state: BrowserLocalExtensionChannelState;
  contact: string;
}): string {
  switch (input.state) {
    case 'unknown':
      return 'Local extension channel state is unknown.';
    case 'not_installed':
      return 'No local Harness browser extension registration owned by this install.';
    case 'registration_broken':
      return 'Local extension native-host registration is broken; commands cannot reach Chrome.';
    case 'silent':
      return `Local extension is registered but not polling (${input.contact}).`;
    case 'ready':
      return `Local extension channel is polling (${input.contact}).`;
  }
}

function remediationFor(
  state: BrowserLocalExtensionChannelState,
  brokenLink: RegistrationBrokenLink,
): string | undefined {
  switch (state) {
    case 'unknown':
      return undefined;
    case 'not_installed':
      return 'Install the Harness Chrome extension and restart AI Orchestrator so it can '
        + 'write the native-messaging host manifest.';
    case 'registration_broken':
      return brokenLink === 'socket'
        ? 'The native host points at a socket that no longer exists (usually an AI '
          + 'Orchestrator restart). Restart AI Orchestrator, then reload the Harness '
          + 'extension in chrome://extensions so it reconnects its native port.'
        : 'The native-messaging host files are incomplete. Restart AI Orchestrator to '
          + 'rewrite them, then reload the Harness extension in chrome://extensions.';
    case 'silent':
      return 'Chrome or the Harness extension is not polling. Confirm Chrome is running, '
        + 'that the extension is enabled, and that the Harness gateway toggle in the '
        + 'extension popup is on; reload the extension if it stays silent.';
    case 'ready':
      return undefined;
  }
}
