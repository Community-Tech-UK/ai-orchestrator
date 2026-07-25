/**
 * Vitest setup for the phone app: boot Angular's TestBed so services and
 * components can be exercised under DI. The app is zoneless and JIT-free at
 * runtime, so the compiler is imported explicitly for tests only.
 */
import '@angular/compiler';
import { beforeEach, afterEach } from 'vitest';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

if (!getTestBed().platform) {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

beforeEach(() => getTestBed().resetTestingModule());
afterEach(() => getTestBed().resetTestingModule());
