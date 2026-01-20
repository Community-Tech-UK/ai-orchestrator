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
