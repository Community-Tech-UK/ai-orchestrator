import { readFileSync } from 'node:fs';
// The repository intentionally has no @types/jsdom; a sibling spec provides
// the ambient module declaration used by the test build.
// @ts-expect-error No local declaration file is installed for jsdom.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { extractFunctionSource } from './browser-extension-function-source.testutil';

const background = readFileSync('resources/browser-extension/background.js', 'utf8');
const SECRET = 'TEST_ONLY_ORIGIN_BOUND_SECRET';
const AUTHORIZED_ORIGIN = 'https://www.instagram.com';

interface ScriptInjection {
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
  func: { name?: string };
  args?: unknown[];
}

function buildOriginBoundTypeHarness(options: {
  tabUrls?: string[];
  frameOrigins?: Array<{ frameId: number; origin: string }>;
  secretWriteError?: string;
  taintError?: string;
}) {
  const urls = options.tabUrls ?? [`${AUTHORIZED_ORIGIN}/accounts/emailsignup/`];
  let tabRead = 0;
  const chrome = {
    tabs: {
      get: vi.fn(async () => ({
        id: 42,
        windowId: 7,
        url: urls[Math.min(tabRead++, urls.length - 1)],
      })),
    },
    scripting: {
      executeScript: vi.fn(async (input: ScriptInjection) => {
        if (input.func.name === 'credentialFrameOriginProbe') {
          return (options.frameOrigins ?? [{ frameId: 0, origin: AUTHORIZED_ORIGIN }])
            .map(({ frameId, origin }) => ({ frameId, result: { origin } }));
        }
        if (options.secretWriteError) {
          throw new Error(options.secretWriteError);
        }
        return (input.target.frameIds ?? []).map((frameId) => ({
          frameId,
          result: frameId === 0
            ? { __found: false }
            : { __found: true, valueApplied: true, tagName: 'INPUT' },
        }));
      }),
    },
  };
  const startControlledTab = vi.fn(async () => 'control-token');
  const stopControlledTab = vi.fn(async () => undefined);
  const reportTab = vi.fn(async () => undefined);
  const markSecretTaint = vi.fn(async () => {
    if (options.taintError) throw new Error(options.taintError);
  });
  const build = new Function(
    'chrome',
    'assertGatewayEnabled',
    'requireTargetTabId',
    'startControlledTab',
    'stopControlledTab',
    'reportTab',
    'markSecretTaint',
    `${extractFunctionSource(background, 'normalizeCredentialOrigin')}
${extractFunctionSource(background, 'credentialFrameOriginProbe')}
${extractFunctionSource(background, 'mergeFrameResults')}
${extractFunctionSource(background, 'pageBridgeScript')}
${extractFunctionSource(background, 'runOriginBoundType')}
return runOriginBoundType;`,
  );
  const runOriginBoundType = build(
    chrome,
    () => undefined,
    (command: { target?: { tabId?: number } }) => command.target?.tabId ?? 0,
    startControlledTab,
    stopControlledTab,
    reportTab,
    markSecretTaint,
  ) as (
    command: { target: { tabId: number } },
    selector: string,
    value: string,
    expectedOrigin: string,
  ) => Promise<unknown>;
  return { chrome, markSecretTaint, runOriginBoundType };
}

describe('extension origin-bound secret typing', () => {
  it('keeps secret taint across navigation and clears it only when the tab closes', () => {
    const onUpdated = background.slice(
      background.indexOf('chrome.tabs.onUpdated.addListener'),
      background.indexOf('chrome.tabs.onRemoved.addListener'),
    );
    expect(onUpdated).not.toContain('clearSecretTaint');
    expect(background).toContain("chrome.tabs.onRemoved.addListener((tabId) => {");
  });

  it('blocks model-facing observations when persisted secret taint exists', async () => {
    const chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            browserGatewaySecretTaints: { '42': AUTHORIZED_ORIGIN },
          })),
        },
      },
    };
    const build = new Function(
      'chrome',
      'SECRET_TAINT_STORAGE_KEY',
      'SECRET_OBSERVATION_COMMANDS',
      'secretTaintedTabs',
      'secretTaintsLoaded',
      'secretTaintLoadPromise',
      'requireTargetTabId',
      'secretTaintOriginForTabId',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'loadSecretTaints')}
