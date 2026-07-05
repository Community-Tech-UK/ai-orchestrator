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

// Windows' cmd.exe caps a command line at ~8191 chars. A large staged set (e.g.
// a merge commit touching hundreds of files) overflows that when every path is
// appended to `npx vitest related`, failing with "The command line is too long."
// Keep each batch's combined path length well under the limit, leaving headroom
// for the fixed `npx vitest related --run --passWithNoTests` prefix.
const MAX_ARG_CHARS = 6000;

// Split files into batches whose combined length (plus separators) stays under
// MAX_ARG_CHARS so each spawned command line fits Windows' limit.
function batchFilesByLength(files, maxChars = MAX_ARG_CHARS) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1; // +1 for the separating space
    if (current.length > 0 && length + cost > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

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

  const batches = batchFilesByLength(files);
  if (batches.length > 1) {
    log(`test-staged: splitting into ${batches.length} batch(es) to fit command-line limits`);
  }

  for (const batch of batches) {
    const result = run('npx', ['vitest', 'related', '--run', '--passWithNoTests', ...batch], {
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

    const status = result.status ?? 1;
    if (status !== 0) {
      return status;
    }
  }

  return 0;
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
  batchFilesByLength,
  getStagedTestRelatedFiles,
  runStagedTests,
};
