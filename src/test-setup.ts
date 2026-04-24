/**
 * Angular TestBed setup for Vitest
 * This file initializes the Angular testing environment before tests run
 */

import 'zone.js';
import 'zone.js/testing';
import { afterEach, beforeEach, vi } from 'vitest';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import {
  initSqliteWasm,
  createSqliteWasmDatabase,
} from './main/db/sqlite-wasm-driver';

// ============================================================================
// better-sqlite3 → sqlite-wasm (test-only)
//
// better-sqlite3 is a native module. Its compiled `.node` binary is built
// against Electron's ABI (NODE_MODULE_VERSION 143 for Electron 40) but vitest
// runs under the installed Node (ABI 141). Loading it in tests crashes at
// `new Database(...)` with "was compiled against a different Node.js version".
//
// The `SqliteDriver` port in `src/main/db/sqlite-driver.ts` lets us swap the
// backend without touching application code. Here, in the vitest process only,
// we replace `import Database from 'better-sqlite3'` with a constructor that
// returns a WASM-backed driver (`@sqlite.org/sqlite-wasm`, FTS5 included).
// Production is unaffected — `vi.mock` only applies to the vitest module graph.
//
// Initialize the WASM module up-front so the mock factory's synchronous
// constructor has a ready runtime.
// ============================================================================

await initSqliteWasm();

// ============================================================================
// Global timer-state reset
//
// vitest.config.ts uses `singleFork: true` so all tests share one Node process.
// Any test that (a) calls `vi.useFakeTimers()` without `vi.useRealTimers()`,
// (b) does `vi.spyOn(globalThis, 'setTimeout')` without `mockRestore()`, or
// (c) fails mid-test before its own teardown runs, leaves fake/stubbed timers
// engaged for every subsequent test file. Later tests using real `setTimeout`
// then hang until the 5 s test timeout — manifesting on Linux CI as dozens of
// unrelated failures (file-load order differs from macOS, so the leak lands
// later on dev machines and is invisible).
//
// Reset timer globals both before AND after every test, covering the cases
// where beforeAll / module-scope code installed the mock (afterEach alone
// would not fire in time) and where a throwing test skipped its own afterEach.
// ============================================================================

type TimerGlobals = {
  setTimeout: typeof globalThis.setTimeout;
  setInterval: typeof globalThis.setInterval;
  clearTimeout: typeof globalThis.clearTimeout;
  clearInterval: typeof globalThis.clearInterval;
  setImmediate: typeof globalThis.setImmediate;
  clearImmediate: typeof globalThis.clearImmediate;
  queueMicrotask: typeof globalThis.queueMicrotask;
};

const timerGlobalsKey = Symbol.for('ai-orchestrator.test.realTimerGlobals');
const timerGlobalState = globalThis as typeof globalThis & {
  [timerGlobalsKey]?: TimerGlobals;
};

// setupFiles can be re-executed for later spec files inside the same Vitest
// fork. Capture the baseline exactly once; otherwise a leaked fake timer from
// an earlier file can be captured as the new "real" timer on CI.
const realTimers = timerGlobalState[timerGlobalsKey] ?? {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  queueMicrotask: globalThis.queueMicrotask,
} as const;
timerGlobalState[timerGlobalsKey] = realTimers;

function resetTimerGlobals() {
  // vi.useRealTimers() handles sinon's fake clock, but if a test did
  // `vi.spyOn(globalThis, 'setTimeout')` without restoring, the global is
  // still wrapped. Force-restore the originals so the next test can use
  // real timers even if the previous one forgot to call mockRestore().
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [name, fn] of Object.entries(realTimers)) {
    if (globalThis[name as keyof typeof realTimers] !== fn) {
      (globalThis as unknown as Record<string, unknown>)[name] = fn;
    }
  }
}

vi.mock('better-sqlite3', () => {
  class MockDatabase {
    constructor(filename: string, options?: { readonly?: boolean }) {
      // Constructor returning an object causes `new MockDatabase(...)` to
      // yield that object. The returned driver exposes every method and
      // property tests and production code actually use.
      return createSqliteWasmDatabase(filename, options) as unknown as MockDatabase;
    }
  }
  return { default: MockDatabase };
});

// Node 25's experimental webstorage installs a broken `globalThis.localStorage = {}`
// stub before jsdom loads. Vitest's jsdom populateGlobal sees localStorage "already
// in global" and filters it out of the keys copied from dom.window, leaving the
// broken stub as window.localStorage. Detect and replace with an in-memory polyfill.
if (typeof window !== 'undefined' && typeof window.localStorage?.clear !== 'function') {
  const makeStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
      get length() { return store.size; },
      clear() { store.clear(); },
      getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
      key(index: number) { return Array.from(store.keys())[index] ?? null; },
      removeItem(key: string) { store.delete(key); },
      setItem(key: string, value: string) { store.set(key, String(value)); },
    };
  };
  Object.defineProperty(window, 'localStorage', { value: makeStorage(), configurable: true, writable: true });
  Object.defineProperty(window, 'sessionStorage', { value: makeStorage(), configurable: true, writable: true });
}

// Only initialize if not already initialized
// Check if platform is already set up by looking at the internal state
try {
  const testBed = getTestBed();
  if (!testBed.platform) {
    TestBed.initTestEnvironment(
      BrowserDynamicTestingModule,
      platformBrowserDynamicTesting(),
      { teardown: { destroyAfterEach: true } }
    );
  }
} catch {
  // If getTestBed fails, initialize fresh
  TestBed.initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting(),
    { teardown: { destroyAfterEach: true } }
  );
}

function resetAngularTestBed() {
  try {
    getTestBed().resetTestingModule();
  } catch {
    // TestBed may be unavailable if Angular setup failed before initialization.
  }
}

beforeEach(() => {
  resetTimerGlobals();
  resetAngularTestBed();
});

afterEach(() => {
  resetAngularTestBed();
  resetTimerGlobals();
});