${extractFunctionSource(background, 'assertSecretObservationAllowed')}
return assertSecretObservationAllowed;`,
    );
    const assertSecretObservationAllowed = build(
      chrome,
      'browserGatewaySecretTaints',
      new Set(['snapshot', 'query_elements', 'evaluate', 'screenshot']),
      new Map(),
      false,
      null,
      (command: { target?: { tabId?: number } }) => command.target?.tabId ?? 0,
      async (tabId: number) => tabId === 42 ? AUTHORIZED_ORIGIN : null,
    );

    await expect(assertSecretObservationAllowed({
      command: 'query_elements',
      target: { tabId: 42 },
    })).rejects.toThrow('browser_secret_observation_blocked_for_tainted_origin');
    await expect(assertSecretObservationAllowed({
      command: 'evaluate',
      target: { tabId: 42 },
    })).rejects.toThrow('browser_secret_observation_blocked_for_tainted_origin');
    await expect(assertSecretObservationAllowed({
      command: 'navigate',
      target: { tabId: 42 },
    })).resolves.toBeUndefined();
  });

  it('checks the observation guard before dispatching a browser command', async () => {
    const build = new Function(
      'assertGatewayEnabled',
      'assertSecretObservationAllowed',
      `${extractFunctionSource(background, 'executeBrowserCommand')}
return executeBrowserCommand;`,
    );
    const executeBrowserCommand = build(
      () => undefined,
      async () => { throw new Error('browser_secret_observation_blocked_for_tainted_origin'); },
    );

    await expect(executeBrowserCommand({
      command: 'screenshot',
      target: { tabId: 42 },
    })).rejects.toThrow('browser_secret_observation_blocked_for_tainted_origin');
  });

  it('suppresses autonomous tab text and screenshots while secret taint is active', async () => {
    const capturePageText = vi.fn(async () => ({ title: 'Page', text: SECRET }));
    const captureTabScreenshot = vi.fn(async () => SECRET);
    const build = new Function(
      'isWebTab',
      'secretTaintOriginForTab',
      'capturePageText',
      'captureTabScreenshot',
      'runWithSecretObservationBoundary',
      `${extractFunctionSource(background, 'buildTabPayload')}
${extractFunctionSource(background, 'buildTabPayloadLocked')}
return buildTabPayload;`,
    );
    const buildTabPayload = build(
      () => true,
      async (tab: { id: number }) => tab.id === 42 ? AUTHORIZED_ORIGIN : null,
      capturePageText,
      captureTabScreenshot,
      (operation: () => Promise<unknown>) => operation(),
    );

    const result = await buildTabPayload(
      {
        id: 42,
        windowId: 7,
        url: `${AUTHORIZED_ORIGIN}/?mirrored=${encodeURIComponent(SECRET)}`,
        title: `Mirrored ${SECRET}`,
      },
      { includeText: true, includeScreenshot: true },
    );

    expect(result).toMatchObject({
      url: `${AUTHORIZED_ORIGIN}/`,
      title: 'Secret-filled tab',
      text: '',
      textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
    });
    expect(result).not.toHaveProperty('screenshotBase64');
    expect(capturePageText).not.toHaveBeenCalled();
    expect(captureTabScreenshot).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('keeps the origin and opener lineage tainted after the filled tab closes', async () => {
    const secretTaintedTabs = new Map([['42', AUTHORIZED_ORIGIN]]);
    const secretTaintedOrigins = new Set([AUTHORIZED_ORIGIN]);
    const storageSet = vi.fn(async () => undefined);
    const chrome = {
      scripting: {
        executeScript: vi.fn(async (input: ScriptInjection) =>
          input.target.tabId === 45
            ? [{ frameId: 7, result: { origin: AUTHORIZED_ORIGIN } }]
            : [{ frameId: 0, result: { origin: 'https://unrelated.example' } }]),
      },
      storage: { local: { set: storageSet } },
    };
    const capturePageText = vi.fn(async () => ({ title: SECRET, text: SECRET }));
    const captureTabScreenshot = vi.fn(async () => SECRET);
    const build = new Function(
      'chrome',
      'SECRET_TAINT_STORAGE_KEY',
      'secretTaintedTabs',
      'secretTaintedOrigins',
      'loadSecretTaints',
      'isWebTab',
      'capturePageText',
      'captureTabScreenshot',
      'runWithSecretObservationBoundary',
      `let secretRecoveryRequest = null;
