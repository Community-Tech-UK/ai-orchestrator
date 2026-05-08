#!/usr/bin/env node

/**
 * Run the Vitest suite and restore native modules back to Electron's ABI after
 * tests finish. `pretest` may rebuild native modules for the host Node runtime;
 * leaving that binary in place makes the next Electron build/start fail.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const defaultProjectRoot = path.resolve(__dirname, '..');

function exitCodeFor(result) {
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  if (typeof result.status === 'number') {
    return result.status;
  }
  if (result.signal) {
    console.error(`Process terminated by signal ${result.signal}`);
    return 1;
  }
  return 1;
}

function defaultRun(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
}

function runTestsWithNativeRestore({
  nodeExec = process.execPath,
  projectRoot = defaultProjectRoot,
  testArgs = process.argv.slice(2),
  run = (command, args) => defaultRun(command, args, projectRoot),
} = {}) {
  const checkNodeEntry = path.join(projectRoot, 'scripts', 'check-node.js');
  const ensureTestNativeEntry = path.join(projectRoot, 'scripts', 'ensure-test-native-modules.js');
  const verifyExportsEntry = path.join(projectRoot, 'scripts', 'verify-package-exports.js');
  const vitestEntry = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const restoreEntry = path.join(projectRoot, 'scripts', 'rebuild-native-modules.js');

  let exitCode = 0;

  try {
    for (const entry of [checkNodeEntry, ensureTestNativeEntry, verifyExportsEntry]) {
      exitCode = exitCodeFor(run(nodeExec, [entry]));
      if (exitCode !== 0) break;
    }

    if (exitCode === 0) {
      exitCode = exitCodeFor(run(nodeExec, [vitestEntry, 'run', ...testArgs]));
    }
  } finally {
    const restoreExitCode = exitCodeFor(run(nodeExec, [restoreEntry]));
    if (exitCode === 0 && restoreExitCode !== 0) {
      exitCode = restoreExitCode;
    }
  }

  return exitCode;
}

if (require.main === module) {
  process.exit(runTestsWithNativeRestore());
}

module.exports = {
  runTestsWithNativeRestore,
  exitCodeFor,
};
