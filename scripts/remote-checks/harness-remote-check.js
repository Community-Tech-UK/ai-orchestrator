#!/usr/bin/env node
'use strict';
/**
 * Runs another project's full test suite on the test machine, for that project's own quiet
 * test runner to call first. Run it from the folder the suite lives in.
 *
 * Exits with the tests' own code, or STAY_HERE when the run belongs on this machine: a
 * repository that isn't listed in projects.js, remote checks being off, or the far machine
 * not producing a valid result. The caller then runs its tests as it always has.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findProject } = require('./projects');
const { appendRunLog, decideRoute, isLoopRun, machinesFor, readConfig } = require('./route');
const { runOnMachines } = require('./run-remote');
const { takeSnapshot } = require('./snapshot');

const STAY_HERE = 75;
/** remote-run.sh prints this between what a person would read and the full log. */
const FULL_LOG_MARK = '[remote checks] full log follows\n';
const PROGRESS_INTERVAL_MS = 60_000;

const say = line => process.stderr.write(`test machine: ${line}\n`);

function fellBack(project, started, reason, logPath) {
  say(`running here because ${reason}${fs.existsSync(logPath) ? `. What it printed: ${logPath}` : ''}`);
  appendRunLog({
    at: new Date(started).toISOString(), project: project.id, kind: 'project', loop: isLoopRun(), fingerprint: null,
    ranOn: 'mac', waitedMs: 0, tookMs: Date.now() - started, exitCode: null, fellBackBecause: reason,
  });
  return STAY_HERE;
}

async function main() {
  const project = findProject(process.cwd());
  if (!project) return STAY_HERE;
  const config = readConfig();
  const route = decideRoute({ args: [], root: project.root, config });
  if (route.kind !== 'remote') return STAY_HERE;

  const started = Date.now();
  const scratch = path.resolve('_scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const logPath = path.join(scratch, `test-machine.pid-${process.pid}.log`);
  const machines = machinesFor(config, 'testRuns');
  const progress = setInterval(() => say('still running elsewhere'), PROGRESS_INTERVAL_MS);
  let remote;
  try {
    say(`running on ${machines[0].label}`);
    remote = await runOnMachines(machines, {
      root: project.root, logPath, noCache: false, ci: process.env.CI, project,
      take: root => takeSnapshot(root, { folders: project.sends }),
    });
  } finally {
    clearInterval(progress);
  }
  if (!remote.ok) return fellBack(project, started, remote.reason, logPath);

  // What the project's runner printed, then its full log, with the far machine's paths in both.
  const output = fs.readFileSync(logPath, 'utf8').split(remote.farRoot).join(project.root);
  fs.writeFileSync(logPath, output);
  process.stdout.write(output.split(FULL_LOG_MARK)[0]);

  const macExit = spawnSync(process.execPath, project.macOnly, { stdio: 'inherit' }).status ?? 1;
  const failed = remote.exitCode || macExit;
  const exitCode = !failed ? 0 : (remote.exitCode !== STAY_HERE && remote.exitCode) || 1;
  appendRunLog({
    at: new Date(started).toISOString(), project: project.id, kind: 'project', loop: isLoopRun(), fingerprint: remote.fingerprint,
    ranOn: remote.machine.host, waitedMs: remote.waitedMs, tookMs: Date.now() - started, exitCode, fellBackBecause: null,
  });
  const took = `Ran on ${remote.machine.label} in ${Math.round((Date.now() - started) / 1000)}s`;
  if (exitCode === 0) {
    fs.rmSync(logPath, { force: true });
    say(`passed: ${remote.tests} tests. ${took}, and the Mac-only tests here.`);
  } else {
    // Last, because the Mac-only run's own summary above can read as a pass.
    say(`FAILED: ${remote.exitCode ? `tests failed on ${remote.machine.label}` : 'the Mac-only tests failed'}. ${took}. Its full log: ${logPath}`);
  }
  return exitCode;
}

// exitCode, not exit(): a run's failures can be longer than a pipe holds, and exit() would cut them off.
main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    // Nothing has judged the code by now, so the tests still have to run.
    say(`running here because the route failed: ${err.message}`);
    process.exitCode = STAY_HERE;
  },
);
