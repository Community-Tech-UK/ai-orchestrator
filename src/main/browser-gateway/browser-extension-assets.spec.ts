import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Page } from 'puppeteer-core';
// jsdom ships no type declarations and @types/jsdom is not installed. A
// sibling spec (doc-review/artifact-choice-runtime.spec.ts) already declares
// a `declare module 'jsdom'` ambient module for this package; adding a
// second one here conflicts (TS2665), so this import is left untyped instead.
// @ts-expect-error No type declarations available for 'jsdom' in this repo.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintBrowserElementText } from './browser-element-text-fingerprint';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';

interface BrowserExtensionBackgroundHarness {
  advanceTimeBy: (ms: number) => void;
  applySecretObservationProtectionEnabled: (enabled: boolean) => Promise<void>;
  bridges: {
    hostName: string;
    nativePort: NativePortHarness | null;
      pollInFlight: boolean;
      lastError: string | null;
      reconnectAttempts: number;
      state: string;
  }[];
  deriveToolbarBadgeState: (
    snapshots: { state: string; lastPollAckAt: number | null; unhealthySince: number | null }[],
    now: number,
  ) => { text: string; color: string | null };
  captureAccessibilitySnapshot: (
    tabId: number,
    options: { interestingOnly?: boolean; limit?: number; timeoutMs?: number },
  ) => Promise<unknown>;
  captureTabScreenshot: (
    tabId: number,
    options: { fullPage?: boolean; timeoutMs?: number },
  ) => Promise<unknown>;
  forceReleaseCommandResources: (command: {
    target?: { tabId?: number };
  }) => Promise<void>;
  markSecretTaint: (tabId: number, origin: string) => Promise<void>;
  reportTabInventory: () => Promise<void>;
  clearHttpAuthChallenge: (tabId: number) => void;
  clearHttpAuthStage: (tabId: number) => void;
  handleHttpAuthRequired: (
    details: Record<string, unknown>,
    asyncCallback?: (response: unknown) => void,
  ) => unknown;
  httpAuthChallengeForTab: (tabId: number) => Record<string, unknown> | undefined;
  httpAuthChallenges: Map<number, Record<string, unknown>>;
  httpAuthStages: Map<number, Record<string, unknown>>;
  recordHttpAuthChallenge: (details: Record<string, unknown>) => void;
  runPageBridgeSnapshot: (
    html: string,
    selector: string,
    options?: { innerText?: string; subtleCrypto?: boolean },
  ) => Promise<Record<string, unknown>>;
  selfHealIfWedged: () => Promise<void>;
  setGatewayEnabled: (enabled: boolean) => Promise<unknown>;
  startControlledTab: (tabId: number) => Promise<unknown>;
  stopControlledTab: (tabId: number, token?: unknown) => Promise<void>;
  waitForTabComplete: (tabId: number, timeoutMs?: number) => Promise<void>;
  tabState: (tabId: number) => ReturnType<typeof makeWebTab> | undefined;
  sendMessage: (message: unknown) => Promise<unknown>;
  tabDebuggerChains: Map<number, Promise<void>>;
  chrome: BrowserExtensionChromeHarness;
  ports: Map<string, NativePortHarness>;
  failConnectHosts: Set<string>;
  storedGatewayEnabled: () => boolean | undefined;
  timers: {
    setTimeout: ReturnType<typeof vi.fn>;
    clearTimeout: ReturnType<typeof vi.fn>;
  };
}

