#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Generated artifacts are staged by the pre-commit hook itself (via `git add`)
// and are widely imported, so feeding them to `vitest related` would balloon
// the run to nearly the full suite. They're validated separately by the
// `verify:*` steps on pre-push, so exclude them here to keep commits — including
// the loop agents' high-frequency auto-commits of regenerated artifacts — fast.
const { GENERATED_ARTIFACTS } = require('./run-git-hook.js');

// File extensions vitest can map back to related test files.
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx|js|cjs|mjs|jsx)$/;

// This build-refreshed snapshot is imported by the entire Codex runtime. Like
// other generated artifacts it has dedicated validation instead of expanding
// every transitive importer. Real adapter changes still use normal discovery.
const CODEX_PROTOCOL_SNAPSHOT = 'src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts';
const CODEX_PROTOCOL_TESTS = [
  'src/main/cli/adapters/codex/generated/app-server-protocol.gen.spec.ts',
  'src/main/cli/adapters/codex/app-server-client-protocol.spec.ts',
  'src/main/cli/adapters/codex/app-server-client.spec.ts',
  'src/main/cli/adapters/codex/codex-protocol-snapshot-check.spec.ts',
  'scripts/__tests__/refresh-codex-protocol.spec.ts',
];

// scripts/remote-checks/run-staged.js exits with this when the tests belong on this machine.
const STAY_ON_THE_MAC = 75;

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

  const existsSync = options.existsSync ?? fs.existsSync;
  const relatedFiles = [];
  for (const file of files) {
    if (file !== CODEX_PROTOCOL_SNAPSHOT) {
      relatedFiles.push(file);
      continue;
    }
    for (const test of CODEX_PROTOCOL_TESTS) {
      if (!existsSync(test)) {
        console.error(`test-staged: required Codex protocol validation is missing: ${test}`);
        return 1;
      }
      relatedFiles.push(test);
    }
  }

  const selection = [...new Set(relatedFiles)];
  const elsewhere = options.runElsewhere?.(selection, run);
  if (elsewhere !== undefined && elsewhere !== STAY_ON_THE_MAC) return elsewhere;

  // Related tests can launch compiled workers through indirect dependencies.
  // Rebuild every source selection rather than duplicating Vitest's graph here;
  // documentation/generated-only commits return above without paying this cost.
  log('test-staged: rebuilding main workers before related tests');
  const build = run('npm', ['run', 'build:main'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (build.error) {
    console.error(`test-staged failed to build main workers: ${build.error.message}`);
    return 1;
  }

  if (build.signal) {
    console.error(`test-staged stopped: main build received ${build.signal}`);
    return 1;
  }

  const buildStatus = build.status ?? 1;
  if (buildStatus !== 0) {
    return buildStatus;
  }

  log(`test-staged: running tests related to ${files.length} staged file(s)`);

  // Source batches have overlapping dependency graphs and rerun the same tests.
  // Feed the entire list through stdin to one Vitest run instead: no cmd.exe or
  // OS argument-length limit, and each related test specification executes once.
  const result = run(process.execPath, [path.join(__dirname, 'run-related-tests.mjs')], {
    input: JSON.stringify(selection),
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
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

/** A change that reaches a lot of tests can go to the test machine. It builds there too. */
function runOnTestMachine(selection, run) {
  const result = run(process.execPath, [path.join(__dirname, 'remote-checks', 'run-staged.js')], {
    input: JSON.stringify(selection),
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) {
    console.error(`test-staged could not try the test machine: ${result.error.message}`);
    return STAY_ON_THE_MAC;
  }
  // A killed run says nothing about the machine or the tests, so it fails like any other killed run.
  return result.signal ? 1 : result.status ?? 1;
}

function main() {
  try {
    process.exit(runStagedTests({ runElsewhere: runOnTestMachine }));
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
  runOnTestMachine,
  runStagedTests,
};
