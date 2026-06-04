#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

// Generated artifacts are staged by the pre-commit hook itself (via `git add`)
// and are widely imported, so feeding them to `vitest related` would balloon
// the run to nearly the full suite. They're validated separately by the
// `verify:*` steps on pre-push, so exclude them here to keep commits — including
// the loop agents' high-frequency auto-commits of regenerated artifacts — fast.
const { GENERATED_ARTIFACTS } = require('./run-git-hook.js');

// File extensions vitest can map back to related test files.
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx|js|cjs|mjs|jsx)$/;

function getStagedTestRelatedFiles(options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const excluded = new Set(options.generatedArtifacts ?? GENERATED_ARTIFACTS);

  const raw = String(
    exec('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => SOURCE_FILE_PATTERN.test(file))
    .filter((file) => !excluded.has(file))
    // A staged delete leaves no file on disk; vitest related needs the file to exist.
    .filter((file) => existsSync(file));
}

function runStagedTests(options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const log = options.log ?? console.log;
  const files = options.files ?? getStagedTestRelatedFiles(options);

  if (files.length === 0) {
    log('test-staged: no staged source files to test; skipping');
    return 0;
  }

  log(`test-staged: running tests related to ${files.length} staged file(s)`);

  const result = run('npx', ['vitest', 'related', '--run', '--passWithNoTests', ...files], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`test-staged failed to run vitest: ${result.error.message}`);
    return 1;
  }

  if (result.signal) {
    console.error(`test-staged stopped: vitest received ${result.signal}`);
    return 1;
  }

  return result.status ?? 1;
}

function main() {
  try {
    process.exit(runStagedTests());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SOURCE_FILE_PATTERN,
  getStagedTestRelatedFiles,
  runStagedTests,
};