interface BrowserExtensionChromeHarness {
  debugger: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
  runtime: {
    connectNative: ReturnType<typeof vi.fn>;
    getManifest: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    lastError?: { message: string };
  };
  action: {
    setIcon: ReturnType<typeof vi.fn>;
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    session: {
      set: ReturnType<typeof vi.fn>;
    };
  };
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
  };
  webRequest: {
    onAuthRequired: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
      emit: (details: unknown, respond: (response: unknown) => void) => void;
    };
  };
  tabs: {
    get: ReturnType<typeof vi.fn>;
    group: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    onRemoved: { emit: (tabId: number) => void };
    onUpdated: {
      emit: (tabId: number, changeInfo: Record<string, unknown>, tab: unknown) => void;
    };
    ungroup: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    getZoom: ReturnType<typeof vi.fn>;
    getZoomSettings: ReturnType<typeof vi.fn>;
    setZoom: ReturnType<typeof vi.fn>;
    setZoomSettings: ReturnType<typeof vi.fn>;
  };
  tabGroups: {
    get: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  windows: {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

interface NativePortHarness {
  hostName: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitMessage: (message: unknown) => void;
  emitDisconnect: (message?: string) => void;
}

const LEGACY_HOST_NAME = 'com.ai_orchestrator.browser_gateway';
const RELAY_HOST_NAME = 'com.ai_orchestrator.browser_gateway_relay';

describe('browser extension assets', () => {
  // `extensionVersion` is the ONLY thing a node reports about which bundle it is
  // running, so shipping a changed background.js under an unchanged version makes
  // a stale service worker indistinguishable from a fresh one -- every downstream
  // live check then validates OLD code while reporting success.
  //
  // This map is APPEND-ONLY: when background.js changes, bump manifest.version
  // and add a NEW row. Never edit an existing row. A test cannot force a human to
  // bump a version, but an append-only history makes the wrong edit obvious in
  // review, and the uniqueness assertion below catches a hash reused across two
  // versions.
  const BACKGROUND_BUNDLE_HISTORY: Record<string, string> = {
    '0.2.2': 'c4dad58073f6',
    '0.2.3': '09d67fe82bd1',
    '0.2.4': 'd79fb24024c5',
    '0.2.5': '4a3aa3952f3a',
    '0.2.6': 'bd4b33105c0b',
    '0.2.7': '76c5a5907444',
    '0.2.8': '2d8a7f6deace',
    '0.2.9': 'dc509385ad4c',
    '0.2.10': '7ef561cc2b93',
    '0.2.11': '989f25aa79d1',
    '0.2.12': 'c6a978482d8d',
    '0.2.13': '26da96987d22',
    '0.2.14': '86aad34ccca7',
    '0.2.15': '1ba43175cf4a',
    '0.2.16': '4c63cd971f28',
    '0.2.17': '4a7787047e99',
    '0.2.18': '77c922098b1c',
    '0.2.19': '532f9c8bca96',
    '0.2.20': '62c869613df1',
    '0.2.21': 'afdaa972c264',
    '0.2.22': 'c55cc8093446',
    '0.2.23': 'a7e3e5dc9bef',
    '0.2.24': '1fa9cbdcd668',
    '0.2.25': 'b8c1a6416365',
    '0.2.26': '0d2e27419c5a',
    '0.2.27': '3f3bf5aa94c0',
    '0.2.28': '07da8051e91d',
    '0.2.29': '4de2ab44efec',
    '0.2.30': '7204a6ca8969',
    '0.2.31': '2c02d9f41579',
    '0.2.32': '41673e46a456',
    '0.2.33': '9204adfa79c2',
    '0.2.34': '8393decbfb72',
    '0.2.35': 'a7bb39633b15',
    '0.2.36': 'aec2ae55e31a',
    '0.2.37': '7b8b2245d0af',
    // LT-703: origin-bound writes into an embedded cross-origin login form,
    // precise fixed failure codes, and the receiving `__frameOrigin` on
    // read_control/find.
    '0.2.38': 'f119d530848d',
    // A tab the extension cannot script is inspection_unavailable, not readable.
    '0.2.39': '9d9630e3d6d9',
    // Reload onto the version a worker relay expects (worker auto-update).
    '0.2.40': '5809d0399317',
    // Native keyboard (press_key) via CDP Input events with modifier release +
    // idempotent-activation dedupe; tab/window viewport control; real Chrome
    // zoom with per-tab baseline restore.
    '0.2.41': 'b137eaa54663',
    // Per-install (Chrome profile) id on every native message, and refusal of
    // a command addressed to another profile's tab.
    '0.2.42': '28f8d2a7e1de',
    // HTTP Basic/Digest prompts: webRequest.onAuthRequired answers Chrome's
    // own sign-in box from a stage scoped to one command's tab+origin, an
    // observe-only httpAuthChallenge report on tab payloads, and the
    // http_auth_navigate command.
    '0.2.43': 'f48f2476e9f5',
  };

  it('ships each background bundle under its own manifest version', () => {
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    );
    const backgroundHash = createHash('sha256')
      .update(readFileSync('resources/browser-extension/background.js'))
      .digest('hex')
      .slice(0, 12);

    expect(BACKGROUND_BUNDLE_HISTORY[manifest.version]).toBe(backgroundHash);

    const hashes = Object.values(BACKGROUND_BUNDLE_HISTORY);
    expect(new Set(hashes).size).toBe(hashes.length);
  });


  it('ships a live authenticated-tab bridge with command polling and page access', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { permissions?: string[]; host_permissions?: string[] };
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popup).toContain("addEventListener('click'");
    expect(background).toContain("type: 'attach_tab'");
    expect(background).toContain('function createBridge');
    expect(background).toContain(LEGACY_HOST_NAME);
    expect(background).toContain(RELAY_HOST_NAME);
    expect(background).toContain('chrome.runtime.connectNative(bridge.hostName)');
    expect(background).toContain('chrome.runtime.lastError?.message');
    expect(background).toContain('chrome.tabs.onUpdated');
    expect(background).toContain('chrome.tabs.onRemoved');
    expect(background).toContain("type: 'tab_inventory'");
    expect(background).toContain("type: 'poll_command'");
    expect(background).toContain("type: 'command_result'");
    expect(background).toContain('executeBrowserCommand');
    expect(background).toContain("case 'read_control'");
    expect(background).toContain("case 'close_tab'");
    expect(background).toContain('chrome.tabs.remove');
    expect(background).toContain('fileCount: files.length');
    expect(background).toContain("'DOM.setFileInputFiles'");
    expect(background).toContain('findActiveWebTabForSharing');
    expect(background).toContain('lastFocusedWindow: true');
    expect(background).toContain('chrome.tabs.query({})');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('tabGroups');
    // HTTP auth answering (Chrome's own Basic/Digest prompt) runs through the
    // webRequest API; MV3 requires both permissions for onAuthRequired.
    expect(manifest.permissions).toContain('webRequest');
    expect(manifest.permissions).toContain('webRequestAuthProvider');
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('marks actively controlled tabs with a blue group and page glow', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('Harness');
    expect(background).toContain('chrome.tabs.group');
    expect(background).toContain('chrome.tabGroups.update');
    expect(background).toContain("color: 'blue'");
    expect(background).toContain('installControlGlowScript');
    expect(background).toContain('removeControlGlowScript');
    expect(background).toContain('aio-browser-control-glow');
    // Controlled tabs must collapse into a single per-window control group
    // rather than spawning a new group per tab, so an existing control group is
    // reused via chrome.tabGroups.query before falling back to a fresh group.
    expect(background).toContain('chrome.tabGroups.query');
    expect(background).toContain('function findControlGroupId');
    expect(background).toContain('tabIds: tabId, groupId: canonicalGroupId');
  });

  it('uses open-shadow traversal for snapshots and selector actions', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function deepQuerySelector');
    expect(background).toContain('function collectVisibleText');
    expect(background).toContain('node.shadowRoot');
    expect(background).toContain('const element = deepQuerySelector(selector)');
    expect(background).toContain('text: collectVisibleText().slice(0, 120000)');
  });

  it('captures screenshots over the DevTools protocol instead of the focused visible tab', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('captureTabScreenshot');
    expect(background).toContain("'Page.captureScreenshot'");
    // The focus-dependent path must be gone.
    expect(background).not.toContain('captureVisibleTab');
    expect(background).not.toContain('async function focusTab');
    // Downscaled JPEG by default to stay within the inline token budget (#6).
    expect(background).toContain('SCREENSHOT_DEFAULT_MAX_WIDTH');
    expect(background).toContain("format === 'png' ? 'png' : 'jpeg'");
  });

  it('drives real pointer/mouse input and the native value setter', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function dispatchRealClick');
    expect(background).toContain("'pointerdown'");
    expect(background).toContain("'mousedown'");
    expect(background).toContain("'mouseup'");
    // Synthetic element.click() must no longer be the click mechanism.
    expect(background).not.toContain('element.click();');
    expect(background).toContain('function setNativeValue');
    expect(background).toContain("Object.getOwnPropertyDescriptor(prototype, 'value')");
  });

  it('runs selector actions across all frames and fails on no-match', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('allFrames: true');
    expect(background).toContain('function mergeFrameResults');
    expect(background).toContain('waitForSelectorAcrossFrames');
    // Missing selectors surface as command failures (#10) rather than silent success.
    expect(background).toContain('No element matches selector:');
    expect(background).toContain('__found');
    expect(background).toContain("if (action === 'read_control')");
  });

  it('supports custom (non-native) select dropdowns', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function selectValue');
    expect(background).toContain('function findOptionByText');
    expect(background).toContain("element.tagName === 'SELECT'");
    // This used to assert the string `custom_select_option_not_found`, which was
    // a `note` on a RESOLVED result: the dropdown was clicked open, nothing was
    // selected, and the caller was told the selection succeeded because the
    // gateway discards a mutation's payload. The timeout must now REJECT, so the
    // failure is the outcome rather than a footnote nobody receives.
    expect(background).not.toContain('custom_select_option_not_found');
    expect(background).toContain('nothing was selected');
  });

  it('serializes commands and per-tab debugger sessions to prevent double CDP attach', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    // Two debuggers on one tab throw "Another debugger is already attached"
    // and have crashed the tab's renderer (RESULT_CODE_KILLED_BAD_MESSAGE):
    // commands must run one-at-a-time, debugger sessions must queue per tab,
    // and a tab held by an external client must fail with a clear error.
    expect(background).toContain('commandChain');
    expect(background).toContain('function runBrowserCommand');
    expect(background).toContain('tabDebuggerChains');
    expect(background).toContain('function attachAndRunDebugger');
    expect(background).toContain('function attachDebugger');
    expect(background).toContain('browser_tab_debugger_busy');
    // The poll flag must not be cleared before command execution finishes —
    // an early clear lets the alarm-driven poll pull a concurrent command.
    expect(background).not.toMatch(/pollInFlight = false;\s*\n\s*if \(!message \|\| message\.type !== 'browser_command'/);
  });

  it('watchdogs browser commands so a stuck CDP operation cannot block the queue forever', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function runCommandWithWatchdog');
    expect(background).toContain('commandExecutionTimeoutMs(command)');
    expect(background).toContain('browser_extension_command_timeout');
    expect(background).toContain('function forceReleaseCommandResources');
    expect(background).toContain('chrome.debugger.detach({ tabId })');
  });

  it('bounds the accessibility tree CDP call and names the stalled step', async () => {
    // Live incident: two accessibility_snapshot calls on one heavy page each
    // burned their whole 60s window and surfaced as a bare
    // browser_extension_command_timeout, which said nothing about where they
    // stalled — and read to the agent like a permission refusal.
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_debuggee: unknown, method: string) => {
        if (method === 'Accessibility.getFullAXTree') {
          return new Promise(() => undefined);
        }
        return {};
      },
    );

    const settled = harness
      .captureAccessibilitySnapshot(42, { limit: 10, timeoutMs: 60_000 })
      .then(() => null, (error: unknown) => error as Error);
    await flushPromises();

    // 80% of the 60s command budget, leaving the reply time to get home.
    const deadline = harness.timers.setTimeout.mock.calls.find(
      (call: unknown[]) => call[1] === 48_000,
    );
    expect(deadline).toBeDefined();
    (deadline?.[0] as (() => void) | undefined)?.();

    const error = await settled;
    expect(error?.message).toContain(
      'browser_extension_cdp_timeout:Accessibility.getFullAXTree',
    );
    // The session must not be left attached — a held debugger stalls every
    // later CDP command queued behind this tab's chain.
    expect(harness.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('bounds the debugger attach hop separately from page work', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.debugger.attach.mockImplementation(async () => new Promise(() => undefined));

    const settled = harness
      .captureAccessibilitySnapshot(42, { limit: 10, timeoutMs: 60_000 })
      .then(() => null, (error: unknown) => error as Error);
    await flushPromises();

    const deadline = harness.timers.setTimeout.mock.calls.find(
      (call: unknown[]) => call[1] === 10_000,
    );
    expect(deadline).toBeDefined();
    (deadline?.[0] as (() => void) | undefined)?.();

    const error = await settled;
    expect(error?.message).toContain('browser_extension_cdp_timeout:attach');
    expect(harness.chrome.debugger.sendCommand).not.toHaveBeenCalled();
    // A late attach must not leave the tab holding an orphaned session: the
    // command watchdog that used to clean up no longer fires, because this
    // deadline beat it.
    expect(harness.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('keeps a short floor on the page-work deadline for small command budgets', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_debuggee: unknown, method: string) => {
        if (method === 'Accessibility.getFullAXTree') {
          return new Promise(() => undefined);
        }
        return {};
      },
    );

    const settled = harness
      .captureAccessibilitySnapshot(42, { limit: 10, timeoutMs: 1_000 })
      .then(() => null, (error: unknown) => error as Error);
    await flushPromises();

    // 80% of 1s would be 800ms — too short to ever return a tree, so the floor
    // applies instead. No deadline shorter than the floor may be registered,
    // and firing the floor-length ones must be what fails the tree call (the
    // already-settled enable hops ignore a late rejection).
    expect(
      harness.timers.setTimeout.mock.calls.every((call: unknown[]) => Number(call[1]) >= 5_000),
    ).toBe(true);
    for (const call of harness.timers.setTimeout.mock.calls) {
      if (call[1] === 5_000) {
        (call[0] as () => void)();
      }
    }
    const error = await settled;
    expect(error?.message).toContain(
      'browser_extension_cdp_timeout:Accessibility.getFullAXTree',
    );
  });

  it('bounds the screenshot capture the same way', async () => {
    // Same failure class, seen live on 2026-07-28: "Existing-tab live
    // screenshot failed: browser_extension_command_timeout".
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.debugger.sendCommand.mockImplementation(
      async (_debuggee: unknown, method: string) => {
        if (method === 'Page.captureScreenshot') {
          return new Promise(() => undefined);
        }
        return {};
      },
    );

    const settled = harness
      .captureTabScreenshot(42, { timeoutMs: 60_000 })
      .then(() => null, (error: unknown) => error as Error);
    await flushPromises();

    const deadline = harness.timers.setTimeout.mock.calls.find(
      (call: unknown[]) => call[1] === 48_000,
    );
    expect(deadline).toBeDefined();
    (deadline?.[0] as (() => void) | undefined)?.();

    const error = await settled;
    expect(error?.message).toContain('browser_extension_cdp_timeout:Page.captureScreenshot');
    expect(harness.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('releases a stuck per-tab debugger chain when the command watchdog fires', async () => {
    const harness = loadBackgroundHarnessForTest();
    harness.tabDebuggerChains.set(42, new Promise<void>(() => undefined));

    await harness.forceReleaseCommandResources({ target: { tabId: 42 } });

    expect(harness.tabDebuggerChains.has(42)).toBe(false);
  });

  it('reuses an existing Harness group and ungroups the tab after control ends', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);

    const token = await harness.startControlledTab(42);

    expect(harness.tabState(42)?.groupId).toBe(10);

    await harness.stopControlledTab(42, token);

    expect(harness.tabState(42)?.groupId).toBe(-1);
  });

  it('keeps a nested control lease grouped until the final stop', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);

    const outerToken = await harness.startControlledTab(42);
    const innerToken = await harness.startControlledTab(42);
    await harness.stopControlledTab(42, innerToken);

    expect(harness.tabState(42)?.groupId).toBe(10);

    await harness.stopControlledTab(42, outerToken);

    expect(harness.tabState(42)?.groupId).toBe(-1);
  });

  it('restores a tab to its original non-Harness group after control ends', async () => {
    const harness = loadBackgroundHarnessForTest({ initialTabGroupId: 55 });
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);

    const token = await harness.startControlledTab(42);

    expect(harness.tabState(42)?.groupId).toBe(10);

    await harness.stopControlledTab(42, token);

    expect(harness.tabState(42)?.groupId).toBe(55);
  });

  it('recreates an original group that Chrome removed when its sole tab moved', async () => {
    const deletedGroupIds = new Set<number>();
    const harness = loadBackgroundHarnessForTest({
      deletedGroupIds,
      initialTabGroupId: 55,
    });
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const token = await harness.startControlledTab(42);
    deletedGroupIds.add(55);

    await harness.stopControlledTab(42, token);

    expect(harness.tabState(42)?.groupId).toBe(1);
    expect(harness.chrome.tabGroups.update).toHaveBeenCalledWith(1, {
      title: 'Research',
      color: 'green',
      collapsed: true,
    });
  });

  it('treats Chrome group cleanup failures as best effort', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    harness.chrome.tabs.ungroup.mockRejectedValue(new Error('Chrome rejected ungroup'));

    const token = await harness.startControlledTab(42);

    await expect(harness.stopControlledTab(42, token)).resolves.toBeUndefined();
  });

  it('ignores a timed-out operation finalizer after a newer lease starts', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const staleToken = await harness.startControlledTab(42);

    await harness.forceReleaseCommandResources({ target: { tabId: 42 } });
    const currentToken = await harness.startControlledTab(42);
    await harness.stopControlledTab(42, staleToken);

    expect(harness.tabState(42)?.groupId).toBe(10);

    await harness.stopControlledTab(42, currentToken);

    expect(harness.tabState(42)?.groupId).toBe(-1);
  });

  it('force-releases a command without waiting for hung lease initialization', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabs.get.mockImplementationOnce(
      () => new Promise<ReturnType<typeof makeWebTab>>(() => undefined),
    );
    void harness.startControlledTab(42);

    await expect(harness.forceReleaseCommandResources({
      target: { tabId: 42 },
    })).resolves.toBeUndefined();

    const currentToken = await harness.startControlledTab(42);
    await harness.stopControlledTab(42, currentToken);
  });

  it('does not attach a reacquisition to a retiring lease with pending cleanup', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const firstToken = await harness.startControlledTab(42);
    const executeScript = harness.chrome.scripting.executeScript;
    const defaultExecuteScript = executeScript.getMockImplementation()!;
    let releaseGlowRemoval: (() => void) | undefined;
    executeScript.mockImplementation(async (input: { func?: { name?: string } }) => {
      if (input.func?.name === 'removeControlGlowScript') {
        await new Promise<void>((resolve) => {
          releaseGlowRemoval = resolve;
        });
        return [];
      }
      return defaultExecuteScript(input);
    });

    const firstStop = harness.stopControlledTab(42, firstToken);
    await flushPromises();
    expect(releaseGlowRemoval).toBeTypeOf('function');
    const secondToken = await harness.startControlledTab(42);
    releaseGlowRemoval!();
    await firstStop;

    expect(harness.tabState(42)?.groupId).toBe(10);

    executeScript.mockImplementation(defaultExecuteScript);
    await harness.stopControlledTab(42, secondToken);

    expect(harness.tabState(42)?.groupId).toBe(-1);
  });

  it('carries original group metadata across a replacement generation', async () => {
    const harness = loadBackgroundHarnessForTest({ initialTabGroupId: 55 });
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const firstToken = await harness.startControlledTab(42);

    const firstStop = harness.stopControlledTab(42, firstToken);
    const secondToken = await harness.startControlledTab(42);
    await firstStop;

    expect(harness.tabState(42)?.groupId).toBe(10);

    await harness.stopControlledTab(42, secondToken);

    expect(harness.tabState(42)?.groupId).toBe(55);
  });

  it('prevents an older cleanup from overtaking a retiring replacement generation', async () => {
    const harness = loadBackgroundHarnessForTest({ initialTabGroupId: 55 });
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const firstToken = await harness.startControlledTab(42);
    const executeScript = harness.chrome.scripting.executeScript;
    const defaultExecuteScript = executeScript.getMockImplementation()!;
    const getTab = harness.chrome.tabs.get;
    const currentTab = harness.tabState(42);
    let removeCallCount = 0;
    let releaseFirstGlowRemoval: (() => void) | undefined;
    let releaseFirstCleanupTabRead: (() => void) | undefined;
    executeScript.mockImplementation(async (input: { func?: { name?: string } }) => {
      if (input.func?.name === 'removeControlGlowScript' && removeCallCount++ === 0) {
        await new Promise<void>((resolve) => {
          releaseFirstGlowRemoval = resolve;
        });
        return [];
      }
      return defaultExecuteScript(input);
    });
    getTab.mockImplementationOnce(
      () => new Promise<ReturnType<typeof makeWebTab> | undefined>((resolve) => {
        releaseFirstCleanupTabRead = () => resolve(currentTab);
      }),
    );

    const firstStop = harness.stopControlledTab(42, firstToken);
    await flushPromises();
    expect(releaseFirstGlowRemoval).toBeTypeOf('function');
    expect(releaseFirstCleanupTabRead).toBeTypeOf('function');
    const secondToken = await harness.startControlledTab(42);
    releaseFirstCleanupTabRead!();
    await flushPromises();
    const groupTab = harness.chrome.tabs.group;
    const defaultGroupTab = groupTab.getMockImplementation()!;
    let releaseReplacementRestore: (() => void) | undefined;
    groupTab.mockImplementation(async (input: { tabIds: number | number[]; groupId?: number }) => {
      if (input.groupId === 55) {
        await new Promise<void>((resolve) => {
          releaseReplacementRestore = resolve;
        });
      }
      return defaultGroupTab(input);
    });

    const secondStop = harness.stopControlledTab(42, secondToken);
    await flushPromises();
    expect(releaseReplacementRestore).toBeTypeOf('function');
    releaseFirstGlowRemoval!();
    await flushPromises();
    const groupIdWhileReplacementRetires = harness.tabState(42)?.groupId;

    releaseReplacementRestore!();
    await Promise.all([firstStop, secondStop]);

    expect(groupIdWhileReplacementRetires).toBe(10);
    expect(harness.tabState(42)?.groupId).toBe(55);
  });

  it('preserves a manual group move made while the tab is controlled', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([{ id: 10, title: 'Harness', windowId: 7 }]);
    const token = await harness.startControlledTab(42);
    const tab = harness.tabState(42);
    if (tab) {
      tab.groupId = 77;
    }

    await harness.stopControlledTab(42, token);

    expect(harness.tabState(42)?.groupId).toBe(77);
  });

  it('consolidates historical Harness groups and removes them after final control', async () => {
    const harness = loadBackgroundHarnessForTest({
      additionalTabs: [{ tabId: 43, groupId: 11 }],
      initialTabGroupId: 10,
    });
    await flushPromises();
    harness.chrome.tabGroups.query.mockResolvedValue([
      { id: 10, title: 'Harness', windowId: 7 },
      { id: 11, title: 'Harness', windowId: 7 },
    ]);

    const token = await harness.startControlledTab(42);

    expect(harness.tabState(42)?.groupId).toBe(10);
    expect(harness.tabState(43)?.groupId).toBe(10);

    await harness.stopControlledTab(42, token);

    expect(harness.tabState(42)?.groupId).toBe(-1);
    expect(harness.tabState(43)?.groupId).toBe(-1);
  });

  it('keeps controlled tabs unfrozen and undiscarded against background throttling', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { permissions?: string[] };

    // Persistent anti-discard survives between commands (CDP overrides do not).
    expect(background).toContain('function preventTabDiscard');
    expect(background).toContain('autoDiscardable: false');
    // Focus/lifecycle overrides applied for the duration of every CDP session so
    // a backgrounded tab is not throttled/frozen mid-command.
    expect(background).toContain('function applyDebuggerKeepAlive');
    expect(background).toContain("'Emulation.setFocusEmulationEnabled'");
    expect(background).toContain("'Page.setWebLifecycleState'");
    expect(background).toContain("state: 'active'");
    // Both run as part of taking control of a tab / opening a CDP session.
    expect(background).toContain('preventTabDiscard(tabId)');
    expect(background).toContain('await applyDebuggerKeepAlive(debuggee)');
    // autoDiscardable requires the tabs permission (already present).
    expect(manifest.permissions).toContain('tabs');
  });

  it('buffers native-host messages and backs off reconnects', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function enqueueOutbox');
    expect(background).toContain('function flushOutbox');
    expect(background).toContain('function scheduleReconnect');
    expect(background).toContain('RECONNECT_MAX_MS');
    expect(background).toContain("stampedMessage?.type === 'poll_command'");
  });

  it('starts independent native-port bridges for the legacy and relay hosts', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();

    expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(LEGACY_HOST_NAME);
    expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(RELAY_HOST_NAME);
    expect(harness.ports.get(LEGACY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
    expect(harness.ports.get(RELAY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
  });

  it('stamps native-port messages with extension runtime identity', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();

    expect(harness.ports.get(RELAY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      extensionVersion: '0.1.0',
      extensionStartedAt: 1_000_000,
    }));
  });

  it('stays passive at startup when Browser Gateway was turned off', async () => {
    const harness = loadBackgroundHarnessForTest({ initialGatewayEnabled: false });
    await flushPromises();

    expect(harness.chrome.runtime.connectNative).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.query).not.toHaveBeenCalled();

    const response = await harness.sendMessage({ type: 'getStatus' });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      gatewayEnabled: false,
      bridges: expect.arrayContaining([
        expect.objectContaining({
          hostName: LEGACY_HOST_NAME,
          state: 'disabled',
        }),
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          state: 'disabled',
        }),
      ]),
    }));
  });

  it('turns Browser Gateway off, disconnects bridges, and suppresses page activity', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const legacyPort = harness.ports.get(LEGACY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;

    const response = await harness.sendMessage({ type: 'set_gateway_enabled', enabled: false });
    await flushPromises();

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      gatewayEnabled: false,
    }));
    expect(harness.storedGatewayEnabled()).toBe(false);
    expect(legacyPort.disconnect).toHaveBeenCalled();
    expect(relayPort.disconnect).toHaveBeenCalled();

    harness.chrome.tabs.query.mockClear();
    legacyPort.postMessage.mockClear();
    relayPort.postMessage.mockClear();
    await harness.reportTabInventory();
    const shareResponse = await harness.sendMessage({ type: 'share_active_tab' });

    expect(harness.chrome.tabs.query).not.toHaveBeenCalled();
    expect(legacyPort.postMessage).not.toHaveBeenCalled();
    expect(relayPort.postMessage).not.toHaveBeenCalled();
    expect(shareResponse).toEqual({
      ok: false,
      error: 'browser_safe_mode_enabled',
    });
  });

  it('sets the pinned action icon to a grey or blue dot with a white H', async () => {
    const harness = loadBackgroundHarnessForTest({ initialGatewayEnabled: false });

    expect(await waitForActionIconColor(harness, 8, 5)).toEqual([156, 163, 175, 255]);
    expect(await waitForActionIconColor(harness, 8, 8)).toEqual([255, 255, 255, 255]);

    const response = await harness.sendMessage({ type: 'set_gateway_enabled', enabled: true });

    expect(response).toEqual(expect.objectContaining({ gatewayEnabled: true }));
    expect(await waitForActionIconColor(harness, 8, 5)).toEqual([37, 99, 235, 255]);
    expect(await waitForActionIconColor(harness, 8, 8)).toEqual([255, 255, 255, 255]);
  });

  describe('Chrome profile identity', () => {
    const INSTANCE_KEY = 'browserGatewayInstanceId';
    const STORED_ID = 'stored-profile-id-0001';

    function postedMessages(harness: BrowserExtensionBackgroundHarness): Record<string, unknown>[] {
      return [...harness.ports.values()].flatMap((port) =>
        port.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>));
    }

    it('mints one id for this profile, saves it, and stamps it on every native message', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const saved = harness.chrome.storage.local.set.mock.calls
        .map(([values]) => (values as Record<string, unknown>)[INSTANCE_KEY])
        .filter((value) => value !== undefined);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      const messages = postedMessages(harness);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message).toMatchObject({ extensionInstanceId: saved[0] });
      }
    });

    it('reuses the id this profile saved earlier', async () => {
      const harness = loadBackgroundHarnessForTest({ initialLocalStorage: { [INSTANCE_KEY]: STORED_ID } });
      await flushPromises();

      expect(harness.chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [INSTANCE_KEY]: expect.anything() }),
      );
      expect(postedMessages(harness)).toContainEqual(expect.objectContaining({
        type: 'poll_command',
        extensionInstanceId: STORED_ID,
      }));
    });

    it('refuses a command addressed to another profile without touching any tab', async () => {
      const harness = loadBackgroundHarnessForTest({ initialLocalStorage: { [INSTANCE_KEY]: STORED_ID } });
      await flushPromises();
      const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
      relayPort.postMessage.mockClear();

      relayPort.emitMessage({
        type: 'browser_command',
        command: {
          id: 'foreign-command',
          command: 'close_tab',
          target: { tabId: 42, extensionInstanceId: 'other-profile-id-0002' },
        },
      });
      await flushPromises();

      expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'command_result',
        commandId: 'foreign-command',
        ok: false,
        error: 'browser_extension_wrong_profile',
      }));
      expect(harness.chrome.tabs.remove).not.toHaveBeenCalled();
      expect(harness.tabState(42)).toBeDefined();
    });

    it.each([
      ['a page read', { command: 'snapshot' }],
      ['an origin-bound credential write', {
        command: 'type',
        payload: { selector: '#password', value: 'TEST_ONLY_PLACEHOLDER', credentialOrigin: 'https://example.test', credentialProtection: 'password' },
      }],
    ])('reports the wrong-profile code for %s on a tab this profile does not have', async (_label, shape) => {
      const harness = loadBackgroundHarnessForTest({ initialLocalStorage: { [INSTANCE_KEY]: STORED_ID } });
      await flushPromises();
      // Real Chrome rejects tabs.get for a tab id from another profile.
      harness.chrome.tabs.get.mockImplementation(async (tabId: number) => {
        const tab = harness.tabState(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      });
      const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
      relayPort.postMessage.mockClear();

      relayPort.emitMessage({
        type: 'browser_command',
        command: { id: 'foreign-missing-tab', ...shape, target: { tabId: 999, extensionInstanceId: 'other-profile-id-0002' } },
      });
      await flushPromises();

      expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'command_result',
        commandId: 'foreign-missing-tab',
        ok: false,
        error: 'browser_extension_wrong_profile',
      }));
      expect(harness.chrome.tabs.get).not.toHaveBeenCalledWith(999);
    });

    it('keeps a saved id when reading storage fails, rather than overwriting it', async () => {
      const harness = loadBackgroundHarnessForTest({
        initialLocalStorage: { [INSTANCE_KEY]: STORED_ID },
        failStorageReadKeys: new Set([INSTANCE_KEY]),
      });
      await flushPromises();

      expect(harness.chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [INSTANCE_KEY]: expect.anything() }),
      );
      // It still runs under a session-only id rather than none.
      expect(postedMessages(harness)).toContainEqual(expect.objectContaining({
        type: 'poll_command',
        extensionInstanceId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      }));
    });

    it('runs a command addressed to this profile', async () => {
      const harness = loadBackgroundHarnessForTest({ initialLocalStorage: { [INSTANCE_KEY]: STORED_ID } });
      await flushPromises();
      const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
      relayPort.postMessage.mockClear();

      relayPort.emitMessage({
        type: 'browser_command',
        command: {
          id: 'own-command',
          command: 'snapshot',
          target: { tabId: 42, extensionInstanceId: STORED_ID },
        },
      });
      await flushPromises();

      expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'command_result',
        commandId: 'own-command',
        ok: true,
      }));
    });
  });

  it('routes command results back through the bridge that delivered the command', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const legacyPort = harness.ports.get(LEGACY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    legacyPort.postMessage.mockClear();
    relayPort.postMessage.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'relay-command-1',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'relay-command-1',
      ok: true,
    }));
    expect(legacyPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'relay-command-1',
    }));
  });

  // Regression for the "polling without executing" wedge (windows-pc,
  // 2026-09-25). A command whose execution rejected OUTSIDE runBrowserCommand's
  // try left the module-scope commandChain rejected. From then on every later
  // command was skipped without running while the poll loop carried on, so the
  // channel reported "polling 2s ago" and every command timed out. That state
  // lives in the MV3 service worker, so restarting the worker relay could not
  // clear it — only reloading the extension in chrome://extensions could.
  it('keeps executing commands after one fails before its error reporter', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayBridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    // The state-changing branch of applySecretObservationProtectionEnabled
    // writes through the shared secret-observation boundary. Rejecting that
    // write reproduces the throw that used to escape runBrowserCommand before
    // its try existed.
    harness.chrome.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      if (values && 'browserSecretObservationProtectionEnabled' in values) {
        throw new Error('storage write failed');
      }
      return undefined;
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'cmd-that-throws',
        command: 'snapshot',
        target: { tabId: 42 },
        payload: { secretObservationProtectionEnabled: false },
      },
    });
    await flushPromises();

    // The failure is reported to the gateway rather than vanishing...
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'cmd-that-throws',
      ok: false,
    }));
    // ...and the bridge does not sit with a stuck in-flight poll, which would
    // stop it polling altogether.
    expect(relayBridge.pollInFlight).toBe(false);
    relayPort.postMessage.mockClear();

    // The property that was lost: the NEXT command still executes.
    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'cmd-after',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'cmd-after',
      ok: true,
    }));
  });

  // The terminal catch on the shared commandChain is the last line of defence
  // and must itself be total: if it throws, the chain is left rejected and every
  // later command is skipped. It must also still re-arm the bridge's next poll —
  // losing that re-arm strands the bridge until the 30s inventory alarm, a
  // degraded echo of the failure class being fixed.
  //
  // The escape is forced at the zero-delay re-arm timer, which is both what can
  // still throw out of runBrowserCommand's finally and what must not be lost.
  it('survives a command path that throws from its finally after reporting', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayBridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    let zeroDelaySchedules = 0;
    harness.timers.setTimeout.mockImplementation((fn: unknown, delayMs: number) => {
      if (delayMs === 0) {
        zeroDelaySchedules += 1;
        throw new Error('timer scheduling unavailable');
      }
      return 0;
    });
    // Also throw from the status write, which is what previously cost the bridge
    // its re-arm (it sat before the re-arm, so its throw skipped it entirely).
    // persistBridgeStatus is total now, so this must be absorbed and must not
    // stop the re-arm from being attempted.
    harness.chrome.action.setBadgeText.mockImplementation(() => {
      throw new Error('action.setBadgeText unavailable');
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'cmd-then-throw',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    // The command still reported its own result before the finally threw...
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'cmd-then-throw',
      ok: true,
    }));
    expect(relayBridge.pollInFlight).toBe(false);
    // ...and the re-arm was ATTEMPTED twice: once from runBrowserCommand's
    // finally and once from the terminal catch. Both are zero-delay by design,
    // so this pins that the recovery path re-arms before any best-effort work
    // instead of dropping it.
    expect(zeroDelaySchedules).toBe(2);
    relayPort.postMessage.mockClear();

    harness.timers.setTimeout.mockImplementation(() => 0);

    // ...and the NEXT command still runs. Before the chain was fenced this was
    // skipped without running, because the shared chain stayed rejected.
    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'cmd-after-escape',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'cmd-after-escape',
      ok: true,
    }));
  });

  // The terminal catch can be the ONLY reporter for a command. Its failure text
  // must therefore go through the same sanitisation as runBrowserCommand's own
  // failure path: a tainted tab can mirror a vault value into a thrown message.
  // Note the fixed credential branch of browserCommandErrorMessage does NOT
  // cover this — it returns before the taint flag is consulted — so passing a
  // credential-write predicate there is a no-op and a non-credential command on
  // a tainted tab is exactly the case that must use the real taint state.
  it('sanitises the terminal failure report for a tainted tab', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    await harness.markSecretTaint(42, 'https://example.test');

    harness.timers.setTimeout.mockImplementation((fn: unknown, delayMs: number) => {
      if (delayMs === 0) {
        throw new Error('page echoed the vault value: TEST_ONLY_SECRET');
      }
      return 0;
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'tainted-cmd',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    const results = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((message) => message['type'] === 'command_result'
        && message['commandId'] === 'tainted-cmd');
    // The command's own catch reports first (with the guard's fixed text); the
    // terminal catch reports afterwards. Neither may carry the raw throwable.
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain('TEST_ONLY_SECRET');
    }
    // The terminal catch's report specifically must use the sanitised fixed
    // text. This is the one the credential branch does NOT cover.
    const terminal = results[results.length - 1];
    expect(terminal['error']).toBe(
      'secret_tainted_command_failed_or_may_have_applied_DO_NOT_retry_without_user_verification',
    );
  });

  it('does not treat native-host acknowledgements as poll responses', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayBridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;

    expect(relayBridge.pollInFlight).toBe(true);

    relayPort.emitMessage({ ok: true, result: { queued: true } });
    await flushPromises();

    expect(relayBridge.pollInFlight).toBe(true);
  });

  it('clears an in-flight poll when the native host replies with an explicit error', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayBridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;

    expect(relayBridge.pollInFlight).toBe(true);

    relayPort.emitMessage({ ok: false, error: 'socket connect failed: ECONNREFUSED' });
    await flushPromises();

    expect(relayBridge.pollInFlight).toBe(false);
    expect(relayBridge.lastError).toBe('socket connect failed: ECONNREFUSED');
    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          pollInFlight: false,
          pollStartedAt: null,
          lastError: 'socket connect failed: ECONNREFUSED',
        }),
      ]),
    }));
  });

  it('broadcasts tab inventory to every connected native-port bridge', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const legacyPort = harness.ports.get(LEGACY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    legacyPort.postMessage.mockClear();
    relayPort.postMessage.mockClear();

    await harness.reportTabInventory();

    expect(legacyPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab_inventory',
      tabs: expect.arrayContaining([expect.objectContaining({ tabId: 42 })]),
    }));
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab_inventory',
      tabs: expect.arrayContaining([expect.objectContaining({ tabId: 42 })]),
    }));
  });

  it('sanitizes autonomous inventory for every same-origin sibling of a vault-filled tab', async () => {
    const marker = 'TEST_ONLY_SIBLING_SECRET_MARKER';
    const harness = loadBackgroundHarnessForTest({
      additionalTabs: [{ tabId: 43, groupId: -1 }],
    });
    await flushPromises();
    await harness.markSecretTaint(42, 'https://example.test');
    const sibling = harness.tabState(43)!;
    sibling.url = `https://example.test/reflected?value=${marker}`;
    sibling.title = marker;
    harness.chrome.scripting.executeScript.mockImplementation(async () => [{
      result: { title: marker, text: marker },
    }]);
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    await harness.reportTabInventory();

    const inventory = relayPort.postMessage.mock.calls
      .map((args: unknown[]) => args[0] as {
        type?: string;
        tabs?: Record<string, unknown>[];
      })
      .find((message) => message.type === 'tab_inventory');
    expect(inventory?.tabs).toContainEqual(expect.objectContaining({
      tabId: 43,
      url: 'https://example.test/',
      title: 'Secret-filled tab',
      text: '',
      inspectionState: 'secret_tainted',
      textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
    }));
    expect(JSON.stringify(inventory)).not.toContain(marker);
  });

  it('closes a Chrome tab and refuses the last tab in a window', async () => {
    const harness = loadBackgroundHarnessForTest({
      additionalTabs: [{ tabId: 43, groupId: -1 }],
    });
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'close-tab-1',
        command: 'close_tab',
        target: { tabId: 42 },
        payload: { allowCloseLastInWindow: false },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.remove).toHaveBeenCalledWith(42);
    expect(harness.tabState(42)).toBeUndefined();
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'close-tab-1',
      ok: true,
      result: expect.objectContaining({ closed: true, tabId: 42 }),
    }));

    relayPort.postMessage.mockClear();
    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'close-last-tab',
        command: 'close_tab',
        target: { tabId: 43 },
        payload: { allowCloseLastInWindow: false },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'close-last-tab',
      ok: false,
      error: expect.stringContaining('browser_close_last_tab_in_window_refused'),
    }));
    expect(harness.tabState(43)).toBeDefined();
  });

  it('supports an explicit report_inventory command for live target refreshes', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'inventory-command-1',
        command: 'report_inventory',
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tab_inventory',
      tabs: expect.arrayContaining([expect.objectContaining({ tabId: 42 })]),
    }));
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'inventory-command-1',
      ok: true,
    }));
  });

  it('reloads an existing tab in place, closes the status race, and reinstalls diagnostics', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-tab-1',
        command: 'reload',
        target: { tabId: 42 },
        payload: { expectedOrigin: 'https://example.test' },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledOnce();
    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(harness.chrome.scripting.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({
      func: expect.objectContaining({ name: 'installControlGlowScript' }),
    }));
    expect(harness.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      func: expect.objectContaining({ name: 'installCaptureScript' }),
    }));
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-tab-1',
      ok: true,
      result: expect.objectContaining({ tabId: 42, url: 'https://example.test/42' }),
    }));
  });

  it('dispatches reload before a wedged renderer injection and still completes', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockClear();
    const rendererPending = new Promise<never>(() => undefined);
    harness.chrome.scripting.executeScript.mockImplementation(async () => {
      if (harness.chrome.tabs.reload.mock.calls.length === 0) {
        return rendererPending;
      }
      return [{ result: { title: 'Reloaded', text: 'Ready' } }];
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-wedged-renderer',
        command: 'reload',
        target: { tabId: 42 },
        payload: { expectedOrigin: 'https://example.test' },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result', commandId: 'reload-wedged-renderer', ok: true,
    }));
  });

  it('dispatches reload while an inventory owns the secret-observation boundary', async () => {
    const marker = 'TEST_ONLY_OCCUPIED_BOUNDARY_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockClear();
    harness.tabState(42)!.url = `https://example.test/private?value=${marker}`;
    harness.tabState(42)!.title = marker;
    harness.chrome.scripting.executeScript.mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    void harness.reportTabInventory();
    await flushPromises();
    expect(harness.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      func: expect.objectContaining({ name: 'pageBridgeScript' }),
      args: ['snapshot', []],
    }));
    const timerCallCountBeforeReload = harness.timers.setTimeout.mock.calls.length;

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-occupied-secret-boundary',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42);
    const postReloadDeadline = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 5_000);
    expect(postReloadDeadline).toBeDefined();
    (postReloadDeadline?.[0] as (() => void) | undefined)?.();
    await flushPromises();

    const commandResult = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-occupied-secret-boundary');
    expect(commandResult).toEqual(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-occupied-secret-boundary',
      ok: true,
      result: expect.objectContaining({
        tabId: 42,
        url: 'https://example.test/',
        title: 'Tab inspection unavailable',
        text: '',
        inspectionState: 'inspection_unavailable',
        textUnavailableReason: 'browser_secret_inspection_unavailable',
      }),
    }));
    expect(JSON.stringify(commandResult)).not.toContain(marker);
  });

  it('settles reload safely when post-reload page observation and its boundary stay pending', async () => {
    const marker = 'TEST_ONLY_POST_RELOAD_OBSERVATION_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockClear();
    harness.tabState(42)!.url = `https://example.test/private?value=${marker}`;
    harness.tabState(42)!.title = marker;
    harness.chrome.scripting.executeScript.mockImplementation(
      async (params: { func?: { name?: string } }) => {
        if (params.func?.name === 'pageBridgeScript') {
          return new Promise<never>(() => undefined);
        }
        return [{ result: undefined }];
      },
    );
    const timerCallCountBeforeReload = harness.timers.setTimeout.mock.calls.length;

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-pending-post-observation',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(harness.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      func: expect.objectContaining({ name: 'pageBridgeScript' }),
      args: ['snapshot', []],
    }));
    const postReloadDeadline = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 5_000);
    const commandWatchdog = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 30_000);
    expect(postReloadDeadline).toBeDefined();
    expect(commandWatchdog).toBeDefined();
    (postReloadDeadline?.[0] as (() => void) | undefined)?.();
    await flushPromises();

    const commandResults = () => relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-pending-post-observation');
    expect(commandResults()).toEqual([expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-pending-post-observation',
      ok: true,
      result: expect.objectContaining({
        tabId: 42,
        url: 'https://example.test/',
        title: 'Tab inspection unavailable',
        text: '',
        inspectionState: 'inspection_unavailable',
        textUnavailableReason: 'browser_secret_inspection_unavailable',
      }),
    })]);
    expect(JSON.stringify(commandResults())).not.toContain(marker);

    (commandWatchdog?.[0] as (() => void) | undefined)?.();
    await flushPromises();
    expect(commandResults()).toHaveLength(1);
  });

  it('LT-618: applying an unchanged secretObservationProtectionEnabled value does not queue behind an occupied boundary', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();

    // Occupy secretObservationBoundary with an operation that never resolves —
    // standing in for a long-running (possibly orphaned/timed-out) boundary
    // holder such as a stuck tab-inventory build. Every non-reload command
    // re-stamps the SAME current protection value onto its payload
    // (stampSecretObservationProtection on the coordinator), so without the
    // no-op fast path every one of those commands would queue fully behind
    // this indefinitely, even though nothing here actually needs to change.
    harness.chrome.tabs.query.mockImplementationOnce(() => new Promise<never>(() => undefined));
    void harness.markSecretTaint(42, 'https://example.test');
    await flushPromises();

    // Protection is already ON by default, so applying `true` again is a
    // genuine no-op and must resolve immediately rather than wait for the
    // still-pending boundary holder above.
    await expect(harness.applySecretObservationProtectionEnabled(true))
      .resolves.toBeUndefined();
  });

  it('does not re-enter a pending observation boundary from the reload watchdog failure path', async () => {
    const marker = 'TEST_ONLY_RELOAD_WATCHDOG_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockClear();
    harness.tabState(42)!.url = `https://example.test/private?value=${marker}`;
    harness.tabState(42)!.title = marker;
    harness.chrome.scripting.executeScript.mockImplementation(
      async (params: { func?: { name?: string } }) => {
        if (params.func?.name === 'pageBridgeScript') {
          return new Promise<never>(() => undefined);
        }
        return [{ result: undefined }];
      },
    );
    const timerCallCountBeforeReload = harness.timers.setTimeout.mock.calls.length;

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-watchdog-pending-observation',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).toHaveBeenCalledWith(42);
    const commandWatchdog = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 30_000);
    expect(commandWatchdog).toBeDefined();
    (commandWatchdog?.[0] as (() => void) | undefined)?.();
    await flushPromises();

    const commandResults = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-watchdog-pending-observation');
    expect(commandResults).toEqual([expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-watchdog-pending-observation',
      ok: false,
      error: 'browser_reload_failed_or_may_have_applied',
    })]);
    expect(JSON.stringify(commandResults)).not.toContain(marker);
  });

  it('fails closed when reload redirects before the unavailable-observation fallback', async () => {
    const marker = 'TEST_ONLY_RELOAD_REDIRECT_TIMEOUT_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockImplementation(async (tabId: number) => {
      const tab = harness.tabState(tabId)!;
      tab.url = `https://disallowed.example.test/after?value=${marker}`;
      tab.title = marker;
      tab.status = 'complete';
    });
    harness.chrome.scripting.executeScript.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const timerCallCountBeforeReload = harness.timers.setTimeout.mock.calls.length;

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-redirect-before-unavailable-fallback',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    const postReloadDeadline = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 5_000);
    if (postReloadDeadline) {
      (postReloadDeadline[0] as (() => void))();
      await flushPromises();
    }

    const commandResult = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-redirect-before-unavailable-fallback');
    expect(commandResult).toEqual(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-redirect-before-unavailable-fallback',
      ok: false,
      error: 'browser_reload_origin_changed_after_dispatch',
    }));
    expect(JSON.stringify(commandResult)).not.toContain(marker);
  });

  it('fails closed when a secret-tainted reload redirects before protected reporting', async () => {
    const marker = 'TEST_ONLY_RELOAD_REDIRECT_TAINT_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    await harness.markSecretTaint(42, 'https://example.test');
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockImplementation(async (tabId: number) => {
      const tab = harness.tabState(tabId)!;
      tab.url = `https://disallowed.example.test/after?value=${marker}`;
      tab.title = marker;
      tab.status = 'complete';
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-redirect-before-taint-report',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    const commandResult = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-redirect-before-taint-report');
    expect(commandResult).toEqual(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-redirect-before-taint-report',
      ok: false,
      error: 'browser_reload_origin_changed_after_dispatch',
    }));
    expect(JSON.stringify(commandResult)).not.toContain(marker);
  });

  it('uses the expected origin only when Chrome cannot report a post-reload URL', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockImplementation(async (tabId: number) => {
      const tab = harness.tabState(tabId)!;
      tab.url = '';
      tab.title = 'TEST_ONLY_UNAVAILABLE_POST_URL_TITLE';
      tab.status = 'complete';
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-missing-post-url',
        command: 'reload',
        target: { tabId: 42 },
        payload: { expectedOrigin: 'https://example.test' },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-missing-post-url',
      ok: true,
      result: expect.objectContaining({
        url: 'https://example.test/',
        title: 'Tab inspection unavailable',
        inspectionState: 'inspection_unavailable',
        textUnavailableReason: 'browser_secret_inspection_unavailable',
      }),
    }));
    expect(JSON.stringify(relayPort.postMessage.mock.calls))
      .not.toContain('TEST_ONLY_UNAVAILABLE_POST_URL_TITLE');
  });

  it('rechecks the live origin after a pending post-reload observation times out', async () => {
    const marker = 'TEST_ONLY_RELOAD_TIMEOUT_TOCTOU_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const timerCallCountBeforeReload = harness.timers.setTimeout.mock.calls.length;

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-timeout-origin-toctou',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    const postReloadDeadline = harness.timers.setTimeout.mock.calls
      .slice(timerCallCountBeforeReload)
      .find((call: unknown[]) => call[1] === 5_000);
    expect(postReloadDeadline).toBeDefined();
    harness.tabState(42)!.url = `https://disallowed.example.test/late?value=${marker}`;
    harness.tabState(42)!.title = marker;
    (postReloadDeadline?.[0] as (() => void) | undefined)?.();
    await flushPromises();

    const commandResults = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-timeout-origin-toctou');
    expect(commandResults).toEqual([expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-timeout-origin-toctou',
      ok: false,
      error: 'browser_reload_origin_changed_after_dispatch',
    })]);
    expect(JSON.stringify(commandResults)).not.toContain(marker);
  });

  it('rechecks the live origin after readable post-reload diagnostics settle', async () => {
    const marker = 'TEST_ONLY_RELOAD_READABLE_TOCTOU_MARKER';
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockImplementation(
      async (params: { func?: { name?: string } }) => {
        if (params.func?.name === 'installCaptureScript') {
          harness.tabState(42)!.url = `https://disallowed.example.test/late?value=${marker}`;
          harness.tabState(42)!.title = marker;
          return [{ result: undefined }];
        }
        if (params.func?.name === 'pageBridgeScript') {
          return [{ result: { title: marker, text: marker } }];
        }
        return [{ result: undefined }];
      },
    );

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-readable-origin-toctou',
        command: 'reload',
        target: { tabId: 42 },
        payload: {
          expectedOrigin: 'https://example.test',
          secretObservationProtectionEnabled: true,
        },
      },
    });
    await flushPromises();

    const commandResults = relayPort.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((message) => message['type'] === 'command_result'
        && message['commandId'] === 'reload-readable-origin-toctou');
    expect(commandResults).toEqual([expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-readable-origin-toctou',
      ok: false,
      error: 'browser_reload_origin_changed_after_dispatch',
    })]);
    expect(JSON.stringify(commandResults)).not.toContain(marker);
  });

  it('rechecks the live tab origin immediately before reload and refuses a mismatch', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.tabs.reload.mockClear();
    harness.tabState(42)!.url = 'https://evil.example.test/private';

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'reload-origin-mismatch',
        command: 'reload',
        target: { tabId: 42 },
        payload: { expectedOrigin: 'https://example.test' },
      },
    });
    await flushPromises();

    expect(harness.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'reload-origin-mismatch',
      ok: false,
      error: 'browser_reload_origin_changed_before_dispatch',
    }));
  });

  it('forwards a snapshot selector through the real extension command path', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'snapshot-selector',
        command: 'snapshot',
        target: { tabId: 42 },
        payload: { selector: '#status' },
      },
    });
    await flushPromises();

    expect(harness.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      func: expect.objectContaining({ name: 'pageBridgeScript' }),
      args: ['snapshot', ['#status']],
    }));
    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result', commandId: 'snapshot-selector', ok: true,
    }));
  });

  it('discards copied-tab snapshot evidence when the browser-process origin changes during capture', async () => {
    const marker = 'TEST_ONLY_SNAPSHOT_REDIRECT_MARKER';
    const result = await captureSnapshotAcrossRedirect(marker);

    expect(result).toMatchObject({
      tabId: 42,
      url: 'https://example.test/',
      title: 'Tab inspection unavailable',
      text: '',
      inspectionState: 'inspection_unavailable',
      textUnavailableReason: 'browser_secret_inspection_unavailable',
    });
    expect(result).not.toHaveProperty('selectorText');
    expect(result).not.toHaveProperty('selectorFingerprint');
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain('evil.example.test');
  });

  it('cannot turn copied-tab redirect evidence into a production no-effect result', async () => {
    const marker = 'TEST_ONLY_SNAPSHOT_NO_EFFECT_MARKER';
    const redirectedSnapshot = await captureSnapshotAcrossRedirect(marker);
    vi.useFakeTimers();
    vi.setSystemTime(1_100_000);
    try {
      const existingTab = {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
        title: 'Before',
        url: 'https://example.test/page',
        origin: 'https://example.test',
        text: 'Before',
        allowedOrigins: [{
          scheme: 'https' as const,
          hostPattern: 'example.test',
          includeSubdomains: false,
        }],
      };
      const sendCommand = vi.fn(async (request: { command: string }) => (
        request.command === 'click' ? { clicked: true } : redirectedSnapshot
      ));
      const { service } = makeService({
        existingTab,
        grants: [makeGrant({
          profileId: existingTab.profileId,
          allowedOrigins: existingTab.allowedOrigins,
        })],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        selector: '#save',
        expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({
        decision: 'allowed',
        outcome: 'failed',
        reason: 'browser_effect_observation_unverified',
        data: null,
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain('evil.example.test');
      expect(sendCommand.mock.calls.filter(([request]) => request.command === 'click')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fingerprints the full selector text while returning only its bounded preview', async () => {
    const harness = loadBackgroundHarnessForTest();
    const prefix = 'x'.repeat(1_000);

    const before = await harness.runPageBridgeSnapshot(
      `<div id="status">${prefix}edit</div>`,
      '#status',
    );
    const after = await harness.runPageBridgeSnapshot(
      `<div id="status">${prefix}done</div>`,
      '#status',
    );

    expect(before['selectorText']).toBe(prefix);
    expect(after['selectorText']).toBe(prefix);
    expect(before['selectorFingerprint']).toMatch(/^[a-f0-9]{64}$/);
    expect(after['selectorFingerprint']).toMatch(/^[a-f0-9]{64}$/);
    expect(after['selectorFingerprint']).not.toBe(before['selectorFingerprint']);
    expect(before['selectorText']).not.toContain('edit');
    expect(after['selectorText']).not.toContain('done');
  });

  it('fingerprints full selector text when the page has no SubtleCrypto', async () => {
    const harness = loadBackgroundHarnessForTest();
    const prefix = 'x'.repeat(1_000);

    const before = await harness.runPageBridgeSnapshot(
      `<div id="status">${prefix} token=alpha</div>`, '#status', { subtleCrypto: false },
    );
    const after = await harness.runPageBridgeSnapshot(
      `<div id="status">${prefix} token=beta</div>`, '#status', { subtleCrypto: false },
    );

    expect(before['selectorText']).toBe(prefix);
    expect(after['selectorText']).toBe(prefix);
    expect(before['selectorFingerprint']).toMatch(/^[a-f0-9]{64}$/);
    expect(after['selectorFingerprint']).toMatch(/^[a-f0-9]{64}$/);
    expect(after['selectorFingerprint']).not.toBe(before['selectorFingerprint']);
    expect(JSON.stringify({ before, after })).not.toContain('alpha');
    expect(JSON.stringify({ before, after })).not.toContain('beta');
  });

  it.each([
    { beforeSubtle: true, afterSubtle: false, direction: 'secure to insecure' },
    { beforeSubtle: false, afterSubtle: true, direction: 'insecure to secure' },
  ])('keeps the same extension fingerprint across $direction contexts', async ({
    beforeSubtle, afterSubtle,
  }) => {
    const harness = loadBackgroundHarnessForTest();
    const html = '<div id="status">unchanged</div>';

    const before = await harness.runPageBridgeSnapshot(
      html, '#status', { subtleCrypto: beforeSubtle },
    );
    const after = await harness.runPageBridgeSnapshot(
      html, '#status', { subtleCrypto: afterSubtle },
    );

    expect(after['selectorFingerprint']).toBe(before['selectorFingerprint']);
  });

  it('uses the same visible-text fingerprint for managed and extension paths', async () => {
    const harness = loadBackgroundHarnessForTest();
    const extension = await harness.runPageBridgeSnapshot(
      '<div id="status">Visible<span>Hidden child</span></div>',
      '#status',
      { innerText: 'Visible' },
    );
    const managedPage = {
      $eval: async (
        _selector: string,
        evaluate: (element: { innerText: string; textContent: string }) => unknown,
      ) => evaluate({
        innerText: 'Visible', textContent: 'VisibleHidden child',
      }),
    };
    const managed = await fingerprintBrowserElementText(
      managedPage as unknown as Pick<Page, '$eval'>, '#status',
    );

    expect(extension['selectorFingerprint']).toBe(managed);
  });

  it('closes the Chrome complete-event race with a post-listener status read', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const tab = harness.tabState(42)!;
    harness.chrome.tabs.get.mockClear();
    harness.chrome.tabs.get
      .mockResolvedValueOnce({ ...tab, status: 'loading' })
      .mockResolvedValueOnce({ ...tab, status: 'complete' });

    await expect(harness.waitForTabComplete(42, 15_000)).resolves.toBeUndefined();

    expect(harness.chrome.tabs.get).toHaveBeenCalledTimes(2);
  });

  // LT-218: browser.snapshot used to swallow a chrome.scripting.executeScript
  // permission rejection into a successful, empty-text result, which read
  // identically to a genuinely blank page. It must now resolve with an
  // explicit textUnavailableReason so a caller (or agent) can tell the two
  // apart, while still resolving successfully rather than hard-failing (a
  // page with one inaccessible iframe should not lose an otherwise-readable
  // snapshot).
  it('flags browser.snapshot text as unavailable when the page injection is denied host permission, without failing the command', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockImplementation(async (params: { args?: unknown[] }) => {
      if (params?.args?.[0] === 'snapshot') {
        throw new Error(
          'Cannot access contents of the page. Extension manifest must request permission to '
          + 'access the respective host.',
        );
      }
      return [{ result: { title: 'Example', text: 'Example page' } }];
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'snapshot-permission-denied',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'snapshot-permission-denied',
      ok: true,
      result: expect.objectContaining({
        text: '',
        url: 'https://example.test/42',
        title: 'Example 42',
        inspectionState: 'inspection_unavailable',
        textUnavailableReason: 'host_permission_denied',
      }),
    }));
  });

  it('flags browser.snapshot text as unavailable with a generic reason for a non-permission injection failure', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();
    harness.chrome.scripting.executeScript.mockImplementation(async (params: { args?: unknown[] }) => {
      if (params?.args?.[0] === 'snapshot') {
        throw new Error('The extensions gallery cannot be scripted.');
      }
      return [{ result: { title: 'Example', text: 'Example page' } }];
    });

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'snapshot-other-failure',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    expect(relayPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command_result',
      commandId: 'snapshot-other-failure',
      ok: true,
      result: expect.objectContaining({
        text: '',
        url: 'https://example.test/42',
        title: 'Example 42',
        inspectionState: 'inspection_unavailable',
        textUnavailableReason: 'page_text_read_failed',
      }),
    }));
  });

  it('does not set textUnavailableReason on a normal browser.snapshot read', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayPort.postMessage.mockClear();

    relayPort.emitMessage({
      type: 'browser_command',
      command: {
        id: 'snapshot-normal',
        command: 'snapshot',
        target: { tabId: 42 },
      },
    });
    await flushPromises();

    const call = relayPort.postMessage.mock.calls
      .map((args: unknown[]) => args[0] as { type?: string; commandId?: string; result?: { text?: string } })
      .find((message) => message?.type === 'command_result' && message?.commandId === 'snapshot-normal');
    expect(call).toEqual(expect.objectContaining({ ok: true }));
    expect(call?.result).not.toHaveProperty('textUnavailableReason');
    expect(call?.result).toEqual(expect.objectContaining({
      text: 'Example page',
      inspectionState: 'readable',
    }));
  });

  it('keeps the legacy bridge polling when the relay host is absent and retries relay on the alarm cadence', async () => {
    const harness = loadBackgroundHarnessForTest({
      failConnectHosts: new Set([RELAY_HOST_NAME]),
    });
    await flushPromises();
    const legacyPort = harness.ports.get(LEGACY_HOST_NAME)!;

    expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(LEGACY_HOST_NAME);
    expect(harness.chrome.runtime.connectNative).toHaveBeenCalledWith(RELAY_HOST_NAME);
    expect(legacyPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
    expect(harness.ports.has(RELAY_HOST_NAME)).toBe(false);
    expect(harness.timers.setTimeout.mock.calls.every(([, delayMs]) => delayMs === 30000)).toBe(true);

    harness.failConnectHosts.clear();
    emitAlarm(harness, 'browser-gateway-inventory');
    await flushPromises();

    expect(harness.ports.get(RELAY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
  });

  it('recycles a no-reply poll through the watchdog timer', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    const watchdogCall = harness.timers.setTimeout.mock.calls
      .filter(([, delayMs]) => delayMs === 30000)[1];

    expect(watchdogCall).toBeDefined();
    harness.timers.setTimeout.mockClear();
    relayPort.disconnect.mockClear();
    harness.advanceTimeBy(30001);
    watchdogCall[0]();

    expect(relayPort.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));
    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          state: 'reconnecting',
          pollInFlight: false,
          pollStartedAt: null,
          silentPollCount: 1,
          lastError: 'browser_extension_poll_timeout',
        }),
      ]),
    }));
  });

  it('uses the inventory alarm as a backstop for stale no-reply polls when timers do not survive', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    harness.timers.setTimeout.mockClear();
    relayPort.disconnect.mockClear();

    harness.advanceTimeBy(30001);
    emitAlarm(harness, 'browser-gateway-inventory');
    await flushPromises();

    expect(relayPort.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          state: 'reconnecting',
          pollInFlight: false,
          pollStartedAt: null,
          silentPollCount: 1,
          lastError: 'browser_extension_poll_timeout',
        }),
      ]),
    }));
  });

  it('self-heals a wedged service worker: hard recycle first, then a rate-limited runtime reload', async () => {
    // The wedge class this covers: an MV3 worker kept alive forever by its
    // open native port, with in-memory state stuck so no polls ever go out.
    // Targeted watchdogs cannot fix variables they do not know about — only
    // a full worker reload can, and this ladder is the only path to one.
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const reload = harness.chrome.runtime.reload;

    // First strike past the reload threshold: recycle only (a reload without
    // first trying the cheap fix would throw away diagnosable state).
    harness.advanceTimeBy(11 * 60_000);
    emitAlarm(harness, 'browser-gateway-inventory');
    await flushPromises();
    expect(reload).not.toHaveBeenCalled();

    // Recycle didn't bring acks back → the worker reloads itself.
    harness.advanceTimeBy(3 * 60_000);
    emitAlarm(harness, 'browser-gateway-inventory');
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(harness.chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ browserGatewayLastSelfReloadAt: expect.any(Number) }),
    );

    // Still dead soon after: rate limit holds — no reload storm on a machine
    // whose gateway is legitimately down.
    harness.advanceTimeBy(3 * 60_000);
    emitAlarm(harness, 'browser-gateway-inventory');
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe('reloading onto the version a worker relay expects', () => {
    const VERSION_KEY = 'browserGatewayVersionReload';

    async function emitIdlePoll(
      harness: BrowserExtensionBackgroundHarness,
      expectedExtensionVersion: unknown,
      hostName = RELAY_HOST_NAME,
    ): Promise<void> {
      harness.ports.get(hostName)!.emitMessage({ type: 'browser_command', command: null, expectedExtensionVersion });
      await flushPromises();
    }

    it('reloads once, while idle, when an unpacked install runs another version', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();

      await emitIdlePoll(harness, '0.2.40');

      expect(harness.chrome.runtime.reload).toHaveBeenCalledTimes(1);
      expect(harness.chrome.storage.local.set).toHaveBeenCalledWith({
        [VERSION_KEY]: { target: '0.2.40', from: '0.1.0', at: 1_000_000 },
      });
    });

    it('does not reload when the running version already matches', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();

      await emitIdlePoll(harness, '0.1.0');

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it.each([
      ['a store install', 'normal'],
      ['no management API', undefined],
    ])('does not reload with %s', async (_label, installType) => {
      const harness = loadBackgroundHarnessForTest(installType === undefined ? {} : { installType });
      await flushPromises();

      await emitIdlePoll(harness, '0.2.40');

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['not a version', '0.2.40 && reload'],
      ['not a string', 40],
    ])('ignores an expected version that is %s', async (_label, expected) => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();

      await emitIdlePoll(harness, expected);

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('tries a given target at most once per six hours, so a wrong folder cannot loop', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();

      await emitIdlePoll(harness, '0.2.40');
      // The reload did not change our version (the folder holds something else).
      harness.advanceTimeBy(60 * 60_000);
      await emitIdlePoll(harness, '0.2.40');
      expect(harness.chrome.runtime.reload).toHaveBeenCalledTimes(1);

      // A different target is a new attempt.
      await emitIdlePoll(harness, '0.2.41');
      expect(harness.chrome.runtime.reload).toHaveBeenCalledTimes(2);

      harness.advanceTimeBy(6 * 60 * 60_000);
      await emitIdlePoll(harness, '0.2.41');
      expect(harness.chrome.runtime.reload).toHaveBeenCalledTimes(3);
    });

    it('does not reload when the attempt cannot be recorded', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();
      harness.chrome.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
        if (VERSION_KEY in values) throw new Error('QUOTA_BYTES quota exceeded');
      });

      await emitIdlePoll(harness, '0.2.40');

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('puts the reload record back when a command arrives while it is being written', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();
      harness.chrome.scripting.executeScript.mockImplementation(() => new Promise(() => undefined));
      harness.chrome.debugger.sendCommand.mockImplementation(() => new Promise(() => undefined));
      const writes: unknown[] = [];
      const set = harness.chrome.storage.local.set.getMockImplementation()!;
      harness.chrome.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
        if (VERSION_KEY in values) {
          writes.push(values[VERSION_KEY]);
          if (writes.length === 1) {
            // Another bridge hands over a command in the gap before the reload.
            harness.ports.get(LEGACY_HOST_NAME)!.emitMessage({
              type: 'browser_command',
              command: { id: 'late-1', command: 'snapshot', target: { tabId: 42 }, payload: {}, createdAt: 1 },
            });
          }
        }
        return set(values);
      });

      await emitIdlePoll(harness, '0.2.40');

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
      expect(writes).toEqual([{ target: '0.2.40', from: '0.1.0', at: 1_000_000 }, null]);
    });

    it('waits while a browser command is still running', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();
      // The command never finishes, so it stays in flight for the whole test.
      harness.chrome.scripting.executeScript.mockImplementation(() => new Promise(() => undefined));
      harness.chrome.debugger.sendCommand.mockImplementation(() => new Promise(() => undefined));
      harness.ports.get(RELAY_HOST_NAME)!.emitMessage({
        type: 'browser_command',
        command: { id: 'busy-1', command: 'snapshot', target: { tabId: 42 }, payload: {}, createdAt: 1 },
      });
      await flushPromises();

      await emitIdlePoll(harness, '0.2.40', LEGACY_HOST_NAME);

      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('reconnects only the bridge whose native host runs an older worker build, once per build', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();
      const stalePort = harness.ports.get(RELAY_HOST_NAME)!;
      const otherPort = harness.ports.get(LEGACY_HOST_NAME)!;
      const staleReply = {
        type: 'browser_command',
        command: null,
        expectedExtensionVersion: '0.1.0',
        nativeHostStale: true,
        workerBuildId: 'build-2',
      };

      stalePort.emitMessage(staleReply);
      await flushPromises();

      expect(stalePort.disconnect).toHaveBeenCalledTimes(1);
      expect(otherPort.disconnect).not.toHaveBeenCalled();
      expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
      const freshPort = harness.ports.get(RELAY_HOST_NAME)!;
      expect(freshPort).not.toBe(stalePort);

      // Still stale after the reconnect (the host points at another checkout):
      // no reconnect storm.
      freshPort.emitMessage(staleReply);
      await flushPromises();
      expect(harness.ports.get(RELAY_HOST_NAME)).toBe(freshPort);
      expect(freshPort.disconnect).not.toHaveBeenCalled();

      // A newer build is a new reason to reconnect.
      freshPort.emitMessage({ ...staleReply, workerBuildId: 'build-3' });
      await flushPromises();
      expect(freshPort.disconnect).toHaveBeenCalledTimes(1);
    });

    it('prefers a full reload when the extension version also differs', async () => {
      const harness = loadBackgroundHarnessForTest({ installType: 'development' });
      await flushPromises();
      const port = harness.ports.get(RELAY_HOST_NAME)!;

      port.emitMessage({
        type: 'browser_command',
        command: null,
        expectedExtensionVersion: '0.2.40',
        nativeHostStale: true,
        workerBuildId: 'build-2',
      });
      await flushPromises();

      expect(harness.chrome.runtime.reload).toHaveBeenCalledTimes(1);
      expect(port.disconnect).not.toHaveBeenCalled();
    });
  });

  it('does not self-heal while the worker is young or while polls are acking', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    const legacyPort = harness.ports.get(LEGACY_HOST_NAME)!;
    relayPort.disconnect.mockClear();
    legacyPort.disconnect.mockClear();

    // Young worker: normal reconnect machinery owns the first minutes.
    harness.advanceTimeBy(2 * 60_000);
    await harness.selfHealIfWedged();
    expect(relayPort.disconnect).not.toHaveBeenCalled();

    // Old worker with a FRESH ack: channel is healthy, hands off.
    harness.advanceTimeBy(4 * 60_000);
    relayPort.emitMessage({ type: 'browser_command', command: null });
    await flushPromises();
    await harness.selfHealIfWedged();
    expect(relayPort.disconnect).not.toHaveBeenCalled();
    expect(legacyPort.disconnect).not.toHaveBeenCalled();

    // The ack goes stale → rung 1 recycles every bridge.
    harness.advanceTimeBy(6 * 60_000);
    await harness.selfHealIfWedged();
    expect(relayPort.disconnect).toHaveBeenCalledTimes(1);
    expect(legacyPort.disconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores late disconnect events from a recycled stale-poll port after reconnect', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const bridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const oldRelayPort = harness.ports.get(RELAY_HOST_NAME)!;
    oldRelayPort.disconnect.mockImplementation(() => undefined);
    const watchdogCall = harness.timers.setTimeout.mock.calls
      .filter(([, delayMs]) => delayMs === 30000)[1];

    harness.timers.setTimeout.mockClear();
    harness.advanceTimeBy(30001);
    watchdogCall[0]();
    const reconnectCall = harness.timers.setTimeout.mock.calls
      .find(([, delayMs]) => typeof delayMs === 'number' && delayMs !== 30000);
    expect(reconnectCall).toBeDefined();
    reconnectCall![0]();
    await flushPromises();
    const newRelayPort = harness.ports.get(RELAY_HOST_NAME)!;
    expect(newRelayPort).not.toBe(oldRelayPort);

    oldRelayPort.emitDisconnect('Native host exited late.');

    expect(bridge.nativePort).toBe(newRelayPort);
    expect(bridge.state).toBe('connected');
  });

  it('marks native-host-not-found disconnects absent without scheduling hot reconnects', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    harness.timers.setTimeout.mockClear();

    relayPort.emitDisconnect('Specified native messaging host not found.');

    expect(harness.timers.setTimeout).not.toHaveBeenCalled();
    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          state: 'absent',
        }),
      ]),
    }));
  });

  it('backs off reconnects for live native ports that disconnect after startup', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    harness.timers.setTimeout.mockClear();

    relayPort.emitDisconnect('Native host exited.');

    expect(harness.timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));
    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          state: 'reconnecting',
        }),
      ]),
    }));
  });

  it('caps a current native-host-exit reconnect without touching tabs or reloading Chrome', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const relayBridge = harness.bridges.find((candidate) => candidate.hostName === RELAY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
    relayBridge.reconnectAttempts = 12;
    harness.timers.setTimeout.mockClear();
    harness.chrome.runtime.reload.mockClear();
    harness.chrome.tabs.query.mockClear();
    harness.chrome.tabs.reload.mockClear();
    harness.chrome.tabs.update.mockClear();
    harness.chrome.tabs.remove.mockClear();

    relayPort.emitDisconnect('Native host has exited.');

    const reconnectDelays = harness.timers.setTimeout.mock.calls
      .map(([, delayMs]) => delayMs)
      .filter((delayMs): delayMs is number => typeof delayMs === 'number');
    expect(reconnectDelays).toHaveLength(1);
    expect(reconnectDelays[0]).toBeGreaterThanOrEqual(1_000);
    expect(reconnectDelays[0]).toBeLessThanOrEqual(5_000);
    expect(harness.chrome.runtime.reload).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.query).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.update).not.toHaveBeenCalled();
    expect(harness.chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('persists per-bridge status snapshots for the popup', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();

    expect(harness.chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({
      browserGatewayBridgeStatus: expect.arrayContaining([
        expect.objectContaining({
          hostName: LEGACY_HOST_NAME,
          kind: 'local',
          state: 'connected',
        }),
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          kind: 'relay',
          state: 'connected',
        }),
      ]),
    }));
  });

  it('serves popup status through getStatus with bridge state, shared tabs, and extension version', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();

    const response = await harness.sendMessage({ type: 'getStatus' });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      extensionVersion: '0.1.0',
      sharedTabs: [],
      bridges: expect.arrayContaining([
        expect.objectContaining({
          hostName: LEGACY_HOST_NAME,
          kind: 'local',
          state: 'connected',
          lastPollAckAt: null,
          lastError: null,
          silentPollCount: 0,
        }),
        expect.objectContaining({
          hostName: RELAY_HOST_NAME,
          kind: 'relay',
          state: 'connected',
        }),
      ]),
    }));
  });

  it('shares tabs only with bridges already connected in the disclosed status', async () => {
    const harness = loadBackgroundHarnessForTest();
    await flushPromises();
    const localPort = harness.ports.get(LEGACY_HOST_NAME)!;
    const relayPort = harness.ports.get(RELAY_HOST_NAME)!;

    relayPort.emitDisconnect('Native host exited.');
    await flushPromises();
    harness.chrome.runtime.connectNative.mockClear();
    localPort.postMessage.mockClear();
    relayPort.postMessage.mockClear();

    const response = await harness.sendMessage({ type: 'share_active_tab' });
    await flushPromises();

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      recipients: [{
        hostName: LEGACY_HOST_NAME,
        kind: 'local',
      }],
    }));
    expect(localPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'attach_tab',
    }));
    expect(relayPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'attach_tab',
    }));
    expect(harness.chrome.runtime.connectNative).not.toHaveBeenCalledWith(RELAY_HOST_NAME);
  });

  it('reconnects every bridge immediately when the popup requests reconnect', async () => {
    const harness = loadBackgroundHarnessForTest({
      failConnectHosts: new Set([RELAY_HOST_NAME]),
    });
    await flushPromises();
    expect(harness.ports.has(RELAY_HOST_NAME)).toBe(false);

    harness.failConnectHosts.clear();
    const response = await harness.sendMessage({ type: 'reconnect_bridges' });
    await flushPromises();

    expect(response).toEqual(expect.objectContaining({ ok: true }));
    expect(harness.ports.get(LEGACY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
    expect(harness.ports.get(RELAY_HOST_NAME)?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'poll_command',
      timeoutMs: 10000,
    }));
  });

  it('derives toolbar badge severity from bridge outage duration', () => {
    const harness = loadBackgroundHarnessForTest();
    const now = 1_000_000;

    expect(harness.deriveToolbarBadgeState([
      { state: 'absent', lastPollAckAt: null, unhealthySince: now - 61_000 },
      { state: 'reconnecting', lastPollAckAt: now - 61_000, unhealthySince: now - 61_000 },
    ], now)).toEqual({ text: '!', color: '#dc2626' });

    expect(harness.deriveToolbarBadgeState([
      { state: 'connected', lastPollAckAt: now, unhealthySince: null },
      { state: 'absent', lastPollAckAt: null, unhealthySince: now - 61_000 },
    ], now)).toEqual({ text: '!', color: '#f59e0b' });

    expect(harness.deriveToolbarBadgeState([
      { state: 'connected', lastPollAckAt: now, unhealthySince: null },
      { state: 'absent', lastPollAckAt: null, unhealthySince: now - 30_000 },
    ], now)).toEqual({ text: '', color: null });
  });

  it('renders popup gateway status rows, reconnect action, gateway toggle, and share disclosure', async () => {
    const popup = loadPopupHarness({
      ok: true,
      gatewayEnabled: true,
      extensionVersion: '0.1.0',
      sharedTabs: [{
        tabId: 42,
        title: 'Example Docs',
        url: 'https://example.test/docs',
        sharedAt: 1_000_000,
        recipients: [{ kind: 'relay', hostName: RELAY_HOST_NAME }],
      }],
      bridges: [
        {
          hostName: LEGACY_HOST_NAME,
          kind: 'local',
          state: 'connected',
          reconnectAttempts: 0,
          lastPollAckAt: 999_000,
          lastError: null,
          silentPollCount: 0,
        },
        {
          hostName: RELAY_HOST_NAME,
          kind: 'relay',
          state: 'absent',
          reconnectAttempts: 0,
          lastPollAckAt: null,
          lastError: 'Specified native messaging host not found.',
          silentPollCount: 2,
        },
      ],
    });
    await flushPromises();

    expect(popup.document.querySelector('[data-gateway-kind="local"]')?.textContent)
      .toContain('Harness app');
    expect(popup.document.querySelector('[data-gateway-kind="relay"]')?.textContent)
      .toContain('Worker relay');
    expect(popup.document.getElementById('share-disclosure')?.textContent)
      .toContain('Share sends this tab to Harness app');
    expect(popup.document.getElementById('shared-tabs')?.textContent)
      .toContain('Example Docs');
    expect((popup.document.getElementById('gateway-enabled') as HTMLInputElement | null)?.checked)
      .toBe(true);

    popup.document.getElementById('reconnect')?.dispatchEvent(new popup.window.Event('click'));
    await flushPromises();

    expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'reconnect_bridges' });
  });

  it('renders the Browser Gateway toggle as off while login-safe mode is active', async () => {
    const popup = loadPopupHarness({
      ok: true,
      gatewayEnabled: false,
      extensionVersion: '0.1.0',
      sharedTabs: [],
      bridges: [
        {
          hostName: LEGACY_HOST_NAME,
          kind: 'local',
          state: 'disabled',
          reconnectAttempts: 0,
          lastPollAckAt: null,
          lastError: null,
          silentPollCount: 0,
        },
        {
          hostName: RELAY_HOST_NAME,
          kind: 'relay',
          state: 'disabled',
          reconnectAttempts: 0,
          lastPollAckAt: null,
          lastError: null,
          silentPollCount: 0,
        },
      ],
    });
    await flushPromises();

    const gatewayToggle = popup.document.getElementById('gateway-enabled') as HTMLInputElement | null;

    expect(gatewayToggle?.checked).toBe(false);
    expect(popup.document.getElementById('share')).toHaveProperty('disabled', true);
    expect(popup.document.getElementById('share-disclosure')?.textContent)
      .toContain('Browser Gateway is off');

    if (gatewayToggle) {
      gatewayToggle.checked = true;
      gatewayToggle.dispatchEvent(new popup.window.Event('change'));
    }
    await flushPromises();

    expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'set_gateway_enabled',
      enabled: true,
    });
  });

  it('does not install the open-shadow page patch as a global content script', () => {
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { content_scripts?: Record<string, unknown>[] };
    const openShadow = readFileSync('resources/browser-extension/open-shadow-roots.js', 'utf-8');

    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(openShadow).toContain('attachShadow');
    expect(openShadow).toContain("mode: 'open'");
  });

  it('shows a dev-only extension reload action in the popup', () => {
    const popupHtml = readFileSync('resources/browser-extension/popup.html', 'utf-8');
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popupHtml).toContain('id="reload"');
    expect(popupHtml).toContain('Reload Extension');
    expect(popup).toContain('isDevExtension');
    expect(popup).toContain('getManifest().update_url');
    expect(popup).toContain('chrome.runtime.reload()');
  });

  describe('keyboard, viewport and zoom controls', () => {
    function lastCommandResult(
      harness: BrowserExtensionBackgroundHarness,
      commandId: string,
    ): Record<string, unknown> | undefined {
      return harness.ports.get(RELAY_HOST_NAME)!.postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, unknown>)
        .find((message) => message['type'] === 'command_result'
          && message['commandId'] === commandId);
    }

    async function dispatchControlCommand(
      harness: BrowserExtensionBackgroundHarness,
      commandId: string,
      command: string,
      payload?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
      const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
      relayPort.postMessage.mockClear();
      relayPort.emitMessage({
        type: 'browser_command',
        command: { id: commandId, command, target: { tabId: 42 }, payload },
      });
      await flushPromises();
      return lastCommandResult(harness, commandId);
    }

    it('dispatches native key events with modifiers and reads the focus back secret-free', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const keyEvents: { type: string; vk: number | undefined; modifiers: number | undefined; text?: string }[] = [];
      let focusExpression = '';
      harness.chrome.debugger.sendCommand.mockImplementation(
        async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
          if (method === 'Input.dispatchKeyEvent') {
            keyEvents.push({
              type: String(params?.['type']),
              vk: params?.['windowsVirtualKeyCode'] as number | undefined,
              modifiers: params?.['modifiers'] as number | undefined,
              ...(typeof params?.['text'] === 'string' ? { text: params['text'] as string } : {}),
            });
            return {};
          }
          if (method === 'Runtime.evaluate') {
            focusExpression = String(params?.['expression'] ?? '');
            return {
              result: {
                value: {
                  focus: {
                    tagName: 'A',
                    role: 'link',
                    id: 'help-link',
                  },
                },
              },
            };
          }
          return {};
        },
      );

      const result = await dispatchControlCommand(harness, 'press-1', 'press_key', {
        key: 'Tab',
        modifiers: ['Shift'],
        idempotencyKey: 'focus-back-1',
      });

      expect(result?.['ok']).toBe(true);
      expect(result?.['result']).toMatchObject({
        applied: true,
        key: 'Tab',
        modifiers: ['Shift'],
        focus: { tagName: 'A', role: 'link', id: 'help-link' },
      });
      // Native sequence: modifier down, rawKeyDown, (char), keyUp, modifier up.
      expect(keyEvents.map((event) => [event.type, event.vk])).toEqual([
        ['rawKeyDown', 16],
        ['rawKeyDown', 9],
        ['keyUp', 9],
        ['keyUp', 16],
      ]);
      // The main key event carries the Shift modifier bit.
      expect(keyEvents[1].modifiers).toBe(8);
      // The in-page focus read-back must never touch field values.
      expect(focusExpression).toContain("type === 'password'");
      expect(focusExpression).not.toContain('el.value');
      expect(focusExpression).not.toContain('.value');
    });

    it('always releases modifiers even when the key dispatch fails', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const keyEvents: { type: string; vk: number | undefined }[] = [];
      harness.chrome.debugger.sendCommand.mockImplementation(
        async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
          if (method === 'Input.dispatchKeyEvent') {
            const type = String(params?.['type']);
            const vk = params?.['windowsVirtualKeyCode'] as number | undefined;
            keyEvents.push({ type, vk });
            if (vk === 13 && type === 'keyUp') {
              throw new Error('CDP hop failed mid-press');
            }
            return {};
          }
          return {};
        },
      );

      const result = await dispatchControlCommand(harness, 'press-2', 'press_key', {
        key: 'Enter',
        modifiers: ['Shift', 'Control'],
      });

      expect(result?.['ok']).toBe(false);
      // Shift+Control were held when the failure hit; both must be released.
      // Enter carries text ('\r'), so a char event sits between down and up.
      expect(keyEvents.map((event) => [event.type, event.vk])).toEqual([
        ['rawKeyDown', 16],
        ['rawKeyDown', 17],
        ['rawKeyDown', 13],
        ['char', 13],
        ['keyUp', 13],
        ['keyUp', 17],
        ['keyUp', 16],
      ]);
    });

    it('suppresses a retried activation behind the same idempotencyKey', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const sendCommand = harness.chrome.debugger.sendCommand;
      sendCommand.mockImplementation(
        async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
          if (method === 'Input.dispatchKeyEvent') {
            return {};
          }
          if (method === 'Runtime.evaluate') {
            return { result: { value: { focus: { tagName: 'A', text: 'Next' } } } };
          }
          return {};
        },
      );
      const countKeyEvents = () => sendCommand.mock.calls.filter(
        (call: unknown[]) => call[1] === 'Input.dispatchKeyEvent',
      ).length;

      const first = await dispatchControlCommand(harness, 'press-3a', 'press_key', {
        key: 'Enter',
        idempotencyKey: 'activate-next-1',
      });
      const eventsAfterFirst = countKeyEvents();
      const second = await dispatchControlCommand(harness, 'press-3b', 'press_key', {
        key: 'Enter',
        idempotencyKey: 'activate-next-1',
      });

      expect(first?.['ok']).toBe(true);
      expect(first?.['result']).toMatchObject({ applied: true });
      expect((first?.['result'] as Record<string, unknown>)['deduplicated']).toBeUndefined();
      expect(second?.['ok']).toBe(true);
      expect(second?.['result']).toMatchObject({ applied: true, deduplicated: true });
      // The retry pressed nothing.
      expect(countKeyEvents()).toBe(eventsAfterFirst);
    });

    it('burns the idempotencyKey of a failed press so a retry cannot re-fire it', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const sendCommand = harness.chrome.debugger.sendCommand;
      sendCommand.mockImplementation(
        async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
          if (method === 'Input.dispatchKeyEvent') {
            if (String(params?.['type']) === 'keyUp') {
              throw new Error('CDP hop failed after keyDown landed');
            }
            return {};
          }
          return {};
        },
      );
      const countKeyEvents = () => sendCommand.mock.calls.filter(
        (call: unknown[]) => call[1] === 'Input.dispatchKeyEvent',
      ).length;

      const first = await dispatchControlCommand(harness, 'press-5a', 'press_key', {
        key: 'Enter',
        idempotencyKey: 'activate-fragile-1',
      });
      const eventsAfterFailure = countKeyEvents();
      const retry = await dispatchControlCommand(harness, 'press-5b', 'press_key', {
        key: 'Enter',
        idempotencyKey: 'activate-fragile-1',
      });

      // The original attempt failed and must not claim success...
      expect(first?.['ok']).toBe(false);
      // ...and the retry is suppressed without pressing again and without
      // claiming the activation happened.
      expect(retry?.['ok']).toBe(true);
      expect(retry?.['result']).toMatchObject({
        applied: false,
        key: 'Enter',
        deduplicated: true,
      });
      expect(countKeyEvents()).toBe(eventsAfterFailure);
    });

    it('refuses printable keys so credential typing cannot bypass the type hard stops', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const result = await dispatchControlCommand(harness, 'press-4', 'press_key', { key: 'A' });

      expect(result?.['ok']).toBe(false);
      expect(String(result?.['error'])).toContain('Unsupported press_key key');
    });

    it('emulates a tab-scoped viewport and clears it on reset', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const cdpCalls: { method: string; params?: Record<string, unknown> }[] = [];
      harness.chrome.debugger.sendCommand.mockImplementation(
        async (_debuggee: unknown, method: string, params?: Record<string, unknown>) => {
          cdpCalls.push({ method, ...(params ? { params } : {}) });
          if (method === 'Emulation.getDeviceMetricsOverride') {
            const override = cdpCalls.find((call) => call.method === 'Emulation.setDeviceMetricsOverride');
            return override
              ? { width: override.params?.['width'], height: override.params?.['height'] }
              : { width: 0, height: 0 };
          }
          return {};
        },
      );
      harness.chrome.scripting.executeScript.mockImplementation(async () => [{
        result: { innerWidth: 768, innerHeight: 1024 },
      }]);

      const set = await dispatchControlCommand(harness, 'vp-1', 'set_viewport', {
        width: 768,
        height: 1024,
      });
      expect(set?.['ok']).toBe(true);
      expect(set?.['result']).toMatchObject({
        mode: 'tab_emulation',
        scope: 'tab',
        requested: { width: 768, height: 1024 },
        actual: { innerWidth: 768, innerHeight: 1024 },
      });
      expect(cdpCalls.some((call) => call.method === 'Emulation.setDeviceMetricsOverride'
        && call.params?.['width'] === 768 && call.params?.['height'] === 1024
        && call.params?.['deviceScaleFactor'] === 1)).toBe(true);

      const reset = await dispatchControlCommand(harness, 'vp-2', 'set_viewport', { reset: true });
      expect(reset?.['ok']).toBe(true);
      expect(reset?.['result']).toMatchObject({ mode: 'reset', scope: 'tab' });
      expect(cdpCalls.some((call) => call.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true);
    });

    it('resizes the real Chrome window on window scope and restores the recorded bounds', async () => {
      const harness = loadBackgroundHarnessForTest({ additionalTabs: [{ tabId: 43, groupId: -1 }] });
      await flushPromises();
      harness.chrome.scripting.executeScript.mockImplementation(async () => [{
        result: { innerWidth: 1024, innerHeight: 768 },
      }]);

      const set = await dispatchControlCommand(harness, 'vpw-1', 'set_viewport', {
        width: 1024,
        height: 768,
        scope: 'window',
      });
      expect(set?.['ok']).toBe(true);
      expect(set?.['result']).toMatchObject({
        mode: 'window_resize',
        scope: 'window',
        window: {
          windowId: 7,
          otherTabIds: [43],
          bounds: { width: 1024, height: 768 },
        },
        previous: {
          emulationActive: false,
          windowBounds: { left: 10, top: 20, width: 1280, height: 800 },
        },
      });
      expect(harness.chrome.windows.update).toHaveBeenCalledWith(7, {
        state: 'normal',
        width: 1024,
        height: 768,
      });

      const reset = await dispatchControlCommand(harness, 'vpw-2', 'set_viewport', {
        scope: 'window',
        reset: true,
      });
      expect(reset?.['ok']).toBe(true);
      expect(harness.chrome.windows.update).toHaveBeenLastCalledWith(7, {
        state: 'normal',
        left: 10,
        top: 20,
        width: 1280,
        height: 800,
      });
    });

    it('reports a lost window-bounds baseline explicitly instead of claiming restoration', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const reset = await dispatchControlCommand(harness, 'vpw-3', 'set_viewport', {
        scope: 'window',
        reset: true,
      });

      expect(reset?.['ok']).toBe(true);
      expect(reset?.['result']).toMatchObject({
        mode: 'reset',
        restorationFailed: 'browser_window_bounds_baseline_lost',
      });
    });

    it('sets real Chrome zoom tab-scoped and restores factor and settings on reset', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      harness.chrome.scripting.executeScript.mockImplementation(async () => [{
        result: { innerWidth: 640, innerHeight: 512 },
      }]);

      const set = await dispatchControlCommand(harness, 'zoom-1', 'set_zoom', { zoomFactor: 2 });
      expect(set?.['ok']).toBe(true);
      expect(set?.['result']).toMatchObject({
        mode: 'set',
        zoomFactor: 2,
        zoomPercent: 200,
        previousZoomFactor: 1,
        previousZoomScope: 'per-origin',
        zoomScope: 'per-tab',
        viewport: { innerWidth: 640, innerHeight: 512 },
      });
      expect(harness.chrome.tabs.setZoomSettings).toHaveBeenCalledWith(42, { scope: 'per-tab' });
      expect(harness.chrome.tabs.setZoom).toHaveBeenCalledWith(42, 2);

      const reset = await dispatchControlCommand(harness, 'zoom-2', 'set_zoom', { reset: true });
      expect(reset?.['ok']).toBe(true);
      expect(reset?.['result']).toMatchObject({ mode: 'reset', zoomFactor: 1 });
      // The original settings come back, not the per-tab switch.
      expect(harness.chrome.tabs.setZoomSettings).toHaveBeenLastCalledWith(42, { scope: 'per-origin' });
      expect(harness.chrome.tabs.setZoom).toHaveBeenLastCalledWith(42, 1);
    });

    it('reports a lost zoom baseline explicitly instead of restoring blindly', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const reset = await dispatchControlCommand(harness, 'zoom-3', 'set_zoom', { reset: true });

      expect(reset?.['ok']).toBe(true);
      expect(reset?.['result']).toMatchObject({
        mode: 'reset',
        restorationFailed: 'browser_zoom_baseline_lost',
      });
    });
  });

  describe('HTTP authentication prompts (Chrome\'s own sign-in box)', () => {
    interface AuthChallengeDetails {
      tabId: number;
      url: string;
      scheme: string;
      realm?: string;
      requestId: string;
      challenger: { host: string; port: number };
      isProxy?: boolean;
      type?: string;
      timeStamp?: number;
    }

    function emitAuthChallenge(
      harness: BrowserExtensionBackgroundHarness,
      details: AuthChallengeDetails,
    ): { responded: boolean; response: unknown } {
      let responded = false;
      let response: unknown;
      harness.chrome.webRequest.onAuthRequired.emit(
        {
          method: 'GET',
          type: 'main_frame',
          timeStamp: 1_000_000,
          isProxy: false,
          ...details,
        },
        (value: unknown) => {
          responded = true;
          response = value;
        },
      );
      return { responded, response };
    }

    function commandResultFor(
      relayPort: NativePortHarness,
      commandId: string,
    ): Record<string, unknown> | undefined {
      return relayPort.postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message['type'] === 'command_result'
          && message['commandId'] === commandId);
    }

    async function dispatchExtensionCommand(
      harness: BrowserExtensionBackgroundHarness,
      command: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
      const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
      relayPort.postMessage.mockClear();
      relayPort.emitMessage({ type: 'browser_command', command });
      await flushPromises();
      return commandResultFor(
        relayPort,
        command['id'] as string,
      );
    }

    it('reports a challenge waiting on a tab instead of a silent success (step-0 reproduction)', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      // Chrome is holding the tab on its Basic Auth dialog while navigate runs:
      // today's build reports a normal payload and nothing about the prompt.
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          emitAuthChallenge(harness, {
            tabId,
            url: 'https://example.test/protected',
            scheme: 'Basic',
            realm: 'Members',
            requestId: 'auth-req-1',
            challenger: { host: 'example.test', port: 443 },
          });
        }
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'navigate-into-challenge',
        command: 'navigate',
        target: { tabId: 42 },
        payload: { url: 'https://example.test/protected' },
      });

      expect(message?.['ok']).toBe(true);
      expect(message?.['result']).toMatchObject({
        httpAuthChallenge: {
          origin: 'https://example.test',
          scheme: 'Basic',
          realm: 'Members',
        },
      });
    });

    it('drops the waiting-challenge report once the load completes', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          emitAuthChallenge(harness, {
            tabId,
            url: 'https://example.test/protected',
            scheme: 'Basic',
            requestId: 'auth-req-1',
            challenger: { host: 'example.test', port: 443 },
          });
        }
        return harness.tabState(tabId);
      });
      await dispatchExtensionCommand(harness, {
        id: 'navigate-record-challenge',
        command: 'navigate',
        target: { tabId: 42 },
        payload: { url: 'https://example.test/protected' },
      });
      expect(harness.httpAuthChallengeForTab(42)).toMatchObject({
        origin: 'https://example.test',
      });

      // The user answered (or cancelled) Chrome's dialog and the load finished.
      harness.chrome.tabs.onUpdated.emit(42, { status: 'complete' }, harness.tabState(42));

      expect(harness.httpAuthChallengeForTab(42)).toBeUndefined();
    });

    it('never records a challenge on a tab the gateway does not control or share', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const { responded, response } = emitAuthChallenge(harness, {
        tabId: 999,
        url: 'https://stranger.example/login',
        scheme: 'Basic',
        requestId: 'stranger-req',
        challenger: { host: 'stranger.example', port: 443 },
      });

      // No stage anywhere: Chrome shows its own dialog (take no action).
      expect(responded).toBe(true);
      expect(response).toEqual({});
      expect(harness.httpAuthChallengeForTab(999)).toBeUndefined();
    });

    it('answers the exact-origin Basic challenge of the staged tab from the staged credential', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      let answer: unknown;
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          ({ response: answer } = emitAuthChallenge(harness, {
            tabId,
            url: 'https://example.test/protected',
            scheme: 'Basic',
            realm: 'Members',
            requestId: 'stage-req-1',
            challenger: { host: 'example.test', port: 443 },
          }));
        }
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-answered',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(answer).toEqual({
        authCredentials: { username: 'alice', password: 'TEST_ONLY_HTTP_AUTH_PASSWORD' },
      });
      expect(message?.['ok']).toBe(true);
      expect(message?.['result']).toMatchObject({
        completed: true,
        httpAuth: 'answered',
        tabId: 42,
        inspectionState: 'readable',
      });
      // The password never enters the page DOM, so the tab stays observable
      // and is deliberately NOT marked secret-tainted.
      const storageWrites = harness.chrome.storage.local.set.mock.calls
        .map(([values]) => JSON.stringify(values));
      expect(storageWrites.join('\n')).not.toContain('TEST_ONLY_HTTP_AUTH_PASSWORD');
      expect(storageWrites.join('\n')).not.toContain('browserGatewaySecretTaints');
    });

    it('answers a Digest challenge on the staged origin as well', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      let answer: unknown;
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          ({ response: answer } = emitAuthChallenge(harness, {
            tabId,
            url: 'https://example.test/digest-area',
            scheme: 'Digest',
            requestId: 'digest-req-1',
            challenger: { host: 'example.test', port: 443 },
          }));
        }
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-digest',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/digest-area',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(answer).toEqual({
        authCredentials: { username: 'alice', password: 'TEST_ONLY_HTTP_AUTH_PASSWORD' },
      });
      expect(message?.['result']).toMatchObject({ httpAuth: 'answered' });
    });

    it('takes no action for another tab, another origin, a proxy, an expired stage, or no stage', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      harness.httpAuthStages.set(42, {
        tabId: 42,
        origin: 'https://example.test',
        username: 'alice',
        password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
        expiresAt: Date.now() + 60_000,
        answeredRequestIds: new Set<string>(),
        answeredCount: 0,
        rejected: false,
      });

      const otherTab = emitAuthChallenge(harness, {
        tabId: 77,
        url: 'https://example.test/protected',
        scheme: 'Basic',
        requestId: 'other-tab',
        challenger: { host: 'example.test', port: 443 },
      });
      const otherOrigin = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://evil.example/protected',
        scheme: 'Basic',
        requestId: 'other-origin',
        challenger: { host: 'evil.example', port: 443 },
      });
      const otherPort = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://example.test:8443/protected',
        scheme: 'Basic',
        requestId: 'other-port',
        challenger: { host: 'example.test', port: 8443 },
      });
      const proxy = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://example.test/protected',
        scheme: 'Basic',
        requestId: 'proxy-req',
        isProxy: true,
        challenger: { host: 'proxy.local', port: 3128 },
      });
      const wrongScheme = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://example.test/protected',
        scheme: 'NTLM',
        requestId: 'ntlm-req',
        challenger: { host: 'example.test', port: 443 },
      });

      for (const outcome of [otherTab, otherOrigin, otherPort, proxy, wrongScheme]) {
        expect(outcome.responded).toBe(true);
        expect(outcome.response).toEqual({});
      }

      // Expired stage: the same challenge is again left to Chrome. (The stage
      // expiry is compared against the harness's own clock.)
      const stage = harness.httpAuthStages.get(42)!;
      stage['expiresAt'] = 1;
      const expired = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://example.test/protected',
        scheme: 'Basic',
        requestId: 'expired-req',
        challenger: { host: 'example.test', port: 443 },
      });
      expect(expired.response).toEqual({});

      // And no stage at all.
      harness.httpAuthStages.delete(42);
      const noStage = emitAuthChallenge(harness, {
        tabId: 42,
        url: 'https://example.test/protected',
        scheme: 'Basic',
        requestId: 'no-stage-req',
        challenger: { host: 'example.test', port: 443 },
      });
      expect(noStage.response).toEqual({});
    });

    it('cancels a second challenge for an answered requestId and reports rejected, never answering again', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      const answers: unknown[] = [];
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          // A repeat of the answered request (bad credentials), then a FRESH
          // request: once refused, the saved password is never offered again.
          for (const requestId of ['retry-req-1', 'retry-req-1', 'retry-req-1', 'retry-req-2']) {
            answers.push(emitAuthChallenge(harness, {
              tabId,
              url: 'https://example.test/protected',
              scheme: 'Basic',
              requestId,
              challenger: { host: 'example.test', port: 443 },
            }).response);
          }
        }
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-rejected',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_WRONG_PASSWORD',
          protection: 'password',
        },
      });

      // First challenge answered; every re-challenge is cancelled or ignored so
      // a wrong saved password cannot loop the prompt — one try per command.
      expect(answers).toEqual([
        { authCredentials: { username: 'alice', password: 'TEST_ONLY_WRONG_PASSWORD' } },
        { cancel: true },
        { cancel: true },
        {},
      ]);
      expect(message?.['ok']).toBe(true);
      expect(message?.['result']).toMatchObject({ completed: true, httpAuth: 'rejected' });
    });

    it('never answers a challenge whose requestId cannot be tracked', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      let answer: unknown;
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url) {
          // An untrackable (empty) requestId would re-offer the credential on
          // every re-fire — exactly the loop the anti-repeat rule exists for.
          ({ response: answer } = emitAuthChallenge(harness, {
            tabId,
            url: 'https://example.test/protected',
            scheme: 'Basic',
            requestId: '',
            challenger: { host: 'example.test', port: 443 },
          }));
        }
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-untrackable',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(answer).toEqual({});
      expect(message?.['result']).toMatchObject({ completed: true, httpAuth: 'not_challenged' });
    });

    it('reports not_challenged when the navigation never meets a prompt', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-silent',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/open',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(message?.['result']).toMatchObject({ completed: true, httpAuth: 'not_challenged' });
    });

    it('clears the staged credential on success, on failure, and on watchdog release', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const ok = await dispatchExtensionCommand(harness, {
        id: 'stage-clear-ok',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/open',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });
      expect(ok?.['ok']).toBe(true);
      expect(harness.httpAuthStages.size).toBe(0);

      let failNavigation = false;
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url && failNavigation) {
          throw new Error('tabs.update exploded');
        }
        return harness.tabState(tabId);
      });
      failNavigation = true;
      const failed = await dispatchExtensionCommand(harness, {
        id: 'stage-clear-fail',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/open',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });
      expect(failed?.['ok']).toBe(false);
      expect(harness.httpAuthStages.size).toBe(0);

      // Watchdog timeout path: forceReleaseCommandResources is exactly what
      // runCommandWithWatchdog invokes when a command outlives its window.
      harness.httpAuthStages.set(42, {
        tabId: 42,
        origin: 'https://example.test',
        username: 'alice',
        password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
        expiresAt: Date.now() + 60_000,
        answeredRequestIds: new Set<string>(),
        answeredCount: 0,
        rejected: false,
      });
      await harness.forceReleaseCommandResources({ target: { tabId: 42 } });
      expect(harness.httpAuthStages.size).toBe(0);
    });

    it('stages no credential at all when the control lease cannot be established', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      // startControlledTab rejects inside its lease setup (here: the operator
      // switches the gateway off while the lease is being established, so the
      // instrumentation's assertGatewayEnabled throws) — BEFORE this command
      // stages anything on the tab. The credential must never be armed here.
      harness.chrome.tabs.get.mockImplementationOnce(async (tabId: number) => {
        await harness.setGatewayEnabled(false);
        return harness.tabState(tabId);
      });

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-no-lease',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(message?.['ok']).not.toBe(true);
      // The contract: no credential is ever armed on this tab — the stage map
      // stays empty regardless of whether the (torn-down) channel could still
      // deliver a failure result.
      expect(harness.httpAuthStages.size).toBe(0);
    });

    it('reports pre-staging validation refusals with their fixed codes', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const missingField = await dispatchExtensionCommand(harness, {
        id: 'http-auth-missing-field',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          protection: 'password',
        },
      });
      expect(missingField?.['ok']).toBe(false);
      expect(missingField?.['error']).toBe('http_auth_payload_invalid');
      expect(harness.httpAuthStages.size).toBe(0);

      const badProtection = await dispatchExtensionCommand(harness, {
        id: 'http-auth-bad-protection',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'guess',
        },
      });
      expect(badProtection?.['error']).toBe('invalid_credential_protection');
      expect(harness.httpAuthStages.size).toBe(0);
    });

    it('never lets the username or password reach a result payload or an error', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();
      // A Chrome/page error that quotes its arguments must be collapsed to the
      // fixed code before it can cross the native boundary.
      let failNavigation = false;
      harness.chrome.tabs.update.mockImplementation(async (tabId: number, update?: { url?: string }) => {
        if (update?.url && failNavigation) {
          throw new Error('tabs.update exploded for TEST_ONLY_HTTP_AUTH_PASSWORD');
        }
        return harness.tabState(tabId);
      });

      failNavigation = true;
      const failed = await dispatchExtensionCommand(harness, {
        id: 'http-auth-error-text',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/open',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(failed?.['ok']).toBe(false);
      expect(failed?.['error']).toBe(
        'http_auth_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state',
      );

      failNavigation = false;
      const ok = await dispatchExtensionCommand(harness, {
        id: 'http-auth-result-text',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://example.test/open',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      const serialized = JSON.stringify(ok);
      expect(serialized).not.toContain('TEST_ONLY_HTTP_AUTH_PASSWORD');
      expect(serialized).not.toContain('alice');
    });

    it('refuses a plain-http origin except loopback, before staging anything', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const insecure = await dispatchExtensionCommand(harness, {
        id: 'http-auth-insecure',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'http://plain.example/protected',
          credentialOrigin: 'http://plain.example',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });
      expect(insecure?.['ok']).toBe(false);
      expect(insecure?.['error']).toBe('http_auth_insecure_origin');
      expect(harness.httpAuthStages.size).toBe(0);

      const loopback = await dispatchExtensionCommand(harness, {
        id: 'http-auth-loopback',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'http://localhost:4567/protected',
          credentialOrigin: 'http://localhost:4567',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });
      expect(loopback?.['ok']).toBe(true);
    });

    it('refuses a navigation whose origin is not the staged credential origin', async () => {
      const harness = loadBackgroundHarnessForTest();
      await flushPromises();

      const message = await dispatchExtensionCommand(harness, {
        id: 'http-auth-cross-origin',
        command: 'http_auth_navigate',
        target: { tabId: 42 },
        payload: {
          url: 'https://evil.example/protected',
          credentialOrigin: 'https://example.test',
          username: 'alice',
          password: 'TEST_ONLY_HTTP_AUTH_PASSWORD',
          protection: 'password',
        },
      });

      expect(message?.['ok']).toBe(false);
      expect(message?.['error']).toBe('invalid_credential_origin');
      expect(harness.httpAuthStages.size).toBe(0);
    });
  });
});

