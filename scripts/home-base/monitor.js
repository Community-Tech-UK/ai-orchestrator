#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { initialMonitorState, evaluateMonitorCheck, validateGatewayUrl, validateJobs, acknowledgeAlert,
  validateMonitorState } = require('./monitor-core');

const MAX_BODY_BYTES = 1024 * 1024;

/** Deliberately follows no redirects, and never echoes an untrusted response or transport error. */
function requestJson(url, { token, timeoutMs = 10_000, body } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: encoded ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}) },
    }, response => {
      if (response.statusCode !== 200) {
        finish(new Error(`Gateway request failed (HTTP ${response.statusCode})`));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          finish(new Error('Gateway response was too large'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish(new Error('Gateway response was interrupted')));
      response.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('Gateway response was not JSON')); }
      });
    });
    const timer = setTimeout(() => {
      finish(new Error('Gateway request timed out'));
      request.destroy();
    }, timeoutMs);
    request.on('error', () => finish(new Error('Gateway connection failed')));
    request.end(encoded);
  });
}

function probePeer(peer) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: peer.host, port: peer.port });
    const timer = setTimeout(() => finish(false), 4000);
    let settled = false;
    const finish = reached => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reached);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function assertPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Monitor files must be regular private files');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Monitor files must be accessible only to their owner');
}

function readPrivateJson(file) {
  assertPrivateFile(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('A private monitor file contains invalid JSON'); }
}

function savePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readConfiguration(file) {
  const absolute = path.resolve(file);
  const directory = fs.realpathSync(path.dirname(absolute));
  for (let parent = directory; ; parent = path.dirname(parent)) {
    if (fs.existsSync(path.join(parent, '.git'))) throw new Error('Monitor configuration and token must live outside every checkout');
    if (parent === path.dirname(parent)) break;
  }
  const raw = readPrivateJson(absolute);
  const gatewayUrl = validateGatewayUrl(raw.gatewayUrl);
  if (!raw.peer || !Number.isInteger(raw.peer.port) || raw.peer.port < 1 || raw.peer.port > 65535) {
    throw new Error('Monitor needs the address and open port of another private-network computer');
  }
  const peerUrl = validateGatewayUrl(`http://${net.isIP(raw.peer.host) === 6 ? `[${raw.peer.host}]` : raw.peer.host}:${raw.peer.port}`);
  if (peerUrl.hostname === gatewayUrl.hostname) throw new Error('The independent probe must name a different computer');
  const command = raw.notificationCommand;
  if (command && (typeof command.executable !== 'string' || !path.isAbsolute(command.executable)
    || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string'))) {
    throw new Error('The confirmed mail command needs a full executable path and an argument list');
  }
  return { directory, gatewayUrl, peer: raw.peer, notificationCommand: command };
}

function readDeviceToken(config) {
  const saved = readPrivateJson(path.join(config.directory, 'device-token.json'));
  if (typeof saved.token !== 'string' || !saved.token || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
    throw new Error('Monitor pairing has expired or is invalid');
  }
  return saved.token;
}

function notify(command, alert) {
  if (!command) return Promise.reject(new Error('No confirmed PC mail command is configured'));
  return new Promise((resolve, reject) => {
    const child = execFile(command.executable, command.args, { timeout: 20_000, maxBuffer: 64 * 1024,
      windowsHide: true, encoding: 'utf8' }, error => error ? reject(new Error('The mail command did not confirm delivery')) : resolve());
    // Child output is never logged: a configured sender may print its own credentials on failure.
    child.stdin.on('error', () => { /* the execFile callback owns a failed sender */ });
    child.stdin.end(JSON.stringify(alert));
  });
}

function acquireLock(directory) {
  const file = path.join(directory, 'monitor.lock');
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = readPrivateJson(file);
    if (!Number.isSafeInteger(saved.pid) || saved.pid <= 0) throw new Error('The monitor lock is invalid; inspect it before continuing');
    let alive = true;
    try { process.kill(saved.pid, 0); }
    catch (probeError) { if (probeError.code === 'ESRCH') alive = false; else throw new Error('The previous monitor process could not be checked'); }
    if (alive) throw new Error('A previous monitor check is still running');
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  }
  return () => fs.unlinkSync(file);
}

