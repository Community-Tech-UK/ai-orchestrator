'use strict';
/**
 * Decides where a test run goes, and keeps the Mac's own run log. The config file is
 * what turns this on: with none, every run behaves as it always has.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LARGE_TARGETED_SPECS = 50;
const SPEC_FILE = /^[^-].*\.(?:spec|test)\.[cm]?[jt]sx?$/;

function remoteChecksDir(env = process.env) {
  return env.AIO_REMOTE_CHECKS_DIR || path.join(os.homedir(), '.ai-orchestrator', 'remote-checks');
}

const DEFAULT_SLOTS = 3;
const MAX_SLOTS = 8;

/**
 * One test machine: `{ host, label, sshConfig?, ssh?, nodeName?, platform, paused, testRuns, checks, slots }`. It takes
 * test runs and checks unless they're turned off, and runs `slots` at once. Harness's Computers page changes `paused`,
 * `testRuns`, `checks` and `slots`; `nodeName` names the paired computer it is part of; `platform` is `darwin` for a Mac.
 */
function readMachine(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.host !== 'string' || !entry.host) {
    throw new Error('remote checks config has a machine with no host');
  }
  const slots = Number.isInteger(entry.slots) && entry.slots >= 1 && entry.slots <= MAX_SLOTS ? entry.slots : DEFAULT_SLOTS;
  return {
    host: entry.host,
    label: typeof entry.label === 'string' && entry.label ? entry.label : 'the remote machine',
    ...(typeof entry.sshConfig === 'string' ? { sshConfig: entry.sshConfig } : {}),
    ...(typeof entry.ssh === 'string' ? { ssh: entry.ssh } : {}),
    ...(typeof entry.nodeName === 'string' && entry.nodeName ? { nodeName: entry.nodeName } : {}),
    platform: entry.platform === 'darwin' ? 'darwin' : 'linux',
    paused: entry.paused === true,
    testRuns: entry.testRuns !== false,
    checks: entry.checks !== false,
    slots,
  };
}

/**
 * `{ queueChecks, machines }`, the machines in the order to try them, or null when remote checks aren't set up. The first
 * machine is the file's top level, where copies of these scripts from before the list still find it; the rest follow in
 * `moreMachines`.
 */
function readConfig(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(remoteChecksDir(env), 'config.json'), 'utf8');
  } catch {
    return null;
  }
  const config = JSON.parse(raw);
  const listed = [config, ...(Array.isArray(config.moreMachines) ? config.moreMachines : [])];
  return { queueChecks: config.queueChecks === true, machines: listed.map(readMachine) };
}

/** The machines that take this kind of work now, in order. `work` is `testRuns` or `checks`. */
function machinesFor(config, work) {
  return config.machines.filter(machine => !machine.paused && machine[work]);
}

/** Why this kind of work stays here by choice: every machine is paused or has it turned off. Null when one takes it. */
function stayReason(config, work) {
  if (machinesFor(config, work).length) return null;
  return config.machines.map(machine => (machine.paused
    ? `${machine.label} is paused`
    : `${work === 'testRuns' ? 'test runs' : 'checks'} are turned off for ${machine.label}`)).join(' and ');
}

/** Harness's own check, in a folder queue sessions share. Those sessions carry AIO_QUEUE_SESSION. */
function isQueueCheck(root, env = process.env) {
  if (env.AIO_QUEUE_SESSION) return false;
  return /[\\/]\.worktrees[\\/](?:queue[\\/]|base-gate-checks-|combined-gate-checks-)/.test(`${root}${path.sep}`);
}

/**
 * A loop's agent carries the control file. The loop's own verify step doesn't, but Harness
 * sets CI=1 on it, and anything really on CI never gets this far.
 */
function isLoopRun(env = process.env) {
  return Boolean(env.ORCHESTRATOR_LOOP_CONTROL_FILE || env.CI);
}

function isPlainFullRun(args) {
  return args.every(arg => arg === '--no-cache');
}

function countSpecFiles(args) {
  return args.filter(arg => SPEC_FILE.test(arg)).length;
}

/** A long list of spec files costs a full run's worth of waiting here: one of 137 files took nearly 14 minutes. */
function isLargeTargetedRun(args) {
  return args.length >= LARGE_TARGETED_SPECS && countSpecFiles(args) === args.length;
}

/**
 * - `local`: exactly what the runner did before remote checks existed.
 * - `remote`: try the far machine first. `specs` is set when it's a named list, not the whole suite.
 * - `mac`: a full run that belongs on the Mac; `turn` says if it waits for the others.
 */
function decideRoute({ args, env = process.env, root, config }) {
  if (env.GITHUB_ACTIONS || !config) return { kind: 'local' };
  const queueCheck = isQueueCheck(root, env);
  const chosenHere = stayReason(config, 'testRuns');
  if (isLargeTargetedRun(args)) {
    if (env.AIO_REMOTE_CHECKS === 'off' || chosenHere || (queueCheck && !config.queueChecks)) return { kind: 'local' };
    return { kind: 'remote', turn: false, specs: args };
  }
  if (!isPlainFullRun(args)) return { kind: 'local' };
  if (env.AIO_REMOTE_CHECKS === 'off') {
    return { kind: 'mac', turn: !queueCheck, reason: 'AIO_REMOTE_CHECKS=off asked for it' };
  }
  if (chosenHere) return { kind: 'mac', turn: !queueCheck, reason: chosenHere };
  if (queueCheck && !config.queueChecks) {
    return { kind: 'mac', turn: false, reason: 'queue checks stay on the Mac for now' };
  }
  return { kind: 'remote', turn: !queueCheck };
}

/** Readers parse the whole log each time, so past this it starts again, keeping the one before as runs.old.jsonl. */
const RUN_LOG_LIMIT_BYTES = 1_000_000;

/** One line per run. A logging fault must never stop a test run. */
function appendRunLog(entry, env = process.env) {
  try {
    const dir = remoteChecksDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'runs.jsonl');
    const older = path.join(dir, 'runs.old.jsonl');
    try {
      // Two runs logging at once could both see a full log; the second would move the first's fresh file over the
      // history. A log started in the last minute is never moved again.
      const justStarted = fs.existsSync(older) && Date.now() - fs.statSync(older).mtimeMs < 60_000;
      if (!justStarted && fs.statSync(file).size > RUN_LOG_LIMIT_BYTES) {
        fs.renameSync(file, older);
        // A rename keeps the file's old time, which says nothing about when it moved.
        const now = new Date();
        fs.utimesSync(older, now, now);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* the run matters more than its log */
  }
}

module.exports = {
  appendRunLog, countSpecFiles, decideRoute, isLoopRun, isQueueCheck, machinesFor, readConfig, remoteChecksDir, stayReason,
};