async function captureSnapshotAcrossRedirect(marker: string): Promise<Record<string, unknown>> {
  const harness = loadBackgroundHarnessForTest();
  await flushPromises();
  const relayPort = harness.ports.get(RELAY_HOST_NAME)!;
  relayPort.postMessage.mockClear();
  harness.chrome.tabs.get.mockImplementation(async (tabId: number) => {
    const tab = harness.tabState(tabId);
    return tab ? { ...tab } : undefined;
  });
  harness.chrome.scripting.executeScript.mockImplementation(async (
    params: { func?: { name?: string }; args?: unknown[] },
  ) => {
    if (params.func?.name === 'pageBridgeScript' && params.args?.[0] === 'snapshot') {
      const tab = harness.tabState(42)!;
      tab.url = `https://evil.example.test/private?marker=${marker}`;
      tab.title = marker;
      return [{ result: {
        title: marker,
        text: marker,
        selectorText: marker,
        selectorFingerprint: 'a'.repeat(64),
      } }];
    }
    return [{ result: undefined }];
  });

  relayPort.emitMessage({
    type: 'browser_command',
    command: {
      id: 'snapshot-redirect-during-capture',
      command: 'snapshot',
      target: { tabId: 42 },
      payload: { selector: '#status' },
    },
  });
  await flushPromises();

  const commandResult = relayPort.postMessage.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, unknown>)
    .find((message) => message['type'] === 'command_result'
      && message['commandId'] === 'snapshot-redirect-during-capture');
  if (commandResult?.['ok'] !== true || !commandResult['result']) {
    throw new Error('snapshot redirect harness did not produce a successful command result');
  }
  return commandResult['result'] as Record<string, unknown>;
}

