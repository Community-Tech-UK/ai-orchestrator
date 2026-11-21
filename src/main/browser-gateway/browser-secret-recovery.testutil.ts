import { randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { vi } from 'vitest';

export const PROTECTED_ORIGIN = 'https://test-only-protected.example';
export const PUBLIC_ORIGIN = 'https://test-only-public.example';
export const POPUP_SENDER = { id: 'test-only-extension', url: 'chrome-extension://test-only-extension/popup.html' };
export const MARKER = 'TEST_ONLY_SECRET_MARKER';
export interface ScriptResult { frameId?: number; result?: Record<string, unknown> }
export interface TestTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  openerTabId?: number;
}
export interface TestCommand {
  id: string;
  command: string;
  target?: { tabId: number };
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  sessionOwner?: string;
}
interface RecoveryStatus {
  ok: boolean;
  protectionEnabled?: boolean;
  origins?: string[];
  tabCount?: number;
  reviewToken?: string | null;
  error?: string;
}
interface Runtime {
  assertSecretObservationAllowed: (command: TestCommand) => Promise<void>;
  secretTaintOriginForTab: (tab: TestTab) => Promise<string | null>;
  buildTabPayload: (tab: TestTab, options: { includeText: boolean; includeScreenshot?: boolean }) => Promise<Record<string, unknown>>;
  markSecretTaint: (tabId: number, origin: string) => Promise<void>;
  clearSecretTaint: (tabId: number) => Promise<void>;
  targetSecretTaintOrigin: (command: TestCommand) => Promise<string | null>;
  runBrowserCommand: (command: TestCommand, bridge: unknown) => Promise<void>;
  runSessionScopedBrowserCommand: (command: TestCommand, bridge: unknown) => Promise<void>;
  runCommandWithWatchdog: (command: TestCommand) => Promise<unknown>;
  browserCommandErrorMessage: (command: TestCommand, error: unknown, tainted: boolean) => string;
  handleSecretProtectionMessage: (message: Record<string, unknown>, sender: unknown) => Promise<RecoveryStatus>;
  applySecretObservationProtectionEnabled: (enabled: boolean) => Promise<void>;
  applySecretObservationProtectionFromCommand: (command: TestCommand) => Promise<void>;
  setGatewayEnabled: (enabled: boolean) => Promise<unknown>;
  loadSecretTaints: () => Promise<void>;
  loadSecretObservationProtection: () => Promise<boolean>;
  secretObservationStatus: () => Promise<{ protectionEnabled: boolean; taintedOriginCount: number; taintedTabCount: number }>;
  secretTaintedTabs: Map<string, string>;
  secretTaintedOrigins: Set<string>;
  activeCount: () => number;
  enabled: () => boolean;
  protectionEnabled: () => boolean;
  writeGeneration: () => string | null;
}

