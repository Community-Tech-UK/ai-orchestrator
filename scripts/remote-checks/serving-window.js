#!/usr/bin/env node
'use strict';
/**
 * The serving window for the plan/execute benchmark's frozen native llama-server on the Windows PC (check A2 of
 * docs/plans/2026-10-14-local-model-plan-execute-ab_plan_livetest.md). exec_on_node only runs curl and literal-text
 * PowerShell, so a node agent (run_on_node) or a person runs this file with the PC's own Node instead:
 *
 *   node serving-window.js inventory <config.json>   read-only: helper models, GPU memory, listeners; changes nothing
 *   node serving-window.js start <config.json>       snapshot and unload the LM Studio helper models, start the frozen
 *                                                    server, prove its listeners and the 401/401/200 key responses.
 *                                                    Any failure stops the owned server and reloads the helpers.
 *   node serving-window.js status <config.json>      what the ownership record says and whether it is still true
 *   node serving-window.js stop <config.json>        stop the owned server, reload the helpers, read them back.
 *                                                    Safe to repeat; also the recovery after an interrupted start.
 *
 * It never prints the key, never takes a key on a command line, and never kills a process it did not start (the
 * record carries the executable and creation time, both of which must still match). The coordinator-side pause of
 * Harness's helper routing (auxiliaryLlmRoutingMode) is a Harness setting, not this file's business.
 * Exit 0 = ok, 1 = failed (after cleanup), 2 = refused (nothing changed). One redacted JSON receipt goes to stdout and
 * to <windowDir>\receipt-<command>.json.
 */

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const RECORD = 'serving-window.json';
const FROZEN_BACKEND_VERSION = '2.60.0';
const LM_STUDIO_PORT = 1234;
const WRONG_KEY = 'intentionally-invalid-placeholder';
const DEFAULTS = {
  backendVersion: FROZEN_BACKEND_VERSION,
  ctxSize: 65536,
  parallel: 1,
  batchSize: 4096,
  ubatchSize: 4096,
  threads: 12,
  cpuMoe: false,
  // The RTX 5090 also drives the PC's screen: everyday desktop apps hold about 3.3 GB with every model unloaded.
  maxGpuUsedMiB: 4096,
  lms: 'lms',
  startTimeoutMs: 900_000,
  removeKeyOnStop: false,
};

class Refused extends Error {}

const win = path.win32;

function requireString(config, name) {
  if (typeof config[name] !== 'string' || config[name].trim() === '') throw new Refused(`config.${name} must be a non-empty string`);
  return config[name];
}