function loadBackgroundHarnessForTest(options: {
  additionalTabs?: { tabId: number; groupId: number }[];
  deletedGroupIds?: Set<number>;
  failConnectHosts?: Set<string>;
  initialGatewayEnabled?: boolean;
  initialTabGroupId?: number;
  /** chrome.management.getSelf().installType; omit for no management API at all. */
  installType?: string;
  /** chrome.storage.local contents present before the service worker starts. */
  initialLocalStorage?: Record<string, unknown>;
  /** chrome.storage.local.get rejects when asked for one of these keys. */
  failStorageReadKeys?: Set<string>;
} = {}): BrowserExtensionBackgroundHarness {
  const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
  const deletedGroupIds = options.deletedGroupIds ?? new Set<number>();
  const failConnectHosts = options.failConnectHosts ?? new Set<string>();
  const ports = new Map<string, NativePortHarness>();
  const localStore: Record<string, unknown> = { ...options.initialLocalStorage };
  const alarmEvent = createChromeEvent<[unknown]>();
  const messageEvent = createChromeEvent<[unknown, unknown, (response: unknown) => void]>();
  const authRequiredEvent = createChromeEvent<[unknown, (response: unknown) => void]>();
  let nowMs = 1_000_000;
  let browserGatewayEnabled = options.initialGatewayEnabled;
  const initialTab = makeWebTab(42);
  initialTab.groupId = options.initialTabGroupId ?? -1;
  const tabsById = new Map<number, ReturnType<typeof makeWebTab>>([[42, initialTab]]);
  for (const additionalTab of options.additionalTabs ?? []) {
    const tab = makeWebTab(additionalTab.tabId);
    tab.groupId = additionalTab.groupId;
    tabsById.set(additionalTab.tabId, tab);
  }
  const zoomByTab = new Map<number, number>();
  const zoomSettingsByTab = new Map<number, { scope?: string }>();
  const windowsById = new Map<number, {
    id: number;
    state: string;
    bounds: { left: number; top: number; width: number; height: number };
  }>([[7, {
    id: 7,
    state: 'normal',
    bounds: { left: 10, top: 20, width: 1280, height: 800 },
  }]]);
  const connectNative = vi.fn((hostName: string) => {
    if (failConnectHosts.has(hostName)) {
      throw new Error(`Specified native messaging host not found: ${hostName}`);
    }
    const port = createNativePortHarness(hostName, context.chrome.runtime);
    ports.set(hostName, port);
    return port;
  });
  const context = {
    console,
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => 0),
    Date: {
      now: () => nowMs,
    },
    ImageData: class {
      data: Uint8ClampedArray;
      width: number;
      height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
    URL,
    Uint8ClampedArray,
    chrome: {
      action: {
        setBadgeBackgroundColor: vi.fn(async () => undefined),
        setBadgeText: vi.fn(async () => undefined),
        setIcon: vi.fn(async () => undefined),
      },
      alarms: {
        create: vi.fn(),
        onAlarm: alarmEvent,
      },
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async () => ({ nodes: [] })),
      },
      ...(options.installType === undefined
        ? {}
        : { management: { getSelf: vi.fn(async () => ({ installType: options.installType })) } }),
      runtime: {
        connectNative,
        getManifest: vi.fn(() => ({ version: '0.1.0' })),
        lastError: undefined,
        onInstalled: createChromeEvent(),
        onMessage: messageEvent,
        onStartup: createChromeEvent(),
        reload: vi.fn(),
        sendNativeMessage: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(async () => [{
          result: {
            title: 'Example',
            text: 'Example page',
          },
        }]),
      },
      webRequest: {
        onAuthRequired: authRequiredEvent,
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[] | Record<string, unknown>) => {
            if (typeof keys === 'string' && options.failStorageReadKeys?.has(keys)) {
              throw new Error(`storage read failed: ${keys}`);
            }
            if (
              keys === 'browserGatewayEnabled'
              || (Array.isArray(keys) && keys.includes('browserGatewayEnabled'))
              || (typeof keys === 'object' && keys !== null && 'browserGatewayEnabled' in keys)
            ) {
              return browserGatewayEnabled === undefined
                ? {}
                : { browserGatewayEnabled };
            }
            if (typeof keys === 'string' && keys in localStore) {
              return { [keys]: localStore[keys] };
            }
            return {};
          }),
          set: vi.fn(async (values: Record<string, unknown>) => {
            if (typeof values['browserGatewayEnabled'] === 'boolean') {
              browserGatewayEnabled = values['browserGatewayEnabled'];
            }
            Object.assign(localStore, values);
          }),
        },
        session: {
          set: vi.fn(async () => undefined),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => tabsById.get(tabId)),
        group: vi.fn(async (input: { tabIds: number | number[]; groupId?: number }) => {
          if (input.groupId !== undefined && deletedGroupIds.has(input.groupId)) {
            throw new Error(`No group with id: ${input.groupId}`);
          }
          const tabIds = Array.isArray(input.tabIds) ? input.tabIds : [input.tabIds];
          const groupId = input.groupId ?? 1;
          for (const tabId of tabIds) {
            const tab = tabsById.get(tabId);
            if (tab) {
              tab.groupId = groupId;
            }
          }
          return groupId;
        }),
        onRemoved: createChromeEvent(),
        onUpdated: createChromeEvent(),
        query: vi.fn(async (query?: { windowId?: number }) => (
          [...tabsById.values()].filter((tab) => (
            query?.windowId === undefined || tab.windowId === query.windowId
          ))
        )),
        remove: vi.fn(async (tabId: number | number[]) => {
          const ids = Array.isArray(tabId) ? tabId : [tabId];
          for (const id of ids) {
            if (!tabsById.has(id)) {
              throw new Error(`No tab with id: ${id}`);
            }
            tabsById.delete(id);
          }
        }),
        reload: vi.fn(async (tabId: number) => {
          const tab = tabsById.get(tabId);
          if (tab) {
            tab.status = 'complete';
          }
        }),
        ungroup: vi.fn(async (input: number | number[]) => {
          const tabIds = Array.isArray(input) ? input : [input];
          for (const tabId of tabIds) {
            const tab = tabsById.get(tabId);
            if (tab) {
              tab.groupId = -1;
            }
          }
        }),
        update: vi.fn(async (tabId: number) => tabsById.get(tabId)),
        getZoom: vi.fn(async (tabId: number) => zoomByTab.get(tabId) ?? 1),
        getZoomSettings: vi.fn(async (tabId: number) => (
          zoomSettingsByTab.get(tabId) ?? { scope: 'per-origin' }
        )),
        setZoom: vi.fn(async (tabId: number, factor: number) => {
          zoomByTab.set(tabId, factor);
        }),
        setZoomSettings: vi.fn(async (tabId: number, settings: { scope?: string }) => {
          zoomSettingsByTab.set(tabId, settings ?? {});
        }),
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: vi.fn(async (groupId: number) => ({
          id: groupId,
          title: groupId === 55 ? 'Research' : 'Harness',
          color: groupId === 55 ? 'green' : 'blue',
          collapsed: groupId === 55,
          windowId: 7,
        })),
        query: vi.fn(async () => []),
        update: vi.fn(async () => undefined),
      },
      windows: {
        onRemoved: createChromeEvent(),
        get: vi.fn(async (windowId: number) => windowsById.get(windowId) ?? {
          id: windowId,
          state: 'normal',
          bounds: { left: 0, top: 0, width: 1280, height: 800 },
        }),
        update: vi.fn(async (windowId: number, update: {
          state?: string;
          width?: number;
          height?: number;
          left?: number;
          top?: number;
        }) => {
          const existing = windowsById.get(windowId) ?? {
            id: windowId,
            state: 'normal',
            bounds: { left: 0, top: 0, width: 1280, height: 800 },
          };
          const bounds = {
            left: update.left ?? existing.bounds.left,
            top: update.top ?? existing.bounds.top,
            width: update.width ?? existing.bounds.width,
            height: update.height ?? existing.bounds.height,
          };
          windowsById.set(windowId, {
            id: windowId,
            state: update.state ?? existing.state,
            bounds,
          });
          return windowsById.get(windowId);
        }),
      },
    },
    __backgroundHarness: undefined as (BrowserExtensionBackgroundHarness & {
      pageBridgeScript: (...args: unknown[]) => Record<string, unknown>;
    }) | undefined,
  };
  runInNewContext(
    `${background}\n;globalThis.__backgroundHarness = { applySecretObservationProtectionEnabled, bridges, captureAccessibilitySnapshot, captureTabScreenshot, clearHttpAuthChallenge, clearHttpAuthStage, deriveToolbarBadgeState, forceReleaseCommandResources, handleHttpAuthRequired, httpAuthChallengeForTab, httpAuthChallenges, httpAuthStages, markSecretTaint, pageBridgeScript, recordHttpAuthChallenge, reportTabInventory, selfHealIfWedged, setGatewayEnabled, startControlledTab, stopControlledTab, tabDebuggerChains, waitForTabComplete };`,
    context,
    { filename: 'resources/browser-extension/background.js' },
  );
  return {
    ...context.__backgroundHarness!,
    advanceTimeBy: (ms: number) => {
      nowMs += ms;
    },
    chrome: context.chrome,
    failConnectHosts,
    ports,
    runPageBridgeSnapshot: async (
      html: string,
      selector: string,
      snapshotOptions?: { innerText?: string; subtleCrypto?: boolean },
    ) => {
      const dom = new JSDOM(html, { url: 'https://example.test/' });
      if (snapshotOptions?.innerText !== undefined) {
        Object.defineProperty(dom.window.document.querySelector(selector), 'innerText', {
          configurable: true,
          value: snapshotOptions.innerText,
        });
      }
      Object.assign(context, {
        crypto: snapshotOptions?.subtleCrypto === false ? {} : globalThis.crypto,
        document: dom.window.document,
        location: dom.window.location,
        TextEncoder: globalThis.TextEncoder,
        window: dom.window,
      });
      return context.__backgroundHarness!.pageBridgeScript('snapshot', [selector]);
    },
    tabState: (tabId: number) => tabsById.get(tabId),
    sendMessage: (message: unknown) => new Promise((resolve) => {
      let responded = false;
      messageEvent.emit(message, {}, (response: unknown) => {
        responded = true;
        resolve(response);
      });
      setImmediate(() => {
        if (!responded) {
          resolve(undefined);
        }
      });
    }),
    storedGatewayEnabled: () => browserGatewayEnabled,
    timers: {
      setTimeout: context.setTimeout,
      clearTimeout: context.clearTimeout,
    },
  };
}

