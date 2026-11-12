'use strict';
/**
 * Which test Mac takes iPhone work, and whether it can right now. The machine is the first Mac in the remote checks
 * config (scripts/remote-checks/route.js reads it), so the Computers page's pause covers iPhone work too.
 *
 * Whether it answers is remembered for a minute, so a burst of redirected commands pays for one SSH check. When
 * aio-ios finds the test Mac can't do a job, it marks it unusable for ten minutes, so the redirect lets the usual
 * commands run here meanwhile instead of sending the agent back to a command that just failed.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfig } = require('../remote-checks/route');

const ANSWER_KEPT_MS = 60_000;
const UNUSABLE_KEPT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

function remoteIosDir(env = process.env) {
  return env.AIO_REMOTE_IOS_DIR || path.join(os.homedir(), '.ai-orchestrator', 'remote-ios');
}

/** `{ machine }`, or `{ reason }` saying why there is none to use. */
function findTestMac(env = process.env) {
  let config;
  try {
    config = readConfig(env);
  } catch (err) {
    return { reason: `the test machine settings could not be read (${err.message})` };
  }
  if (!config) return { reason: 'no test machines are set up' };
  const machine = config.machines.find(entry => entry.platform === 'darwin');
  if (!machine) return { reason: 'no test Mac is in the test machine list' };
  if (machine.paused) return { reason: `${machine.label} is paused` };
  return { machine };
}

function cacheFile(env) {
  return path.join(remoteIosDir(env), 'test-mac.json');
}

function remember(machine, ok, reason, keptMs, env, now) {
  try {
    fs.mkdirSync(remoteIosDir(env), { recursive: true });
    const file = cacheFile(env);
    fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify({ host: machine.host, ok, reason, until: now + keptMs }));
    fs.renameSync(`${file}.${process.pid}`, file);
  } catch {
    /* only a cache */
  }
}

function recalled(machine, env, now) {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(env), 'utf8'));
    return saved.host === machine.host && now < saved.until ? { ok: saved.ok === true, reason: saved.reason ?? null } : null;
  } catch {
    return null;
  }
}

/** `{ ok, reason }`: one short SSH check, or what the last one or the last job found, while that still counts. */
function probe(machine, { env = process.env, now = Date.now(), run = spawnSync } = {}) {
  const known = recalled(machine, env, now);
  if (known) return known;
  const result = run(machine.ssh || 'ssh', [
    ...(machine.sshConfig ? ['-F', machine.sshConfig] : []),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', machine.host, 'true',
  ], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
  const ok = result.status === 0;
  const reason = ok ? null : `${machine.label} could not be reached`;
  remember(machine, ok, reason, ANSWER_KEPT_MS, env, now);
  return { ok, reason };
}

function markUnusable(machine, reason, { env = process.env, now = Date.now() } = {}) {
  remember(machine, false, reason, UNUSABLE_KEPT_MS, env, now);
}

function markUsable(machine, { env = process.env, now = Date.now() } = {}) {
  remember(machine, true, null, ANSWER_KEPT_MS, env, now);
}

module.exports = { findTestMac, markUnusable, markUsable, probe, remoteIosDir };
