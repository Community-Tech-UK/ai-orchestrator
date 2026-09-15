#!/usr/bin/env node
// Keep all runner output locally; only failures and one verdict reach the caller.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mobile = path.resolve(__dirname, '..');
const scratch = path.resolve(mobile, '../../_scratch/mobile-design-verification');
fs.mkdirSync(scratch, { recursive: true });
const log = path.join(scratch, `mobile-tests-${process.pid}.log`);
const reportPath = path.join(scratch, `mobile-tests-${process.pid}.json`);
const fd = fs.openSync(log, 'w');
const result = spawnSync(process.execPath, [
  require.resolve('vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts',
  ...process.argv.slice(2), '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
], { cwd: mobile, stdio: ['ignore', fd, fd] });
fs.closeSync(fd);
let report;
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* Runner failure below. */ }
if (result.status === 0 && report?.success && report.numFailedTests === 0) {
  console.log(`PASS: ${report.numPassedTests} tests; log: ${log}`);
  process.exit(0);
}
let reported = false;
for (const suite of report?.testResults ?? []) {
  for (const test of suite.assertionResults ?? []) {
    if (test.status !== 'failed') continue;
    reported = true;
    console.error(`${suite.name} > ${test.fullName}\n${(test.failureMessages ?? []).join('\n')}`);
  }
  if (suite.status === 'failed' && suite.message) {
    reported = true;
    console.error(`${suite.name}\n${suite.message}`);
  }
}
if (!reported) console.error(result.error?.message ?? fs.readFileSync(log, 'utf8').split('\n').slice(-60).join('\n'));
const status = result.status || 1;
console.error(`FAIL: exit ${status}; log: ${log}`);
process.exit(status);
