#!/usr/bin/env node
'use strict';
/**
 * The commit hook's route to the test machine, for a change that reaches a lot of tests.
 * It reads the staged source files as a JSON list on stdin, and tests exactly what is staged.
 *
 * Exits with the tests' own code, or STAY_ON_THE_MAC when the tests belong here or the far
 * machine can't produce a valid result. scripts/test-staged.js then runs them on the Mac as
 * it always has, so a commit is never blocked by the machine being away.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MAC_ONLY_SPECS } = require('./mac-only');
const { estimateRelatedSpecs } = require('./related-estimate');
const { appendRunLog, decideRoute, isLoopRun, readConfig } = require('./route');
const { runOnRemote } = require('./run-remote');
const { takeStagedSnapshot } = require('./snapshot');

const ROOT = path.resolve(__dirname, '..', '..');
const STAY_ON_THE_MAC = 75;
/** About where a run here starts to cost more than the far machine's set-up, which takes about a minute. */
const LARGE_RELATED_SPECS = 50;
const MAX_FAILURES_SHOWN = 20;
const MAX_MESSAGE_CHARS = 1200;
const PROGRESS_INTERVAL_MS = 60_000;

const log = line => process.stdout.write(`test-staged: ${line}\n`);

function readReport(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function printFailures(report, logPath) {
  const failed = (report.testResults ?? []).flatMap(suite => (suite.assertionResults ?? [])
    .filter(test => test.status === 'failed')
    .map(test => ({ file: path.relative(ROOT, suite.name), title: test.fullName || test.title, message: test.failureMessages?.[0] ?? '' })));
  for (const { file, title, message } of failed.slice(0, MAX_FAILURES_SHOWN)) {
    process.stdout.write(`  ✗ ${file} › ${title}\n    ${message.slice(0, MAX_MESSAGE_CHARS).trim()}\n\n`);
  }
  if (failed.length > MAX_FAILURES_SHOWN) process.stdout.write(`  …and ${failed.length - MAX_FAILURES_SHOWN} more\n`);
  if (!failed.length) process.stdout.write(`${fs.readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n')}\n`);
  log(`full log: ${path.relative(ROOT, logPath)}`);
}

/** The far machine ran these too, but they only prove anything here. */
function runMacOnlySpecs(report) {
  const ran = new Set((report.testResults ?? []).map(suite => path.relative(ROOT, suite.name)));
  const specs = MAC_ONLY_SPECS.filter(spec => ran.has(spec));
  if (!specs.length) return 0;
  log(`running ${specs.length} spec file(s) that only work on the Mac`);
  const packageFile = require.resolve('vitest/package.json', { paths: [ROOT] });
  const vitest = path.resolve(path.dirname(packageFile), JSON.parse(fs.readFileSync(packageFile, 'utf8')).bin.vitest);
  const result = spawnSync(process.execPath, [vitest, 'run', ...specs], { cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

function fellBack(started, reason) {
  log(`running on the Mac because ${reason}`);
  appendRunLog({
    at: new Date(started).toISOString(), project: path.basename(ROOT), kind: 'commit', loop: isLoopRun(), fingerprint: null,
    ranOn: 'mac', waitedMs: 0, tookMs: Date.now() - started, exitCode: null, fellBackBecause: reason,
  });
  return STAY_ON_THE_MAC;
}

async function main() {
  const config = readConfig();
  const route = decideRoute({ args: [], root: ROOT, config });
  if (route.kind !== 'remote') return STAY_ON_THE_MAC;

  const files = JSON.parse(fs.readFileSync(0, 'utf8'));
  const specs = estimateRelatedSpecs(ROOT, files);
  if (specs < LARGE_RELATED_SPECS) return STAY_ON_THE_MAC;

  const started = Date.now();
  const scratch = path.join(ROOT, '_scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const logPath = path.join(scratch, `test-staged.pid-${process.pid}.log`);
  const jsonPath = path.join(scratch, `test-staged-results.pid-${process.pid}.json`);

  log(`about ${specs} spec files are related, so testing what is staged on ${config.label}`);
  const progress = setInterval(() => log(`still running on ${config.label} (full log: ${path.relative(ROOT, logPath)})`), PROGRESS_INTERVAL_MS);
  let remote;
  try {
    remote = await runOnRemote({
      config, root: ROOT, logPath, jsonPath, noCache: false, ci: process.env.CI, take: takeStagedSnapshot, relatedTo: files,
    });
  } finally {
    // With exitCode rather than exit(), a timer left running would hold the commit open.
    clearInterval(progress);
  }
  if (!remote.ok) return fellBack(started, remote.reason);

  const report = readReport(jsonPath);
  const macExit = runMacOnlySpecs(report);
  const failedAnywhere = remote.exitCode || report.numFailedTests || macExit;
  // Tests that fail must never read as "the machine was away", which would run them all again here.
  const exitCode = !failedAnywhere ? 0 : (remote.exitCode !== STAY_ON_THE_MAC && remote.exitCode) || 1;
  const took = Math.round((Date.now() - started) / 1000);
  appendRunLog({
    at: new Date(started).toISOString(), project: path.basename(ROOT), kind: 'commit', loop: isLoopRun(), fingerprint: remote.fingerprint,
    ranOn: config.host, waitedMs: remote.waitedMs, tookMs: Date.now() - started, exitCode, fellBackBecause: null,
  });
  if (remote.exitCode || report.numFailedTests) printFailures(report, logPath);
  // About 14 MB a run, for a commit that needs neither once it has passed.
  else for (const file of [logPath, jsonPath]) fs.rmSync(file, { force: true });
  log(`${report.numPassedTests ?? 0} of ${report.numTotalTests} tests passed. Ran on ${config.label} in ${took}s.`);
  if (macExit) log('the specs that only work on the Mac failed, so this commit is stopped (their output is above)');
  return exitCode;
}

// exitCode, not exit(): a run's failures can be longer than a pipe holds, and exit() would cut them off.
main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    // Nothing above has judged the code by now, so the tests still have to run.
    log(`running on the Mac because the far machine's route failed: ${err.message}`);
    process.exitCode = STAY_ON_THE_MAC;
  },
);