function createChromeEvent<TArgs extends unknown[] = unknown[]>(): {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  emit: (...args: TArgs) => void;
} {
  const listeners: ((...args: TArgs) => void)[] = [];
  return {
    addListener: vi.fn((listener: (...args: TArgs) => void) => {
      listeners.push(listener);
    }),
    removeListener: vi.fn((listener: (...args: TArgs) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }),
    emit: (...args: TArgs) => {
      // Snapshot: a listener may unsubscribe itself during emit.
      for (const listener of Array.from(listeners)) {
        listener(...args);
      }
    },
  };
}

function createNativePortHarness(
  hostName: string,
  runtime: { lastError?: { message: string } },
): NativePortHarness {
  const onMessage = createChromeEvent<[unknown]>();
  const onDisconnect = createChromeEvent<[]>();
  return {
    hostName,
    onMessage,
    onDisconnect,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      onDisconnect.emit();
    }),
    emitMessage: (message: unknown) => {
      onMessage.emit(message);
    },
    emitDisconnect: (message?: string) => {
      runtime.lastError = message ? { message } : undefined;
      onDisconnect.emit();
      runtime.lastError = undefined;
    },
  } as NativePortHarness;
}

function loadPopupHarness(statusResponse: unknown): {
  chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
  document: Document;
  window: Window & typeof globalThis;
} {
  const popupHtml = readFileSync('resources/browser-extension/popup.html', 'utf-8');
  const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');
  const dom = new JSDOM(popupHtml, { url: 'chrome-extension://harness/popup.html' });
  const chrome = {
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      reload: vi.fn(),
      sendMessage: vi.fn(async (message: unknown) => {
        if ((message as { type?: string })?.type === 'getStatus') {
          return statusResponse;
        }
        if ((message as { type?: string })?.type === 'reconnect_bridges') {
          return { ok: true, ...statusResponse as Record<string, unknown> };
        }
        if ((message as { type?: string })?.type === 'set_gateway_enabled') {
          return {
            ok: true,
            ...(statusResponse as Record<string, unknown>),
            gatewayEnabled: (message as { enabled?: boolean }).enabled,
          };
        }
        return { ok: true, recipients: [{ kind: 'local', hostName: LEGACY_HOST_NAME }] };
      }),
    },
  };
  runInNewContext(popup, {
    chrome,
    document: dom.window.document,
    Intl: dom.window.Intl,
    window: dom.window,
  }, { filename: 'resources/browser-extension/popup.js' });
  return {
    chrome,
    document: dom.window.document,
    window: dom.window as unknown as Window & typeof globalThis,
  };
}

