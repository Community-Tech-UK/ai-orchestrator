#!/usr/bin/env node
/**
 * Bounded knip unused-export scan.
 *
 * This is a local diagnostic, not a CI gate. knip's full graph on this repo
 * is noisy; keep the script warn-only unless KNIP_STRICT=1.
 *
 * Usage: node scripts/check-knip.js
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 60_000;
const STRICT = process.env.KNIP_STRICT === '1';

const result = spawnSync(
  'npx',
  ['--yes', 'knip', '--no-config-hints', '--reporter', 'compact', '--include', 'files,exports,types,nsExports,nsTypes'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  },
);

if (result.error && result.error.code === 'ETIMEDOUT') {
  console.warn(`[knip] timed out after ${TIMEOUT_MS}ms`);
  process.exit(0);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  console.warn('[knip] unused files/exports detected (warn-only; set KNIP_STRICT=1 to fail)');
  process.exit(STRICT ? (result.status ?? 1) : 0);
}

console.log('[knip] clean');
process.exit(0);