function requireInt(config, name, min, max) {
  const value = config[name] === undefined ? DEFAULTS[name] : config[name];
  if (!Number.isInteger(value) || value < min || value > max) throw new Refused(`config.${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function requireAbsolute(value, name) {
  if (!win.isAbsolute(value)) throw new Refused(`config.${name} must be an absolute Windows path`);
  return value;
}

/** Tailscale only: 100.64.0.0/10 (CGNAT) or the tailnet's fd7a:115c:a1e0::/48. Never a wildcard, LAN or loopback address. */
function isTailscaleAddress(host) {
  if (typeof host !== 'string') return false;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (net.isIPv6(host)) return expandIpv6(host).startsWith('fd7a:115c:a1e0:');
  return false;
}

function expandIpv6(host) {
  const [head, tail = ''] = host.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const middle = host.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...middle, ...right].map((group) => group.padStart(4, '0')).join(':').replace(/(^|:)0+(?=[0-9a-f])/g, '$1');
}

function sameAddress(a, b) {
  const norm = (value) => (net.isIPv6(value) ? expandIpv6(value) : value);
  return typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
}

/** Checks a raw config object and returns the settings with defaults filled in. Nothing is touched on the machine. */
function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Refused('the config must be a JSON object');
  const known = new Set([
    'windowDir', 'backendDir', 'backendVersion', 'vendorDir', 'modelFile', 'keyFile', 'expectedKeySha256', 'host', 'port',
    'ctxSize', 'parallel', 'batchSize', 'ubatchSize', 'threads', 'cpuMoe', 'maxGpuUsedMiB', 'lms', 'startTimeoutMs',
    'removeKeyOnStop',
  ]);
  for (const name of Object.keys(raw)) if (!known.has(name)) throw new Refused(`config.${name} is not a setting`);

  const windowDir = requireAbsolute(requireString(raw, 'windowDir'), 'windowDir');
  if (!/^plan-ex-ab-[A-Za-z0-9._-]+$/.test(win.basename(windowDir))) {
    throw new Refused('config.windowDir must be a folder named plan-ex-ab-<label>, so only an owned folder is ever used');
  }
  const backendVersion = raw.backendVersion === undefined ? DEFAULTS.backendVersion : raw.backendVersion;
  if (backendVersion !== FROZEN_BACKEND_VERSION) throw new Refused(`only the frozen backend ${FROZEN_BACKEND_VERSION} may be served`);
  const backendDir = requireAbsolute(requireString(raw, 'backendDir'), 'backendDir');
  if (!win.basename(backendDir).endsWith(`-${backendVersion}`)) throw new Refused(`config.backendDir must end in -${backendVersion}`);
  const modelFile = requireAbsolute(requireString(raw, 'modelFile'), 'modelFile');
  if (!modelFile.toLowerCase().endsWith('.gguf')) throw new Refused('config.modelFile must be a .gguf file');
  const keyFile = requireAbsolute(requireString(raw, 'keyFile'), 'keyFile');
  if (raw.expectedKeySha256 !== undefined && !/^[0-9a-f]{64}$/.test(raw.expectedKeySha256)) {
    throw new Refused('config.expectedKeySha256 must be 64 lowercase hex characters');
  }
  const host = requireString(raw, 'host');
  if (!isTailscaleAddress(host)) throw new Refused('config.host must be a Tailscale address, never a wildcard, LAN or loopback address');
  const port = requireInt({ port: raw.port === undefined ? 1235 : raw.port }, 'port', 1024, 65535);
  if (port === LM_STUDIO_PORT) throw new Refused(`config.port must not be LM Studio's ${LM_STUDIO_PORT}`);
  if (raw.cpuMoe !== undefined && typeof raw.cpuMoe !== 'boolean') throw new Refused('config.cpuMoe must be true or false');
  if (raw.removeKeyOnStop !== undefined && typeof raw.removeKeyOnStop !== 'boolean') throw new Refused('config.removeKeyOnStop must be true or false');
  if (raw.vendorDir !== undefined) requireAbsolute(requireString(raw, 'vendorDir'), 'vendorDir');
  return {
    windowDir, backendDir, backendVersion, vendorDir: raw.vendorDir, modelFile, keyFile, expectedKeySha256: raw.expectedKeySha256,
    host, port,
    ctxSize: requireInt(raw, 'ctxSize', 1024, 4_194_304),
    parallel: requireInt(raw, 'parallel', 1, 64),
    batchSize: requireInt(raw, 'batchSize', 1, 65536),
    ubatchSize: requireInt(raw, 'ubatchSize', 1, 65536),
    threads: requireInt(raw, 'threads', 1, 512),
    cpuMoe: raw.cpuMoe === undefined ? DEFAULTS.cpuMoe : raw.cpuMoe,
    maxGpuUsedMiB: requireInt(raw, 'maxGpuUsedMiB', 0, 1_000_000),
    lms: raw.lms === undefined ? DEFAULTS.lms : requireString(raw, 'lms'),
    startTimeoutMs: requireInt(raw, 'startTimeoutMs', 1000, 3_600_000),
    removeKeyOnStop: raw.removeKeyOnStop === undefined ? DEFAULTS.removeKeyOnStop : raw.removeKeyOnStop,
  };
}

function serverArgs(config) {
  const args = [
    '--model', config.modelFile,
    '--n-gpu-layers', '999', '--flash-attn', 'on', '--kv-offload',
    '--ctx-size', String(config.ctxSize), '--parallel', String(config.parallel),
    '--batch-size', String(config.batchSize), '--ubatch-size', String(config.ubatchSize),
    '--threads', String(config.threads), '--threads-batch', String(config.threads),
    '--host', config.host, '--port', String(config.port),
    '--api-key-file', config.keyFile, '--jinja',
  ];
  if (config.cpuMoe) args.push('--n-cpu-moe', '999');
  return args;
}

/** What `lms ps --json` reports for one helper, or a refusal when the helper could not be put back exactly. */
function snapshotHelpers(psJson) {
  let list;
  try {
    list = JSON.parse(psJson);
  } catch {
    throw new Refused('lms ps --json did not return JSON, so the helper models could not be recorded');
  }
  if (!Array.isArray(list)) throw new Refused('lms ps --json did not return a list');
  return list.map((entry) => {
    const identifier = entry && entry.identifier;
    const model = entry && (entry.path || entry.modelKey);
    if (typeof identifier !== 'string' || typeof model !== 'string' || !Number.isInteger(entry.contextLength)) {
      throw new Refused('a loaded helper lacks an identifier, model or context length, so it could not be reloaded exactly; nothing was unloaded');
    }
    if (entry.status !== 'idle' || entry.queued !== 0) {
      throw new Refused(`helper ${identifier} is not idle (status ${entry.status}, queued ${entry.queued}); wait for it, nothing was unloaded`);
    }
    if (entry.ttlMs !== null && entry.ttlMs !== undefined) {
      throw new Refused(`helper ${identifier} has a time-to-live, which this helper does not restore; nothing was unloaded`);
    }
    return { identifier, model, contextLength: entry.contextLength, parallel: Number.isInteger(entry.parallel) ? entry.parallel : null };
  });
}

function loadArgs(helper) {
  const args = ['load', helper.model, '--identifier', helper.identifier, '--context-length', String(helper.contextLength)];
  if (helper.parallel !== null) args.push('--parallel', String(helper.parallel));
  args.push('--gpu', 'max', '-y');
  return args;
}

/** A copy of env with these folders first on the path. Windows calls the variable Path; adding a second PATH would clash. */
function withPathFirst(env, dirs) {
  const copy = { ...env };
  const name = Object.keys(copy).find((key) => key.toLowerCase() === 'path') || 'Path';
  copy[name] = [...dirs.filter(Boolean), copy[name]].filter(Boolean).join(';');
  return copy;
}

function tolerantJson(text) {
  // PowerShell can prepend progress/CLIXML lines; take from the first JSON-looking line.
  const lines = String(text).split(/\r?\n/);
  const first = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (first < 0) return null;
  let body = lines.slice(first).join('\n');
  const end = body.search(/\r?\n<Objs /);
  if (end >= 0) body = body.slice(0, end);
  try { return JSON.parse(body); } catch { return null; }
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------- real machine operations (replaced by fakes in the tests) ----------

function runCommand(file, args, { timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: env || process.env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function powershell(script) {
  return runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference='SilentlyContinue'; ${script}`]);
}

function requestStatus(host, port, key) {
  return new Promise((resolve) => {
    const headers = key === null ? {} : { Authorization: `Bearer ${key}` };
    const request = http.request({ host, port, path: '/v1/models', method: 'GET', headers, timeout: 15_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ status: 0, error: error.code || error.message, body: '' }));
    request.end();
  });
}

function realDeps() {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exists: (file) => fs.existsSync(file),
    readFile: (file) => fs.readFileSync(file),
    run: runCommand,
    request: requestStatus,
    async gpuUsedMiB() {
      const result = await runCommand('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
      const used = result.code === 0 ? Number(result.stdout.trim().split(/\r?\n/)[0]) : NaN;
      if (!Number.isFinite(used)) throw new Error('nvidia-smi did not report GPU memory');
      return used;
    },
    async listeners() {
      const result = await powershell('Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress');
      const parsed = result.code === 0 ? tolerantJson(result.stdout) : null;
      if (parsed === null) throw new Error('the listener list could not be read');
      return asList(parsed);
    },
    async processInfo(pid) {
      const result = await powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p | Select-Object ExecutablePath,CommandLine,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress }`);
      if (result.code !== 0) throw new Error('the process could not be inspected');
      const parsed = tolerantJson(result.stdout);
      return parsed ? { executablePath: parsed.ExecutablePath || '', commandLine: parsed.CommandLine || '', created: parsed.Created || '' } : null;
    },
    spawnServer(exe, args, { env, stdoutFile, stderrFile }) {
      const out = fs.openSync(stdoutFile, 'a');
      const err = fs.openSync(stderrFile, 'a');
      const child = spawn(exe, args, { detached: true, stdio: ['ignore', out, err], windowsHide: true, env });
      child.unref();
      fs.closeSync(out);
      fs.closeSync(err);
      return new Promise((resolve) => {
        child.once('error', (error) => resolve({ pid: 0, error: error.message }));
        setImmediate(() => resolve({ pid: child.pid || 0 }));
      });
    },
    async killTree(pid) {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
    },
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    writeFile: (file, text) => fs.writeFileSync(file, text),
    readText: (file) => fs.readFileSync(file, 'utf8'),
    remove: (file) => fs.rmSync(file, { force: true }),
  };
}

// ---------- the window ----------

class Window {
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
    this.steps = [];
  }

  step(name, detail) {
    this.steps.push(detail === undefined ? { step: name } : { step: name, detail });
  }

  get recordFile() { return win.join(this.config.windowDir, RECORD); }

  readRecord() {
    const file = this.recordFile;
    if (!this.deps.exists(file)) return null;
    try {
      return JSON.parse(this.deps.readText(file));
    } catch {
      throw new Refused(`${file} is not readable JSON; fix or remove it by hand, nothing was changed`);
    }
  }

  writeRecord(record) {
    this.deps.writeFile(this.recordFile, `${JSON.stringify(record, null, 2)}\n`);
  }

  async lmsPs() {
    const result = await this.deps.run(this.config.lms, ['ps', '--json']);
    if (result.code !== 0) throw new Error(`lms ps failed (exit ${result.code})`);
    const start = result.stdout.indexOf('[');
    return result.stdout.slice(start < 0 ? 0 : start);
  }

  async isOwned(record) {
    if (!record.server) return false;
    const info = await this.deps.processInfo(record.server.pid);
    if (!info) return false;
    return info.executablePath.toLowerCase() === record.server.executablePath.toLowerCase()
      && info.created === record.server.created
      && info.commandLine.toLowerCase().includes(record.server.modelFile.toLowerCase());
  }

  async inventory() {
    const gpuUsedMiB = await this.deps.gpuUsedMiB();
    const helpers = JSON.parse(await this.lmsPs());
    const listeners = await this.deps.listeners();
    return {
      gpuUsedMiB,
      helpers: helpers.map((h) => ({ identifier: h.identifier, status: h.status, queued: h.queued, contextLength: h.contextLength, parallel: h.parallel })),
      listenersOnServingPort: listeners.filter((l) => l.LocalPort === this.config.port),
      listenersOnLmStudioPort: listeners.filter((l) => l.LocalPort === LM_STUDIO_PORT),
      recordPresent: this.deps.exists(this.recordFile),
    };
  }

  /** Reloads every helper in the record that is not loaded, then reads them back idle. Throws if one did not come back. */
  async restoreHelpers(record) {
    const wanted = record.helpers || [];
    const loadedNow = wanted.length === 0 ? [] : JSON.parse(await this.lmsPs());
    const failures = [];
    for (const helper of wanted) {
      if (loadedNow.some((entry) => entry.identifier === helper.identifier)) {
        this.step('helper-already-loaded', helper.identifier);
        continue;
      }
      const result = await this.deps.run(this.config.lms, loadArgs(helper), { timeoutMs: 600_000 });
      this.step('helper-load', { identifier: helper.identifier, exit: result.code });
      if (result.code !== 0) failures.push(`${helper.identifier}: lms load exited ${result.code}`);
    }
    if (wanted.length > 0) {
      const after = JSON.parse(await this.lmsPs());
      for (const helper of wanted) {
        const entry = after.find((e) => e.identifier === helper.identifier);
        if (!entry) { failures.push(`${helper.identifier}: not loaded after reload`); continue; }
        if (entry.contextLength !== helper.contextLength) failures.push(`${helper.identifier}: context ${entry.contextLength}, wanted ${helper.contextLength}`);
        if (helper.parallel !== null && entry.parallel !== helper.parallel) failures.push(`${helper.identifier}: parallel ${entry.parallel}, wanted ${helper.parallel}`);
        if (entry.status !== 'idle' || entry.queued !== 0) failures.push(`${helper.identifier}: not idle after reload`);
      }
    }
    if (failures.length > 0) throw new Error(`helpers not restored: ${failures.join('; ')}`);
  }

  async waitForPortEmpty(timeoutMs = 30_000) {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const mine = (await this.deps.listeners()).filter((l) => l.LocalPort === this.config.port);
      if (mine.length === 0) return;
      if (this.deps.now() >= deadline) throw new Error(`port ${this.config.port} still has a listener`);
      await this.deps.sleep(500);
    }
  }

  /** Stops the recorded server if it is still the process this window started; reloads helpers; clears the record. */
  async stop() {
    const record = this.readRecord();
    if (!record) {
      this.step('no-record');
      return { ok: true, nothingToStop: true };
    }
    const result = { ok: true, serverStopped: false, staleOwnership: false, helpersRestored: false, keyRemoved: false };
    if (record.server) {
      if (await this.isOwned(record)) {
        await this.deps.killTree(record.server.pid);
        this.step('server-killed', record.server.pid);
        if (await this.isOwned(record)) throw new Error(`server ${record.server.pid} is still running after the kill; the record was kept`);
        result.serverStopped = true;
      } else {
        // Gone already, or the id now belongs to another program: leave any such program alone.
        result.staleOwnership = Boolean(await this.deps.processInfo(record.server.pid));
        this.step('server-not-ours-or-gone', { pid: record.server.pid, staleOwnership: result.staleOwnership });
      }
    }
    await this.waitForPortEmpty();
    await this.restoreHelpers(record);
    result.helpersRestored = true;
    if (this.config.removeKeyOnStop) {
      try {
        this.deps.remove(this.config.keyFile);
        result.keyRemoved = !this.deps.exists(this.config.keyFile);
      } catch (error) {
        this.step('key-remove-failed', error.message);
      }
      if (!result.keyRemoved) result.ok = false;
    }
    this.deps.remove(this.recordFile);
    return result;
  }

  async start() {
    const { config, deps } = this;
    if (this.readRecord()) throw new Refused(`${this.recordFile} exists: a window is open or was interrupted; run stop first`);
    for (const [name, file] of [['modelFile', config.modelFile], ['keyFile', config.keyFile], ['server', win.join(config.backendDir, 'llama-server.exe')]]) {
      if (!deps.exists(file)) throw new Refused(`${name} was not found: ${file}`);
    }
    const keyBytes = deps.readFile(config.keyFile);
    const key = keyBytes.toString('utf8').trim();
    if (key === '') throw new Refused('the key file is empty');
    const keySha256 = crypto.createHash('sha256').update(keyBytes).digest('hex');
    if (config.expectedKeySha256 && keySha256 !== config.expectedKeySha256) throw new Refused('the key file does not match expectedKeySha256');
    if ((await deps.listeners()).some((l) => l.LocalPort === config.port)) throw new Refused(`something already listens on port ${config.port}`);
    const helpers = snapshotHelpers(await this.lmsPs());
    deps.mkdir(config.windowDir);

    // Write the way back before changing anything, so an interrupted start can always be recovered with stop.
    const record = { version: 1, openedAt: deps.now(), helpers, server: null, keySha256Prefix: keySha256.slice(0, 8) };
    this.writeRecord(record);
    const receipt = { helpersUnloaded: helpers.map((h) => h.identifier) };
    try {
      for (const helper of helpers) {
        const unloaded = await deps.run(config.lms, ['unload', helper.identifier], { timeoutMs: 300_000 });
        this.step('helper-unload', { identifier: helper.identifier, exit: unloaded.code });
        if (unloaded.code !== 0) throw new Error(`lms unload ${helper.identifier} exited ${unloaded.code}`);
      }
      if (JSON.parse(await this.lmsPs()).length > 0) throw new Error('a model is still loaded in LM Studio after the unload');
      receipt.gpuUsedMiBAfterUnload = await deps.gpuUsedMiB();
      if (receipt.gpuUsedMiBAfterUnload > config.maxGpuUsedMiB) {
        throw new Error(`GPU memory in use is ${receipt.gpuUsedMiBAfterUnload} MiB after the unload, above the ${config.maxGpuUsedMiB} MiB limit; something else holds the GPU`);
      }

      const exe = win.join(config.backendDir, 'llama-server.exe');
      const env = withPathFirst(process.env, [config.backendDir, config.vendorDir]);
      const args = serverArgs(config);
      const spawned = await deps.spawnServer(exe, args, {
        env, stdoutFile: win.join(config.windowDir, 'server.stdout.log'), stderrFile: win.join(config.windowDir, 'server.stderr.log'),
      });
      if (!spawned.pid) throw new Error(`the server did not start: ${spawned.error || 'no process id'}`);
      const info = await deps.processInfo(spawned.pid);
      if (!info) throw new Error('the started server exited at once; see server.stderr.log');
      record.server = { pid: spawned.pid, executablePath: info.executablePath, created: info.created, modelFile: config.modelFile };
      this.writeRecord(record);
      receipt.server = { pid: spawned.pid, args: args.map((a) => (a === config.keyFile ? '<key file>' : a)) };

      await this.waitUntilAnswering(record, key);
      receipt.listeners = await this.proveListeners(spawned.pid);
      receipt.keyProbe = await this.probeKeys(key);
      receipt.modelIds = receipt.keyProbe.modelIds;
      delete receipt.keyProbe.modelIds;
      receipt.keySha256Prefix = record.keySha256Prefix;
      return { ok: true, ...receipt, windowOpen: true };
    } catch (error) {
      this.step('start-failed', error.message);
      const cleanup = await this.stop().catch((cleanupError) => ({ ok: false, error: cleanupError.message }));
      return { ok: false, error: error.message, ...receipt, cleanup };
    }
  }

  /** Waits until the server answers with something other than "not listening" or 503 (the model is still loading). */
  async waitUntilAnswering(record, key) {
    const { config, deps } = this;
    const deadline = deps.now() + config.startTimeoutMs;
    for (;;) {
      const answer = await deps.request(config.host, config.port, key);
      if (answer.status !== 0 && answer.status !== 503) return;
      if (!(await this.isOwned(record))) throw new Error('the server exited while loading; see server.stderr.log');
      if (deps.now() >= deadline) throw new Error(`the server did not answer within ${config.startTimeoutMs} ms`);
      await deps.sleep(2000);
    }
  }

  /** Every listener of the serving port and of the started process must be on the bind address and owned by it. */
  async proveListeners(pid) {
    const { config } = this;
    const all = await this.deps.listeners();
    const relevant = all.filter((l) => l.LocalPort === config.port || l.OwningProcess === pid);
    if (relevant.length === 0) throw new Error(`no listener on port ${config.port}`);
    const bad = relevant.filter((l) => !sameAddress(l.LocalAddress, config.host) || l.OwningProcess !== pid || l.LocalPort !== config.port);
    if (bad.length > 0) {
      throw new Error(`listener check failed: ${bad.map((l) => `${l.LocalAddress}:${l.LocalPort} (pid ${l.OwningProcess})`).join(', ')}`);
    }
    return relevant.map((l) => ({ address: l.LocalAddress, port: l.LocalPort, pid: l.OwningProcess }));
  }

  async probeKeys(key) {
    const { config, deps } = this;
    const results = {};
    let modelIds = [];
    for (const [name, value, expected] of [['missing', null, 401], ['wrong', WRONG_KEY, 401], ['configured', key, 200]]) {
      const answer = await deps.request(config.host, config.port, value);
      results[name] = answer.status;
      if (name === 'configured' && answer.status === 200) {
        try { modelIds = (JSON.parse(answer.body).data || []).map((m) => m.id).filter((id) => typeof id === 'string'); } catch { modelIds = []; }
      }
      if (answer.status !== expected) throw new Error(`key probe failed: ${name} key got ${answer.status}, wanted ${expected}`);
    }
    return { ...results, modelIds };
  }

  async status() {
    const record = this.readRecord();
    if (!record) return { ok: true, windowOpen: false };
    return {
      ok: true,
      windowOpen: true,
      openedAt: record.openedAt,
      serverPid: record.server ? record.server.pid : null,
      serverStillOurs: await this.isOwned(record),
      helpersToRestore: (record.helpers || []).map((h) => h.identifier),
    };
  }
}

