/**
 * Angular TestBed setup for Vitest
 * This file initializes the Angular testing environment before tests run
 */

import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

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
