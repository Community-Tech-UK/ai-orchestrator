import { randomUUID } from 'node:crypto';
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
}
interface RecoveryStatus {
  ok: boolean;
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
  runCommandWithWatchdog: (command: TestCommand) => Promise<unknown>;
  browserCommandErrorMessage: (command: TestCommand, error: unknown, tainted: boolean) => string;
  handleSecretProtectionMessage: (message: Record<string, unknown>, sender: unknown) => Promise<RecoveryStatus>;
  setGatewayEnabled: (enabled: boolean) => Promise<unknown>;
  loadSecretTaints: () => Promise<void>;
  secretTaintedTabs: Map<string, string>;
  secretTaintedOrigins: Set<string>;
  activeCount: () => number;
  enabled: () => boolean;
}

export function recoveryHarness(stored: unknown = { version: 2, origins: [PROTECTED_ORIGIN], tabs: {} }, gatewayLoad?: Promise<boolean>) {
  const tabs = new Map<number, TestTab>([[42, {
    id: 42, windowId: 7, url: PUBLIC_ORIGIN + '/', title: 'Test page',
  }]]);
  const storage: Record<string, unknown> = { browserGatewayEnabled: false, browserGatewaySecretTaints: stored };
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const nativeMessages: Array<Record<string, unknown>> = [];
  const chrome = {
    runtime: {
      ...POPUP_SENDER,
      getURL: (file: string) => 'chrome-extension://test-only-extension/' + file,
      getManifest: () => ({ version: '0.2.19' }),
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
      session: { set: vi.fn(async () => undefined) },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => tabs.get(id)),
      update: vi.fn(async (id: number) => tabs.get(id)),
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
    chrome, URL, crypto: { randomUUID }, console,
    setTimeout: (callback: () => void, delay: number) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer: unknown) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1); },
  });
  const source = readFileSync('resources/browser-extension/background.js', 'utf8');
  const runtime = runInContext(source + `
    ;({ assertSecretObservationAllowed, secretTaintOriginForTab, buildTabPayload,
      markSecretTaint, clearSecretTaint, targetSecretTaintOrigin, runBrowserCommand, runCommandWithWatchdog, browserCommandErrorMessage,
      handleSecretProtectionMessage, setGatewayEnabled, loadSecretTaints,
      secretTaintedTabs, secretTaintedOrigins,
      activeCount: () => activeBrowserCommandCount, enabled: () => gatewayEnabled });`, context) as Runtime;
  const send = (message: Record<string, unknown>, sender: unknown = POPUP_SENDER) => new Promise<RecoveryStatus>((resolve) => {
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    listener(message, sender, resolve);
  });
  const status = () => send({ type: 'get_secret_protection' });
  const reset = (reviewToken: string | null | undefined, sender: unknown = POPUP_SENDER) => send({
    type: 'reset_secret_protection', confirmed: true, reviewToken,
  }, sender);
  return { ...runtime, advanceTime: (ms: number) => { now += ms; }, context, chrome, storage, tabs, timers, nativeMessages, send, status, reset };
}

export async function settle() {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
