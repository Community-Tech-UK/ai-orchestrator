#!/usr/bin/env node
/**
 * Slow-tier test runner — e2e + soak specs excluded from the default suite.
 *
 * Usage:
 *   npm run test:slow
 *   node scripts/run-tests-slow.js
 *
 * These tests use real git, wall-clock waits, or large I/O. Keep them on
 * pre-push / CI / nightly rather than every local iteration.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const passthroughArgs = process.argv.slice(2);

const vitestBin = require.resolve('vitest/vitest.mjs');
const args = [
  'run',
  '--config',
  path.join(ROOT, 'vitest.slow.config.ts'),
  ...passthroughArgs,
  '--reporter=default',
];

const child = spawn(process.execPath, [vitestBin, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error(`Failed to launch vitest: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(typeof code === 'number' ? code : 1);
});