${extractFunctionSource(background, 'persistSecretTaints')}
${extractFunctionSource(background, 'clearSecretTaint')}
${extractFunctionSource(background, 'browserTabOrigin')}
${extractFunctionSource(background, 'credentialFrameOriginProbe')}
${extractFunctionSource(background, 'taintedFrameOriginForTabId')}
${extractFunctionSource(background, 'secretTaintOriginForTab')}
${extractFunctionSource(background, 'buildTabPayload')}
${extractFunctionSource(background, 'buildTabPayloadLocked')}
return { clearSecretTaint, buildTabPayload };`,
    );
    const harness = build(
      chrome,
      'browserGatewaySecretTaints',
      secretTaintedTabs,
      secretTaintedOrigins,
      async () => undefined,
      () => true,
      capturePageText,
      captureTabScreenshot,
      (operation: () => Promise<unknown>) => operation(),
    );

    await harness.clearSecretTaint(42);
    const sameOriginSibling = await harness.buildTabPayload({
      id: 43,
      windowId: 7,
      url: `${AUTHORIZED_ORIGIN}/?mirrored=${encodeURIComponent(SECRET)}`,
      title: SECRET,
    }, { includeText: true, includeScreenshot: true });
    const openerDescendant = await harness.buildTabPayload({
      id: 44,
      openerTabId: 43,
      windowId: 7,
      url: `https://unrelated.example/?mirrored=${encodeURIComponent(SECRET)}`,
      title: SECRET,
    }, { includeText: true, includeScreenshot: true });
    const iframeCarrier = await harness.buildTabPayload({
      id: 45,
      windowId: 7,
      url: `https://unrelated.example/carrier?mirrored=${encodeURIComponent(SECRET)}`,
      title: SECRET,
    }, { includeText: true, includeScreenshot: true });

    expect(secretTaintedOrigins.has(AUTHORIZED_ORIGIN)).toBe(true);
    expect(storageSet).toHaveBeenCalledWith({
      browserGatewaySecretTaints: {
        version: 2,
        origins: [AUTHORIZED_ORIGIN],
        tabs: {},
      },
    });
    for (const payload of [sameOriginSibling, openerDescendant, iframeCarrier]) {
      expect(payload).toMatchObject({
        url: `${AUTHORIZED_ORIGIN}/`,
        title: 'Secret-filled tab',
        text: '',
        textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
      });
      expect(payload).not.toHaveProperty('screenshotBase64');
      expect(JSON.stringify(payload)).not.toContain(SECRET);
    }
    expect(secretTaintedTabs.get('43')).toBe(AUTHORIZED_ORIGIN);
    expect(secretTaintedTabs.get('44')).toBe(AUTHORIZED_ORIGIN);
    expect(secretTaintedTabs.get('45')).toBe(AUTHORIZED_ORIGIN);
    expect(capturePageText).not.toHaveBeenCalled();
    expect(captureTabScreenshot).not.toHaveBeenCalled();
  });

  it('taints every current same-origin tab before the secret-bearing injection', async () => {
    const secretTaintedTabs = new Map();
    const secretTaintedOrigins = new Set();
    const storageSet = vi.fn(async () => undefined);
    const chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 42, url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/` },
          { id: 43, url: `${AUTHORIZED_ORIGIN}/messages/` },
          { id: 50, url: 'https://unrelated.example/with-instagram-frame' },
          { id: 99, url: 'https://unrelated.example/' },
        ]),
      },
      scripting: {
        executeScript: vi.fn(async (input: ScriptInjection) =>
          input.target.tabId === 50
            ? [
                { frameId: 0, result: { origin: 'https://unrelated.example' } },
                { frameId: 7, result: { origin: AUTHORIZED_ORIGIN } },
              ]
            : [{ frameId: 0, result: { origin: new URL(
                input.target.tabId === 99
                  ? 'https://unrelated.example/'
                  : `${AUTHORIZED_ORIGIN}/`,
              ).origin } }]),
      },
      storage: { local: { set: storageSet } },
    };
    const build = new Function(
      'chrome',
      'SECRET_TAINT_STORAGE_KEY',
      'secretTaintedTabs',
      'secretTaintedOrigins',
      'loadSecretTaints',
      'runWithSecretObservationBoundary',
      `let secretRecoveryRequest = null;
${extractFunctionSource(background, 'persistSecretTaints')}
${extractFunctionSource(background, 'browserTabOrigin')}
${extractFunctionSource(background, 'credentialFrameOriginProbe')}
${extractFunctionSource(background, 'taintedFrameOriginForTabId')}
${extractFunctionSource(background, 'markSecretTaint')}
${extractFunctionSource(background, 'markSecretTaintLocked')}
return markSecretTaint;`,
    );
    const markSecretTaint = build(
      chrome,
      'browserGatewaySecretTaints',
      secretTaintedTabs,
      secretTaintedOrigins,
      async () => undefined,
      (operation: () => Promise<unknown>) => operation(),
    );

    await markSecretTaint(42, AUTHORIZED_ORIGIN);

    expect(Object.fromEntries(secretTaintedTabs)).toEqual({
      '42': AUTHORIZED_ORIGIN,
      '43': AUTHORIZED_ORIGIN,
      '50': AUTHORIZED_ORIGIN,
    });
    expect(secretTaintedOrigins).toEqual(new Set([AUTHORIZED_ORIGIN]));
    expect(storageSet).toHaveBeenCalledWith({
      browserGatewaySecretTaints: {
        version: 2,
        origins: [AUTHORIZED_ORIGIN],
        tabs: {
          '42': AUTHORIZED_ORIGIN,
          '43': AUTHORIZED_ORIGIN,
          '50': AUTHORIZED_ORIGIN,
        },
      },
    });
  });

  it('sanitizes an origin-bound failure at the native command-result boundary', async () => {
    const postNativeMessage = vi.fn();
    const build = new Function(
      'assertGatewayEnabled',
      'runCommandWithWatchdog',
      'isTabPayload',
      'broadcastNativeMessage',
      'postNativeMessage',
      'clearPollInFlight',
      'persistBridgeStatus',
      'scheduleNextPoll',
      'POLL_TIMEOUT_MS',
      'targetSecretTaintOrigin',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'browserCommandErrorMessage')}
${extractFunctionSource(background, 'runBrowserCommand')}
return runBrowserCommand;`,
    );
    const runBrowserCommand = build(
      () => undefined,
      async () => { throw new Error(`page rejected ${SECRET}`); },
      () => false,
      () => undefined,
      postNativeMessage,
      () => undefined,
      () => undefined,
      () => undefined,
      1_000,
      async () => null,
    );
    const command = {
      id: 'credential-command',
      command: 'type',
      payload: {
        selector: '#password',
        value: SECRET,
        credentialOrigin: AUTHORIZED_ORIGIN,
      },
    };

    await runBrowserCommand(command, {});

    const serialized = JSON.stringify(postNativeMessage.mock.calls);
    expect(postNativeMessage).toHaveBeenCalledWith({}, {
      type: 'command_result',
      commandId: 'credential-command',
      ok: false,
      error: 'credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state',
    });
    expect(serialized).not.toContain(SECRET);
  });

  it.each([
    ['click', { selector: '#continue' }],
    ['click', { uid: 'uid-continue' }],
    ['type', { selector: '#username', value: 'public-value' }],
    ['type', { uid: 'uid-username', value: 'public-value' }],
    ['select', { selector: '#country', value: 'GB' }],
    ['select', { uid: 'uid-country', value: 'GB' }],
    ['fill_form', { fields: [{ selector: '#username', value: 'public-value' }] }],
    ['upload_file', { selector: '#upload', filePath: '/safe/upload.txt' }],
  ])('sanitizes a later %s result while the target tab is tainted', async (commandName, payload) => {
    const dom = new JSDOM(
      '<!doctype html><input id="password" type="password"><button id="continue">Continue</button>',
      { url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/` },
    );
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const buildPageBridge = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = buildPageBridge(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );
    const password = dom.window.document.querySelector('#password') as HTMLInputElement;
    const button = dom.window.document.querySelector('#continue') as HTMLButtonElement;
    password.addEventListener('input', () => {
      button.textContent = password.value;
      button.value = password.value;
    });
    pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
      'password',
    );
    const pageControlledResult = pageBridgeScript('click', ['#continue']);
    expect(JSON.stringify(pageControlledResult)).toContain(SECRET);

    const postNativeMessage = vi.fn();
    const buildCommandRunner = new Function(
      'assertGatewayEnabled',
      'runCommandWithWatchdog',
      'isTabPayload',
      'broadcastNativeMessage',
      'postNativeMessage',
      'clearPollInFlight',
      'persistBridgeStatus',
      'scheduleNextPoll',
      'targetSecretTaintOrigin',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'browserCommandErrorMessage')}
${extractFunctionSource(background, 'runBrowserCommand')}
return runBrowserCommand;`,
    );
    const runBrowserCommand = buildCommandRunner(
      () => undefined,
      async () => pageControlledResult,
      () => false,
      () => undefined,
      postNativeMessage,
      () => undefined,
      () => undefined,
      () => undefined,
      async () => AUTHORIZED_ORIGIN,
    );

    await runBrowserCommand({
      id: `later-${commandName}`,
      command: commandName,
      target: { tabId: 42 },
      payload,
    }, {});

    expect(postNativeMessage).toHaveBeenCalledWith({}, {
      type: 'command_result',
      commandId: `later-${commandName}`,
      ok: true,
      result: {
        completed: true,
        observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
      },
    });
    expect(JSON.stringify(postNativeMessage.mock.calls)).not.toContain(SECRET);
  });

  it('sanitizes every later tainted-tab failure as ambiguous and non-retryable', async () => {
    const postNativeMessage = vi.fn();
    const build = new Function(
      'assertGatewayEnabled',
      'runCommandWithWatchdog',
      'isTabPayload',
      'broadcastNativeMessage',
      'postNativeMessage',
      'clearPollInFlight',
      'persistBridgeStatus',
      'scheduleNextPoll',
      'targetSecretTaintOrigin',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'browserCommandErrorMessage')}
${extractFunctionSource(background, 'runBrowserCommand')}
return runBrowserCommand;`,
    );
    const runBrowserCommand = build(
      () => undefined,
      async () => { throw new Error(`page-derived failure ${SECRET}`); },
      () => false,
      () => undefined,
      postNativeMessage,
      () => undefined,
      () => undefined,
      () => undefined,
      async () => AUTHORIZED_ORIGIN,
    );

    await runBrowserCommand({
      id: 'later-failure',
      command: 'click',
      target: { tabId: 42 },
      payload: { selector: '#continue' },
    }, {});

    expect(postNativeMessage).toHaveBeenCalledWith({}, {
      type: 'command_result',
      commandId: 'later-failure',
      ok: false,
      error: 'secret_tainted_command_failed_or_may_have_applied_DO_NOT_retry_without_user_verification',
    });
    expect(JSON.stringify(postNativeMessage.mock.calls)).not.toContain(SECRET);
  });

  it('keeps an in-flight tainted result secret-free when the tab closes during the command', async () => {
    let tabClosed = false;
    const postNativeMessage = vi.fn();
    const build = new Function(
      'assertGatewayEnabled',
      'runCommandWithWatchdog',
      'isTabPayload',
      'broadcastNativeMessage',
      'postNativeMessage',
      'clearPollInFlight',
      'persistBridgeStatus',
      'scheduleNextPoll',
      'targetSecretTaintOrigin',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'browserCommandErrorMessage')}
${extractFunctionSource(background, 'runBrowserCommand')}
return runBrowserCommand;`,
    );
    const runBrowserCommand = build(
      () => undefined,
      async () => {
        tabClosed = true;
        return { text: SECRET, value: SECRET };
      },
      () => false,
      () => undefined,
      postNativeMessage,
      () => undefined,
      () => undefined,
      () => undefined,
      async () => tabClosed ? null : AUTHORIZED_ORIGIN,
    );

    await runBrowserCommand({
      id: 'closing-tab-command',
      command: 'click',
      target: { tabId: 42 },
      payload: { selector: '#close' },
    }, {});

    expect(postNativeMessage).toHaveBeenCalledWith({}, {
      type: 'command_result',
      commandId: 'closing-tab-command',
      ok: true,
      result: {
        completed: true,
        observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
      },
    });
    expect(JSON.stringify(postNativeMessage.mock.calls)).not.toContain(SECRET);
  });

  it('preclassifies the first sensitive credential write before taint storage can be cleared', async () => {
    const postNativeMessage = vi.fn();
    const build = new Function(
      'assertGatewayEnabled',
      'runCommandWithWatchdog',
      'isTabPayload',
      'broadcastNativeMessage',
      'postNativeMessage',
      'clearPollInFlight',
      'persistBridgeStatus',
      'scheduleNextPoll',
      'targetSecretTaintOrigin',
      `const secretObservationGuardErrors = new WeakSet();
${extractFunctionSource(background, 'browserCommandErrorMessage')}
${extractFunctionSource(background, 'runBrowserCommand')}
return runBrowserCommand;`,
    );
    const runBrowserCommand = build(
      () => undefined,
      async () => ({ tagName: SECRET, valueApplied: true }),
      () => false,
      () => undefined,
      postNativeMessage,
      () => undefined,
      () => undefined,
      () => undefined,
      async () => null,
    );

    await runBrowserCommand({
      id: 'first-sensitive-write',
      command: 'type',
      target: { tabId: 42 },
      payload: {
        selector: '#password',
        value: SECRET,
        credentialOrigin: AUTHORIZED_ORIGIN,
        credentialProtection: 'password',
      },
    }, {});

    expect(postNativeMessage).toHaveBeenCalledWith({}, {
      type: 'command_result',
      commandId: 'first-sensitive-write',
      ok: true,
      result: {
        completed: true,
        observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
      },
    });
    expect(JSON.stringify(postNativeMessage.mock.calls)).not.toContain(SECRET);
  });

  it('routes the internal credential payload through the origin-bound writer', async () => {
    const runOriginBoundType = vi.fn(async () => ({ valueApplied: true }));
    const runInTargetTab = vi.fn();
    const typeByUid = vi.fn();
    const build = new Function(
      'assertGatewayEnabled',
      'assertSecretObservationAllowed',
      'optionalUidValue',
      'requirePayloadString',
      'requireTargetTabId',
      'runOriginBoundType',
      'runInTargetTab',
      'typeByUid',
      `${extractFunctionSource(background, 'executeBrowserCommand')}; return executeBrowserCommand;`,
    );
    const executeBrowserCommand = build(
      () => undefined,
      async () => undefined,
      () => null,
      (command: { payload?: Record<string, unknown> }, key: string) => command.payload?.[key],
      () => 42,
      runOriginBoundType,
      runInTargetTab,
      typeByUid,
    );
    const command = {
      command: 'type',
      target: { tabId: 42 },
      payload: {
        selector: '#password',
        value: SECRET,
        credentialOrigin: AUTHORIZED_ORIGIN,
      },
    };

    await executeBrowserCommand(command);

    expect(runOriginBoundType).toHaveBeenCalledWith(
      command,
      '#password',
      SECRET,
      AUTHORIZED_ORIGIN,
      undefined,
    );
    expect(runInTargetTab).not.toHaveBeenCalled();
    expect(typeByUid).not.toHaveBeenCalled();
  });

  it('never sends the secret to a cross-origin frame', async () => {
    const { chrome, markSecretTaint, runOriginBoundType } = buildOriginBoundTypeHarness({
      frameOrigins: [
        { frameId: 0, origin: AUTHORIZED_ORIGIN },
        { frameId: 7, origin: 'https://unrelated.example' },
        { frameId: 9, origin: AUTHORIZED_ORIGIN },
      ],
    });

    await expect(runOriginBoundType(
      { target: { tabId: 42 } },
      '#password',
      SECRET,
      AUTHORIZED_ORIGIN,
    )).resolves.toMatchObject({ valueApplied: true });

    const calls = chrome.scripting.executeScript.mock.calls
      .map(([input]) => input as ScriptInjection);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0])).not.toContain(SECRET);
    expect(calls[0]?.target).toEqual({ tabId: 42, allFrames: true });
    expect(calls[1]?.target).toEqual({ tabId: 42, frameIds: [0, 9] });
    expect(calls[1]?.target.frameIds).not.toContain(7);
    expect(calls[1]?.args).toEqual([
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
      'secret',
    ]);
    expect(markSecretTaint).toHaveBeenCalledWith(42, AUTHORIZED_ORIGIN);
  });

  it('does not dispatch a secret-bearing script when the top-level tab navigates after probing', async () => {
    const { chrome, runOriginBoundType } = buildOriginBoundTypeHarness({
      tabUrls: [
        `${AUTHORIZED_ORIGIN}/accounts/emailsignup/`,
        'https://unrelated.example/phishing',
      ],
      frameOrigins: [{ frameId: 0, origin: AUTHORIZED_ORIGIN }],
    });

    await expect(runOriginBoundType(
      { target: { tabId: 42 } },
      '#password',
      SECRET,
      AUTHORIZED_ORIGIN,
    )).rejects.toThrow(/credential_origin_changed_before_write/);

    const serializedCalls = chrome.scripting.executeScript.mock.calls.map(([input]) =>
      JSON.stringify(input));
    expect(serializedCalls).toHaveLength(1);
    expect(serializedCalls.join('\n')).not.toContain(SECRET);
  });

  it('fails closed before secret dispatch when taint persistence is unavailable', async () => {
    const { chrome, runOriginBoundType } = buildOriginBoundTypeHarness({
      frameOrigins: [{ frameId: 0, origin: AUTHORIZED_ORIGIN }],
      taintError: 'storage unavailable',
    });

    await expect(runOriginBoundType(
      { target: { tabId: 42 } },
      '#password',
      SECRET,
      AUTHORIZED_ORIGIN,
    )).rejects.toThrow('storage unavailable');

    const serializedCalls = chrome.scripting.executeScript.mock.calls.map(([input]) =>
      JSON.stringify(input));
    expect(serializedCalls).toHaveLength(1);
    expect(serializedCalls.join('\n')).not.toContain(SECRET);
  });

  it('discards a Chrome injection error that quotes the secret', async () => {
    const { runOriginBoundType } = buildOriginBoundTypeHarness({
      frameOrigins: [{ frameId: 0, origin: AUTHORIZED_ORIGIN }],
      secretWriteError: `Chrome could not inject args containing ${SECRET}`,
    });

    let caught: unknown;
    try {
      await runOriginBoundType(
        { target: { tabId: 42 } },
        '#password',
        SECRET,
        AUTHORIZED_ORIGIN,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain(
      'credential_write_dispatch_failed_or_may_have_applied_DO_NOT_retry',
    );
    expect(String(caught)).not.toContain(SECRET);
  });

  it('checks the frame origin inside the injected function before touching the DOM', () => {
    const dom = new JSDOM('<!doctype html><input id="password" type="password">', {
      url: 'https://unrelated.example/phishing',
    });
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const build = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = build(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );

    const result = pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
    );

    expect(result).toEqual({ __credentialOriginMismatch: true });
    expect((dom.window.document.querySelector('#password') as HTMLInputElement).value).toBe('');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns only non-secret write status from an authorized frame', () => {
    const dom = new JSDOM('<!doctype html><input id="password" type="password">', {
      url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/`,
    });
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const build = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = build(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );

    const result = pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
      'password',
    );
    const queryResult = pageBridgeScript('query_elements', ['password', 10]);
    const snapshotResult = pageBridgeScript('snapshot', []);

    expect(result).toEqual({ __found: true, valueApplied: true });
    expect(result).not.toHaveProperty('value');
    expect(result).not.toHaveProperty('valueAfter');
    expect(JSON.stringify({ result, queryResult, snapshotResult })).not.toContain(SECRET);
  });

  it('does not let an input handler turn origin-bound status into page-controlled data', () => {
    const dom = new JSDOM('<!doctype html><input id="password" type="password">', {
      url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/`,
    });
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const build = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = build(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );
    const password = dom.window.document.querySelector('#password') as HTMLInputElement;
    password.addEventListener('input', () => {
      Object.defineProperty(password, 'tagName', {
        configurable: true,
        value: password.value,
      });
    });

    const result = pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
      'password',
    );

    expect(result).toEqual({ __found: true, valueApplied: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses a password credential unless the destination is a masked input', () => {
    const dom = new JSDOM('<!doctype html><input id="password" type="text">', {
      url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/`,
    });
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const build = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = build(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );

    const writeResult = pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
      'password',
    );
    const queryResult = pageBridgeScript('query_elements', ['password', 10]);

    expect(writeResult).toEqual({
      __found: true,
      __refusal: 'credential_password_requires_masked_input',
    });
    expect(JSON.stringify({ writeResult, queryResult })).not.toContain(SECRET);
    expect((dom.window.document.querySelector('#password') as HTMLInputElement).value).toBe('');
  });

  it('never returns a credential value in an authorized-frame refusal', () => {
    const dom = new JSDOM(
      '<!doctype html><select id="password"><option value="unchanged">Unchanged</option></select>',
      { url: `${AUTHORIZED_ORIGIN}/accounts/emailsignup/` },
    );
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const build = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = build(
      dom.window,
      dom.window.document,
      dom.window.location,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );

    const result = pageBridgeScript(
      'type',
      ['#password', SECRET],
      AUTHORIZED_ORIGIN,
    );

    expect(result).toEqual({ __found: true, __refusal: 'credential_write_refused' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((dom.window.document.querySelector('#password') as HTMLSelectElement).value)
      .toBe('unchanged');
  });
});
