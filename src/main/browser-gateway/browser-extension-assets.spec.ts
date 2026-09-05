import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// jsdom ships no type declarations and @types/jsdom is not installed. A
// sibling spec (doc-review/artifact-choice-runtime.spec.ts) already declares
// a `declare module 'jsdom'` ambient module for this package; adding a
// second one here conflicts (TS2665), so this import is left untyped instead.
// @ts-expect-error No type declarations available for 'jsdom' in this repo.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

interface BrowserExtensionBackgroundHarness {
  advanceTimeBy: (ms: number) => void;
  bridges: Array<{
    hostName: string;
    nativePort: NativePortHarness | null;
    pollInFlight: boolean;
    lastError: string | null;
    state: string;
  }>;
  deriveToolbarBadgeState: (
    snapshots: Array<{ state: string; lastPollAckAt: number | null; unhealthySince: number | null }>,
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
  selfHealIfWedged: () => Promise<void>;
  startControlledTab: (tabId: number) => Promise<unknown>;
  stopControlledTab: (tabId: number, token?: unknown) => Promise<void>;
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
  tabs: {
    get: ReturnType<typeof vi.fn>;
    group: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    ungroup: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  tabGroups: {
    get: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
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
    expect(background).toContain('fileCount: files.length');
    expect(background).toContain("'DOM.setFileInputFiles'");
    expect(background).toContain('findActiveWebTabForSharing');
    expect(background).toContain('lastFocusedWindow: true');
    expect(background).toContain('chrome.tabs.query({})');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('tabGroups');
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
    (deadline?.[0] as () => void)();

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
    (deadline?.[0] as () => void)();

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
    (deadline?.[0] as () => void)();

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
        tabs?: Array<Record<string, unknown>>;
      })
      .find((message) => message.type === 'tab_inventory');
    expect(inventory?.tabs).toContainEqual(expect.objectContaining({
      tabId: 43,
      url: 'https://example.test/',
      title: 'Secret-filled tab',
      text: '',
      textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
    }));
    expect(JSON.stringify(inventory)).not.toContain(marker);
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
    expect(call?.result?.text).toBe('Example page');
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
});

function loadBackgroundHarnessForTest(options: {
  additionalTabs?: Array<{ tabId: number; groupId: number }>;
  deletedGroupIds?: Set<number>;
  failConnectHosts?: Set<string>;
  initialGatewayEnabled?: boolean;
  initialTabGroupId?: number;
} = {}): BrowserExtensionBackgroundHarness {
  const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
  const deletedGroupIds = options.deletedGroupIds ?? new Set<number>();
  const failConnectHosts = options.failConnectHosts ?? new Set<string>();
  const ports = new Map<string, NativePortHarness>();
  const localStore: Record<string, unknown> = {};
  const alarmEvent = createChromeEvent<[unknown]>();
  const messageEvent = createChromeEvent<[unknown, unknown, (response: unknown) => void]>();
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
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[] | Record<string, unknown>) => {
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
        query: vi.fn(async () => [...tabsById.values()]),
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
    },
    __backgroundHarness: undefined as BrowserExtensionBackgroundHarness | undefined,
  };
  runInNewContext(
    `${background}\n;globalThis.__backgroundHarness = { bridges, captureAccessibilitySnapshot, captureTabScreenshot, deriveToolbarBadgeState, forceReleaseCommandResources, markSecretTaint, reportTabInventory, selfHealIfWedged, startControlledTab, stopControlledTab, tabDebuggerChains };`,
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
  const listeners: Array<(...args: TArgs) => void> = [];
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
      for (const listener of [...listeners]) {
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
  url: string;
  title: string;
  groupId: number;
  status: string;
} {
  return {
    id: tabId,
    windowId: 7,
    url: `https://example.test/${tabId}`,
    title: `Example ${tabId}`,
    groupId: -1,
    status: 'complete',
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
