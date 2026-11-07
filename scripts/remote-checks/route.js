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

/** `{ host, label, sshConfig?, ssh?, queueChecks? }`, or null when remote checks aren't set up. */
function readConfig(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(remoteChecksDir(env), 'config.json'), 'utf8');
  } catch {
    return null;
  }
  const config = JSON.parse(raw);
  if (typeof config.host !== 'string' || !config.host) throw new Error('remote checks config has no host');
  return { label: 'the remote machine', ...config };
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

/** A long list of spec files costs a full run's worth of waiting here: one of 137 files took nearly 14 minutes. */
function isLargeTargetedRun(args) {
  return args.length >= LARGE_TARGETED_SPECS && args.every(arg => SPEC_FILE.test(arg));
}

/**
 * - `local`: exactly what the runner did before remote checks existed.
 * - `remote`: try the far machine first. `specs` is set when it's a named list, not the whole suite.
 * - `mac`: a full run that belongs on the Mac; `turn` says if it waits for the others.
 */
function decideRoute({ args, env = process.env, root, config }) {
  if (env.GITHUB_ACTIONS || !config) return { kind: 'local' };
  const queueCheck = isQueueCheck(root, env);
  if (isLargeTargetedRun(args)) {
    if (env.AIO_REMOTE_CHECKS === 'off' || (queueCheck && !config.queueChecks)) return { kind: 'local' };
    return { kind: 'remote', turn: false, specs: args };
  }
  if (!isPlainFullRun(args)) return { kind: 'local' };
  if (env.AIO_REMOTE_CHECKS === 'off') {
    return { kind: 'mac', turn: !queueCheck, reason: 'AIO_REMOTE_CHECKS=off asked for it' };
  }
  if (queueCheck && !config.queueChecks) {
    return { kind: 'mac', turn: false, reason: 'queue checks stay on the Mac for now' };
  }
  return { kind: 'remote', turn: !queueCheck };
}

/** One line per run. A logging fault must never stop a test run. */
function appendRunLog(entry, env = process.env) {
  try {
    const dir = remoteChecksDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch {
    /* the run matters more than its log */
  }
}

module.exports = { appendRunLog, decideRoute, isLoopRun, isQueueCheck, readConfig, remoteChecksDir };