function emitAlarm(harness: BrowserExtensionBackgroundHarness, name: string): void {
  const alarms = (harness.chrome as unknown as {
    alarms: { onAlarm: { emit: (alarm: { name: string }) => void } };
  }).alarms;
  alarms.onAlarm.emit({ name });
}

function makeWebTab(tabId: number): {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  groupId: number;
  status: string;
  pinned: boolean;
  active: boolean;
} {
  return {
    id: tabId,
    windowId: 7,
    index: tabId === 42 ? 0 : 1,
    url: `https://example.test/${tabId}`,
    title: `Example ${tabId}`,
    groupId: -1,
    status: 'complete',
    pinned: false,
    active: tabId === 42,
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function actionIconColorAt(value: unknown, x: number, y: number): [number, number, number, number] | null {
  const imageData = (value as {
    imageData?: Record<number, { data?: Uint8ClampedArray; width?: number; height?: number }>;
  })?.imageData?.[16];
  if (!imageData?.data || typeof imageData.width !== 'number' || typeof imageData.height !== 'number') {
    return null;
  }
  const offset = (y * imageData.width + x) * 4;
  return [
    imageData.data[offset],
    imageData.data[offset + 1],
    imageData.data[offset + 2],
    imageData.data[offset + 3],
  ];
}

async function waitForActionIconColor(
  harness: BrowserExtensionBackgroundHarness,
  x: number,
  y: number,
): Promise<[number, number, number, number] | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const latestCall = harness.chrome.action.setIcon.mock.calls.at(-1);
    const color = actionIconColorAt(latestCall?.[0], x, y);
    if (color) {
      return color;
    }
    await flushPromises();
  }
  const latestCall = harness.chrome.action.setIcon.mock.calls.at(-1);
  return actionIconColorAt(latestCall?.[0], x, y);
}
