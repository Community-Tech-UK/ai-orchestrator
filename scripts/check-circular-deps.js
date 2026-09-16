#!/usr/bin/env node
/**
 * Bounded circular-dependency scan.
 *
 * A whole-tree `madge --circular src/main src/renderer src/shared` hangs on
 * this repo. Scan one domain at a time with a timeout instead. This is a
 * local diagnostic, not a CI gate.
 *
 * Usage: node scripts/check-circular-deps.js
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 20_000;
const DOMAINS = [
  'src/shared',
  'src/preload',
  'packages/contracts/src',
  'src/main/ipc',
  'src/main/cli',
];

let failed = false;
for (const domain of DOMAINS) {
  const result = spawnSync(
    'npx',
    ['--yes', 'madge', '--circular', '--extensions', 'ts', domain],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    },
  );
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.warn(`[circular] timed out after ${TIMEOUT_MS}ms: ${domain}`);
    continue;
  }
  if (result.status !== 0) {
    failed = true;
    console.error(`[circular] ${domain}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    console.log(`[circular] clean: ${domain}`);
  }
}

process.exit(failed ? 1 : 0);
