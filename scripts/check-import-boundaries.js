#!/usr/bin/env node
/**
 * Import boundary checker for ai-orchestrator.
 *
 * Enforces architecture rules that static analysis (tsc, eslint) can't catch:
 *   1. Renderer must not import from src/main (use IPC instead)
 *   2. SDK package must not import from src/main internals
 *   3. Contracts package must not import from src/main internals
 *   4. Designated main-process hot-path modules must not import a synchronous
 *      SQLite engine directly (better-sqlite3 / its driver factory). Per the
 *      main-thread-offload architecture, all DB work on user-facing hot paths
 *      must go through a worker/gateway, never a synchronous connection on the
 *      Electron main event loop.
 *
 * Inspired by openclaw boundary scripts and claude3.md §14 recommendations.
 * Run with: node scripts/check-import-boundaries.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * @typedef {Object} BoundaryRule
 * @property {string} [fromGlob]   Directory prefix; every source file under it is checked.
 * @property {string[]} [fromFiles] Explicit repo-relative file paths to check (alternative to fromGlob).
 * @property {RegExp} toPattern    A line matching this pattern is a violation.
 * @property {string} message      Human-readable explanation shown on violation.
 */

/**
 * Matches importing the synchronous SQLite engine: the `better-sqlite3` package
 * itself, or any relative import ending in `better-sqlite3-driver` (the factory
 * that opens a real connection). Type-only imports of the `sqlite-driver`
 * interface are intentionally NOT matched — they are erased at compile time and
 * carry no runtime connection.
 */
const SYNC_SQLITE_IMPORT = /(?:from|require)\s*\(?['"](?:better-sqlite3|(?:[^'"]*\/)?better-sqlite3-driver)['"]/;

/**
 * Main-process modules that sit on a user-facing hot path (instance
 * create/resume/send, live transcript bridging) and must therefore never open
 * or call a synchronous SQLite connection directly. New DB needs here must be
 * routed through a worker gateway instead.
 */
const HOT_PATH_FILES = [
  'src/main/chats/chat-transcript-bridge.ts',
  'src/main/instance/instance-lifecycle.ts',
  'src/main/instance/instance-manager.ts',
  'src/main/instance/instance-communication.ts',
  'src/main/app/instance-event-forwarding.ts',
];

/** Rules: any file matching `from` must not have an import matching `to`. */
const RULES = [
  {
    // Angular renderer must never reach into the Electron main process directly.
    // All communication must go through the IPC preload bridge.
    // Imports from src/shared are allowed (types shared between processes).
    fromGlob: 'src/renderer',
    toPattern: /(?:from|require)\s*\(?['"](?:\.\.\/)+main\//,
    message: 'renderer → main: use the IPC preload bridge (window.electronAPI.*), not direct imports from src/main',
  },
  {
    // Public SDK must not depend on internal main-process code.
    fromGlob: 'packages/sdk/src',
    toPattern: /(?:from|require)\s*\(?['"](?:\.\.\/)+src\/main/,
    message: 'sdk → main: SDK cannot import internal main-process modules',
  },
  {
    // Contracts package must not depend on main-process code.
    fromGlob: 'packages/contracts/src',
    toPattern: /(?:from|require)\s*\(?['"](?:\.\.\/)+src\/main/,
    message: 'contracts → main: contracts package cannot import internal main-process modules',
  },
  {
    // Preload bridge must not import from main (Electron security boundary).
    // It should only use the contextBridge API and import from shared/contracts.
    fromGlob: 'src/preload',
    toPattern: /(?:from|require)\s*\(?['"](?:\.\.\/)+main\/(?!index)/,
    message: 'preload → main internals: preload may only reference main/index entry point',
  },
  {
    // Hot-path main-process modules must not open a synchronous SQLite engine.
    fromFiles: HOT_PATH_FILES,
    toPattern: SYNC_SQLITE_IMPORT,
    message:
      'hot-path → better-sqlite3: this module runs on a user-facing hot path and must not ' +
      'import a synchronous SQLite engine; route DB work through a worker gateway instead',
  },
  {
    // Spawn safety: the packaged app disables the RunAsNode fuse
    // (scripts/set-electron-fuses.js), so ELECTRON_RUN_AS_NODE is silently
    // ignored; spawning process.execPath with it boots a SECOND full
    // Electron app. From a helper process this dies instantly with
    // `FATAL: Unable to find helper app` (the 2026-06 crash storm).
    fromGlob: 'src/main',
    toPattern: /ELECTRON_RUN_AS_NODE\s*[:=]\s*['"]1['"]/,
    skipTests: true,
    exemptFiles: ['src/main/runtime/isolated-worker-process.ts'],
    message:
      'main -> ELECTRON_RUN_AS_NODE spawn: the RunAsNode fuse is disabled in packaged builds, so ' +
      'this env var does nothing there and the child boots as a full Electron app (helper SIGTRAP ' +
      'crash). Use createIsolatedWorkerProcess (utilityProcess-backed) or a bundled SEA binary.',
  },
  {
    // Spawn safety: child_process.fork() always spawns process.execPath, which
    // is the Electron binary in packaged builds; same failure mode as above.
    fromGlob: 'src/main',
    toPattern: /\bfork\b.*(?:from|require)\s*\(?\s*['"](?:node:)?child_process['"]/,
    skipTests: true,
    exemptFiles: [
      'src/main/runtime/isolated-worker-process.ts',
      'src/main/background-jobs/process-lane-gateway.ts',
    ],
    message:
      'main -> child_process.fork: fork() spawns process.execPath, which is the fused Electron ' +
      'binary in packaged builds and boots a second app instead of a Node worker. Use ' +
      'createIsolatedWorkerProcess (utilityProcess-backed) instead.',
  },
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'out', 'release']);

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function checkBoundaries() {
  let violations = 0;

  for (const rule of RULES) {
    const files = rule.fromFiles
      ? rule.fromFiles.map((rel) => path.join(ROOT, rel)).filter((f) => fs.existsSync(f))
      : walk(path.join(ROOT, rule.fromGlob));
    const label = rule.fromGlob ?? 'hot-path-files';
    const exempt = new Set((rule.exemptFiles ?? []).map((rel) => path.join(ROOT, rel)));

    for (const file of files) {
      if (exempt.has(file)) continue;
      if (rule.skipTests && /\.spec\.[jt]sx?$|__tests__/.test(file)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (rule.toPattern.test(lines[i])) {
          console.error(
            `BOUNDARY VIOLATION [${label}]\n` +
            `  File: ${path.relative(ROOT, file)}:${i + 1}\n` +
            `  Line: ${lines[i].trim()}\n` +
            `  Rule: ${rule.message}\n`,
          );
          violations++;
        }
      }
    }
  }

  return violations;
}

const violations = checkBoundaries();
if (violations > 0) {
  console.error(`${violations} import boundary violation(s) found.`);
  process.exit(1);
} else {
  console.log('Import boundary check passed.');
}
