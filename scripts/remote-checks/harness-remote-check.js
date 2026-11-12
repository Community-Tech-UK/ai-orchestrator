#!/usr/bin/env node
'use strict';
/**
 * Runs another project's test suite on the test machine, for that project's own quiet
 * test runner to call first. Run it from the folder the suite lives in:
 *
 *   node ~/.ai-orchestrator/remote-checks/harness-remote-check.js [file or argument...]
 *
 * Exits with the tests' own code, or STAY_HERE when the run belongs on this machine: a
 * repository that isn't listed in projects.js, remote checks being off, or the far machine
 * not producing a valid result. The caller then runs its tests as it always has.
 *
 * Arguments (named files, relative to the suite's folder, or the runner's own options) go to the
 * test machine only when this Mac is switched off in the config; otherwise a run with arguments
 * stays here, as it always has. With this Mac switched off nothing runs here but the suite's
 * Mac-only tests: when no test machine takes the run it prints `Not run: <reason>` and exits
 * NOT_RUN (69), and the caller must exit 69 too, without running anything.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findProject } = require('./projects');
const { NOT_RUN, appendRunLog, decideRoute, isLoopRun, machinesFor, readConfig, relativeToRoot } = require('./route');
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

function notRun(project, started, reason) {
  process.stdout.write(`Not run: ${reason}.\n`);
  appendRunLog({
    at: new Date(started).toISOString(), project: project.id, kind: 'project', loop: isLoopRun(), fingerprint: null,
    ranOn: 'none', waitedMs: 0, tookMs: Date.now() - started, exitCode: NOT_RUN, fellBackBecause: null, notRunBecause: reason,
  });
  return NOT_RUN;
}

/** The suite runners' own rule: anything shaped like a path or a pattern, or a path that exists, names files. */
function namesFiles(arg) {
  return !arg.startsWith('-') && (/[*?[{/]|\.[cm]?[jt]s$/.test(arg) || fs.existsSync(arg));
}

/**
 * The suite's Mac-only files a run with arguments reaches: those named, those in a folder or pattern named, and all of
 * them when it names no files, since the runner then uses its own list. The far machine leaves them all out.
 */
function macOnlyReached(args, macOnlyFiles) {
  const named = args.filter(namesFiles);
  if (!named.length) return macOnlyFiles;
  return macOnlyFiles.filter(file => named.some((arg) => {
    const folder = arg.replace(/\/+$/, '');
    if (file === arg || folder === '.' || file.startsWith(`${folder}/`)) return true;
    return /[*?[{]/.test(arg) && Boolean(path.matchesGlob?.(file, arg));
  }));
}

/** Set once the config is read: whether a fault ends as not run rather than a run here. */
let thisMacOff = false;

async function main() {
  const project = findProject(process.cwd());
  if (!project) return STAY_HERE;
  const config = readConfig();
  thisMacOff = config?.useThisMac === false;
  // Relative to the suite's folder, where the caller's runner reads them.
  const args = relativeToRoot(process.argv.slice(2), process.cwd());
  // Before the switch, a run with arguments always stayed here.
  if (args.length && !thisMacOff) return STAY_HERE;
  const macOnlyFiles = project.macOnly?.slice(1) ?? [];
  const namedFiles = args.filter(namesFiles);
  // Only Mac-only files named, with or without options: they run here, as they would after a run elsewhere.
  if (namedFiles.length && namedFiles.every(arg => macOnlyFiles.includes(arg))) return STAY_HERE;
  const farArgs = args.filter(arg => !macOnlyFiles.includes(arg));
  const route = decideRoute({ args: farArgs, root: project.root, config });
  const started = Date.now();
  if (route.kind === 'not-run') return notRun(project, started, route.reason);
  if (route.kind !== 'remote') return STAY_HERE;

  const scratch = path.resolve('_scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const logPath = path.join(scratch, `test-machine.pid-${process.pid}.log`);
  const machines = machinesFor(config, 'testRuns').filter(machine => !project.needsMac || machine.platform === 'darwin');
  if (!machines.length && thisMacOff) return notRun(project, started, 'no test machine taking test runs is a Mac, and this Mac is switched off');
  if (!machines.length) return fellBack(project, started, 'no test machine taking test runs is a Mac', logPath);
  const progress = setInterval(() => say('still running elsewhere'), PROGRESS_INTERVAL_MS);
  let remote;
  try {
    say(`running on ${machines.length === 1 ? machines[0].label : 'your test machines'}`);
    remote = await runOnMachines(machines, {
      root: project.root, logPath, noCache: false, ci: process.env.CI, project,
      take: root => takeSnapshot(root, { folders: project.sends }),
      ...(thisMacOff ? { patient: true, small: farArgs.length > 0 } : {}),
      ...(farArgs.length ? { argv: farArgs } : {}),
    });
  } finally {
    clearInterval(progress);
  }
  if (!remote.ok && thisMacOff) {
    fs.rmSync(logPath, { force: true });
    return notRun(project, started, remote.notRun ? remote.reason : `${remote.reason}, and this Mac is switched off`);
  }
  if (!remote.ok) return fellBack(project, started, remote.reason, logPath);

  // What the project's runner printed, then its full log, with the far machine's paths in both.
  const output = fs.readFileSync(logPath, 'utf8').split(remote.farRoot).join(project.root);
  fs.writeFileSync(logPath, output);
  process.stdout.write(output.split(FULL_LOG_MARK)[0]);

  // A recipe leaves its Mac-only tests out wherever it runs, so they run here; a suite may have none. A run with
  // arguments runs the Mac-only ones it reaches, with its options.
  const reached = args.length ? macOnlyReached(args, macOnlyFiles) : [];
  const macOnly = !project.macOnly ? null
    : !args.length ? project.macOnly
      : reached.length ? [project.macOnly[0], ...args.filter(arg => !namesFiles(arg)), ...reached] : null;
  const macExit = macOnly ? spawnSync(process.execPath, macOnly, { stdio: 'inherit' }).status ?? 1 : 0;
  const failed = remote.exitCode || macExit;
  const exitCode = !failed ? 0 : (remote.exitCode !== STAY_HERE && remote.exitCode !== NOT_RUN && remote.exitCode) || 1;
  appendRunLog({
    at: new Date(started).toISOString(), project: project.id, kind: 'project', loop: isLoopRun(), fingerprint: remote.fingerprint,
    ranOn: remote.machine.host, waitedMs: remote.waitedMs, tookMs: Date.now() - started, exitCode, fellBackBecause: null,
  });
  const took = `Ran on ${remote.machine.label} in ${Math.round((Date.now() - started) / 1000)}s`;
  if (exitCode === 0) {
    fs.rmSync(logPath, { force: true });
    say(`passed: ${remote.tests} tests. ${took}${macOnly ? ', and the Mac-only tests here' : ''}.`);
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
    if (thisMacOff) {
      process.stdout.write(`Not run: the route failed (${err.message}), and this Mac is switched off.\n`);
      process.exitCode = NOT_RUN;
      return;
    }
    // Nothing has judged the code by now, so the tests still have to run.
    say(`running here because the route failed: ${err.message}`);
    process.exitCode = STAY_HERE;
  },
);
