'use strict';
/**
 * A few specs can only prove anything on a Mac. After a run on Linux they run on a Mac, a
 * test Mac in the list or this one, and their results replace the Linux machine's skipped
 * versions in the one report, so a failure shows as a normal test failure and fails the run.
 */

const fs = require('fs');

const MAC_ONLY_SPECS = [
  'src/main/sandbox/signal-fence.spec.ts',
  'src/main/cli/adapters/base-cli-adapter-hardened-spawn.spec.ts',
  'src/main/cli/rtk/__tests__/rtk-tracking-reader.spec.ts',
  'scripts/remote-checks/run-tests-quiet-remote.spec.ts',
  // Undistilled's recipe exists only on a Mac.
  'scripts/remote-checks/harness-remote-check.spec.ts',
  'scripts/remote-checks/remote-run.linux.spec.ts',
  // iPhone work only ever runs on a Mac, and its stand-in test Mac needs PlistBuddy.
  'scripts/remote-ios/remote-ios.darwin.spec.ts',
  // Needs the plan lifecycle guard from James's home folder; a test Mac needs a copy at the same path.
  'src/main/plan-queue/plan-queue-history-landing.spec.ts',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countTests(testResults) {
  const counts = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  for (const suite of testResults) {
    for (const test of suite.assertionResults || []) {
      counts.numTotalTests += 1;
      if (test.status === 'passed') counts.numPassedTests += 1;
      else if (test.status === 'failed') counts.numFailedTests += 1;
      else if (test.status === 'todo') counts.numTodoTests += 1;
      else counts.numPendingTests += 1;
    }
  }
  return counts;
}

/** A run that crashed before reporting has to read as a failure, not as nothing. */
function crashedSuite(root, exitCode) {
  return {
    name: `${root}/${MAC_ONLY_SPECS[0]}`,
    status: 'failed',
    assertionResults: [{
      status: 'failed',
      title: 'Mac-only specs',
      fullName: 'Mac-only specs',
      failureMessages: [`The Mac-only specs exited ${exitCode} without a report. See the log.`],
    }],
  };
}

/** Rewrites `mainPath` with the Mac's results merged in. */
function mergeMacOnlyReport({ mainPath, macPath, root, macExitCode }) {
  const main = readJson(mainPath);
  const mac = readJson(macPath);
  const macSuites = mac?.testResults?.length ? mac.testResults : [crashedSuite(root, macExitCode)];
  const replaced = new Set(macSuites.map(suite => suite.name));
  const testResults = [...main.testResults.filter(suite => !replaced.has(suite.name)), ...macSuites];
  const counts = countTests(testResults);
  fs.writeFileSync(mainPath, JSON.stringify({
    ...main,
    ...counts,
    numFailedTestSuites: testResults.filter(suite => suite.status === 'failed').length,
    success: counts.numFailedTests === 0,
    testResults,
  }));
}

module.exports = { MAC_ONLY_SPECS, mergeMacOnlyReport };