async function runMonitorCheck(file, deps = {}) {
  const config = readConfiguration(file);
  const release = acquireLock(config.directory);
  try {
    const statePath = path.join(config.directory, 'monitor-state.json');
    let state = fs.existsSync(statePath) ? validateMonitorState(readPrivateJson(statePath)) : initialMonitorState();
    const observations = await Promise.allSettled([
      (deps.fetchJobs ?? (async () => requestJson(new URL('/api/automations', config.gatewayUrl), { token: readDeviceToken(config) })))(),
      (deps.probePeer ?? (() => probePeer(config.peer)))(),
    ]);
    let jobs;
    if (observations[0].status === 'fulfilled') {
      try { jobs = validateJobs(observations[0].value); }
      catch { /* A wrong or older authenticated answer counts as a failed check. */ }
    }
    const peerReachable = observations[1].status === 'fulfilled' && observations[1].value === true;
    state = evaluateMonitorCheck(state, { jobs, peerReachable }, (deps.now ?? Date.now)());
    savePrivateJson(statePath, state);
    let notified = 0;
    let deliveryFailed = false;
    // One queued message per invocation keeps the scheduled check bounded even after a mail outage.
    if (state.outbox.length) {
      try {
        await (deps.notify ?? (alert => notify(config.notificationCommand, alert)))(state.outbox[0]);
        const acknowledged = acknowledgeAlert(state, state.outbox[0].id);
        savePrivateJson(statePath, acknowledged);
        state = acknowledged;
        notified = 1;
      } catch { deliveryFailed = true; /* Keep the durable outbox intact; never echo sender errors. */ }
    }
    return { pending: state.outbox.length, notified, deliveryFailed, gatewayReachable: jobs !== undefined };
  } finally { release(); }
}

async function pair(file) {
  const config = readConfiguration(file);
  let code = '';
  for await (const chunk of process.stdin) {
    code += chunk.toString();
    if (code.length > 1000) throw new Error('Pairing input was too long');
  }
  if (!code.trim()) throw new Error('Enter the home-base pairing code through stdin');
  const result = await requestJson(new URL('/pair', config.gatewayUrl), {
    body: { pairingToken: code.trim(), label: 'Home-base monitor' },
  });
  code = '';
  if (!result || typeof result.token !== 'string' || !result.token || !Number.isFinite(result.expiresAt)) {
    throw new Error('Home-base pairing did not return a device token');
  }
  savePrivateJson(path.join(config.directory, 'device-token.json'), { token: result.token, expiresAt: result.expiresAt });
}

async function main() {
  const [action, flag, file, ...extra] = process.argv.slice(2);
  if (!['pair', 'check', 'validate'].includes(action) || flag !== '--config' || !file || extra.length) {
    throw new Error('Usage: monitor.js pair|check|validate --config <private-monitor.json>');
  }
  if (action === 'pair') { await pair(file); process.stdout.write('Monitor paired. Its token is in the private monitor folder.\n'); }
  else if (action === 'validate') {
    const config = readConfiguration(file);
    if (!config.notificationCommand) throw new Error('Configure and prove the PC mail command before enabling the monitor');
    readDeviceToken(config);
    process.stdout.write('Monitor configuration and pairing are valid. Live connectivity and email still need checking.\n');
  } else {
    const result = await runMonitorCheck(file);
    if (result.deliveryFailed) {
      process.stderr.write('A monitor alert is still queued. Check its mail route and saved state.\n');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('The home-base monitor could not run. Check its private configuration, pairing, saved state and task history.\n');
  process.exitCode = 1;
});

module.exports = { requestJson, runMonitorCheck, readConfiguration, probePeer };