async function runCommandLine(command, config, deps) {
  const window = new Window(config, deps);
  let result;
  let code = 0;
  try {
    if (command === 'inventory') result = { ok: true, ...(await window.inventory()) };
    else if (command === 'start') result = await window.start();
    else if (command === 'stop') result = await window.stop();
    else if (command === 'status') result = await window.status();
    else throw new Refused('unknown command; use inventory, start, status or stop');
    if (!result.ok) code = 1;
  } catch (error) {
    if (error instanceof Refused) {
      result = { ok: false, refused: error.message };
      code = 2;
    } else {
      result = { ok: false, error: error.message };
      code = 1;
    }
  }
  const receipt = { command, at: deps.now(), ...result, steps: window.steps };
  const text = `${JSON.stringify(receipt)}\n`;
  try {
    deps.mkdir(config.windowDir);
    deps.writeFile(win.join(config.windowDir, `receipt-${command}.json`), text);
  } catch {
    /* the receipt on stdout is still complete */
  }
  return { code, text };
}

async function main(argv, deps = realDeps()) {
  const [command, configFile] = argv;
  if (!['inventory', 'start', 'status', 'stop'].includes(command) || !configFile) {
    throw new Refused('usage: serving-window.js <inventory|start|status|stop> <config.json>');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    throw new Refused(`${configFile} could not be read as JSON`);
  }
  const config = validateConfig(raw);
  const { code, text } = await runCommandLine(command, config, deps);
  process.stdout.write(text);
  return code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`serving-window: ${err instanceof Refused ? err.message : err.stack}\n`);
      process.exitCode = err instanceof Refused ? 2 : 1;
    },
  );
}

module.exports = { Refused, Window, isTailscaleAddress, loadArgs, main, runCommandLine, serverArgs, snapshotHelpers, tolerantJson, validateConfig, withPathFirst };
