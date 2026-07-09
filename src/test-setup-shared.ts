/**
 * Shared Vitest setup for all projects (node + jsdom).
 *
 * Keeps hermetic git env, better-sqlite3 → sqlite-wasm swap, and
 * timer-global resets. Angular/jsdom setup lives only in `test-setup.ts`.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import {
  initSqliteWasm,
  createSqliteWasmDatabase,
} from './main/db/sqlite-wasm-driver';
import { stripScopedGitEnv } from './main/workspace/git/git-env';

// ============================================================================
// Hermetic git env (test-only)
//
// When the suite runs inside a git hook (pre-commit/pre-push — see
// scripts/run-git-hook.js), git exports GIT_INDEX_FILE=.git/index (and friends)
// into the environment. Any test that shells out to git against a temp repo then
// inherits those and fails with `fatal: .git/index: index file open failed: Not
// a directory`. Strip them once, up-front, so every real-git test resolves its
// repo purely from cwd regardless of how the suite was launched.
// ============================================================================
stripScopedGitEnv(process.env);

// ============================================================================
// better-sqlite3 → sqlite-wasm (test-only)
//
// better-sqlite3 is a native module. Its compiled `.node` binary is built
// against Electron's ABI but vitest runs under the installed Node. Loading it
// in tests crashes at `new Database(...)`.
//
// Eager WASM init keeps the mock factory synchronous. An async `vi.mock`
// factory was tried for laziness but broke unrelated mock resolution under
// the node project (e.g. multi-verify cache hits never completing).
// ============================================================================
await initSqliteWasm();

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

// ============================================================================
// Global timer-state reset
//
// Forks may still run multiple files in one process. Any test that (a) calls
// `vi.useFakeTimers()` without `vi.useRealTimers()`, (b) spies `setTimeout`
// without `mockRestore()`, or (c) fails mid-test before teardown, can leave
// fake/stubbed timers engaged for later files in the same fork.
// ============================================================================

interface TimerGlobals {
  setTimeout: typeof globalThis.setTimeout;
  setInterval: typeof globalThis.setInterval;
  clearTimeout: typeof globalThis.clearTimeout;
  clearInterval: typeof globalThis.clearInterval;
  setImmediate: typeof globalThis.setImmediate;
  clearImmediate: typeof globalThis.clearImmediate;
  queueMicrotask: typeof globalThis.queueMicrotask;
}

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

beforeEach(() => {
  resetTimerGlobals();
});

afterEach(() => {
  resetTimerGlobals();
});