export function recoveryHarness(stored: unknown = { version: 2, origins: [PROTECTED_ORIGIN], tabs: {} }, gatewayLoad?: Promise<boolean>) {
  const tabs = new Map<number, TestTab>([[42, {
    id: 42, windowId: 7, url: PUBLIC_ORIGIN + '/', title: 'Test page',
  }]]);
  const storage: Record<string, unknown> = { browserGatewayEnabled: false, browserGatewaySecretTaints: stored };
  const sessionStorage: Record<string, unknown> = {};
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const nativeMessages: Array<Record<string, unknown>> = [];
  const chrome = {
    runtime: {
      ...POPUP_SENDER,
      getURL: (file: string) => 'chrome-extension://test-only-extension/' + file,
      getManifest: () => ({ version: '0.2.21' }),
      onInstalled: event(), onStartup: event(), onMessage: event(),
      connectNative: vi.fn(() => ({
        onMessage: event(), onDisconnect: event(), disconnect: vi.fn(),
        postMessage: vi.fn((message: Record<string, unknown>) => nativeMessages.push(message)),
      })),
    },
    alarms: { onAlarm: event() },
    action: {},
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: key === 'browserGatewayEnabled' && gatewayLoad ? await gatewayLoad : storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, structuredClone(values)); }),
      },
      // Real session storage, so tab claims persist between commands like Chrome's.
      session: {
        get: vi.fn(async (key: string) => (key in sessionStorage ? { [key]: structuredClone(sessionStorage[key]) } : {})),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionStorage, structuredClone(values)); }),
      },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => tabs.get(id)),
      update: vi.fn(async (id: number) => tabs.get(id)),
    },
    windows: {
      onRemoved: event(),
    },
    webRequest: {
      onAuthRequired: event(),
    },
    webNavigation: {
      onBeforeNavigate: event(),
      getAllFrames: vi.fn(async (_input: { tabId: number }): Promise<Array<Record<string, unknown>>> => []),
    },
    debugger: {
      onEvent: event(), onDetach: event(),
    },
    scripting: {
      executeScript: vi.fn(async (input: { func: { name: string }; target: { tabId: number }; args?: unknown[] }): Promise<ScriptResult[]> => {
        if (input.func.name === 'credentialFrameOriginProbe') {
          return [{ frameId: 0, result: { origin: new URL(tabs.get(input.target.tabId)!.url).origin } }];
        }
        return [{ frameId: 0, result: { title: MARKER, text: MARKER } }];
      }),
    },
  };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let now = Date.now();
  const context = createContext({
    Date: { now: () => now },
    chrome, URL, crypto: { randomUUID, subtle: webcrypto.subtle }, TextEncoder, URLSearchParams, console,
    setTimeout: (callback: () => void, delay: number) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer: unknown) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1); },
    // The imported helpers are loaded below, ahead of background.js.
    importScripts: (name: string): void => {
      if (!['codex-device-handoff.js', 'browser-session-claims.js'].includes(name)) throw new Error('Unexpected extension import');
    },
  });
  const source = readFileSync('resources/browser-extension/codex-device-handoff.js', 'utf8') + '\n'
    + readFileSync('resources/browser-extension/browser-session-claims.js', 'utf8') + '\n'
    + readFileSync('resources/browser-extension/background.js', 'utf8');
  const runtime = runInContext(source + `
    ;({ assertSecretObservationAllowed, secretTaintOriginForTab, buildTabPayload,
      markSecretTaint, clearSecretTaint, targetSecretTaintOrigin, runBrowserCommand, runSessionScopedBrowserCommand,
      runCommandWithWatchdog, browserCommandErrorMessage,
      handleSecretProtectionMessage, applySecretObservationProtectionEnabled, applySecretObservationProtectionFromCommand, setGatewayEnabled, loadSecretTaints,
      loadSecretObservationProtection, secretObservationStatus,
      secretTaintedTabs, secretTaintedOrigins, httpAuthChallenges,
      activeCount: () => activeBrowserCommandCount, enabled: () => gatewayEnabled,
      protectionEnabled: () => secretObservationProtectionEnabled,
      writeGeneration: () => secretWriteGeneration });`, context) as Runtime;
  const send = (message: Record<string, unknown>, sender: unknown = POPUP_SENDER) => new Promise<RecoveryStatus>((resolve) => {
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    listener(message, sender, resolve);
  });
  const status = () => send({ type: 'get_secret_protection' });
  const reset = (reviewToken: string | null | undefined, sender: unknown = POPUP_SENDER) => send({
    type: 'reset_secret_protection', confirmed: true, reviewToken,
  }, sender);
  /** Runs one command through the real native command runner and returns its command_result. */
  const run = async (command: TestCommand, options: { sessionScoped?: boolean } = {}): Promise<Record<string, unknown>> => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = { outbox: [], hostName: 'test-only-host', nativePort: { postMessage: (m: Record<string, unknown>) => sent.push(m) } };
    // The session-scoped path is the one real commands take: it enforces tab claims first.
    await (options.sessionScoped ? runtime.runSessionScopedBrowserCommand : runtime.runBrowserCommand)(command, bridge);
    const result = sent.find((message) => message['type'] === 'command_result' && message['commandId'] === command.id);
    if (!result) throw new Error('no command_result for ' + command.id);
    return result;
  };
  return { ...runtime, advanceTime: (ms: number) => { now += ms; }, context, chrome, storage, tabs, timers, nativeMessages, send, status, reset, run };
}

export async function settle() {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
