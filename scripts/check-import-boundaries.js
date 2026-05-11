#!/usr/bin/env node
/**
 * Import boundary checker for ai-orchestrator.
 *
 * Enforces architecture rules that static analysis (tsc, eslint) can't catch:
 *   1. Renderer must not import from src/main (use IPC instead)
 *   2. SDK package must not import from src/main internals
 *   3. Contracts package must not import from src/main internals
 *
 * Inspired by openclaw boundary scripts and claude3.md §14 recommendations.
 * Run with: node scripts/check-import-boundaries.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** @typedef {{ from: RegExp, to: RegExp, message: string }} BoundaryRule */

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
    const dir = path.join(ROOT, rule.fromGlob);
    const files = walk(dir);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (rule.toPattern.test(lines[i])) {
          console.error(
            `BOUNDARY VIOLATION [${rule.fromGlob}]\n` +
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
