#!/usr/bin/env node
'use strict';
/**
 * A live test's Harness copy, on another computer when one can take it. The agent stays here; the install, the builds,
 * the screens' server and Harness itself run on the first of these that isn't busy: the test Mac, then the PC (in its
 * Linux space, on a screen nobody sees), then this Mac (James's order, 14 November 2026). A signed package needs a Mac,
 * and so does a check that needs a signed-in AI tool (`--mac`): those skip the PC. Busy means a 5-minute load of 1.5
 * per processor or more, or as many copies as it takes. A computer already running this port's copy is used even when
 * busy if the start would join it; replacing it means a fresh build, which goes to a computer that isn't busy. When
 * every one is busy, start looks again every 2 minutes until one isn't: it never gives up for being busy. A tunnel then
 * carries this Mac's debugging port to the copy's, so the agent drives it over CDP at http://127.0.0.1:<port> exactly
 * as it would a copy started here. The tunnel closes by itself when the copy stops.
 *
 *   node <Harness checkout>/scripts/remote-checks/dev-app.js start --port <debugging port> --data /tmp/aio-lt-<name>
 *   node .../dev-app.js shell --port <debugging port> '<command>'   # runs beside the copy, its data folder in
 *                                                                    # AIO_DEV_USER_DATA_PATH
 *   node .../dev-app.js stop --port <debugging port>
 *   node .../dev-app.js status
 *   node .../dev-app.js start --pc ...                 # a copy on the PC, for a check of Windows paths
 *   node .../dev-app.js worker-start --port <p> --coordinator-port <n> < token    # a disposable Windows worker for it
 *   node .../dev-app.js worker-stop --port <p>
 *   node .../dev-app.js start --windows ...                         # on the PC's Windows desktop, not its Linux space
 *   node .../dev-app.js seed --port <debugging port>                # stand-ins for a copy with no AI tool signed in
 *
 * Run it from inside the checkout being tested; the files on disk go, uncommitted ones included. Exits 0 when done, 1
 * when the copy failed to build or start (its output says why), 2 for a usage mistake, and 75 when this Mac is the one
 * to use: start the copy here, as the live-test runbook's "On this Mac" part says. With --remote-only, and always for a
 * signed package (which has no procedure on this Mac), start waits for an eligible remote computer instead and never
 * returns 75. `--needs codex,copilot` names the AI tools the check needs: only a computer that has every one installed
 * may take the copy, this Mac never does, and when every computer has answered and none has them, start sends nothing
 * and exits 3 saying what each lacks. That is installation only; whether a tool is signed in is for the copy to report.
 *
 * --windows starts the copy on the PC's own Windows desktop (navigator.platform Win32, Windows keyboard labels) instead of
 * its Linux space: scripts/remote-checks/windows-copy.js does the install, builds and launch with Windows' Node. It is
 * a dev copy (never packaged), always waits for the PC (never this Mac, never exit 75), and a window opens on the PC's
 * desktop. start checks over the debugging port that the copy really reports a Windows platform, and stops it if not.
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { appendRunLog, isLoopRun, readConfig, remoteChecksDir } = require('./route');
const { SSH_OPTIONS, sendScript, sendSnapshot, sshCommand } = require('./run-remote');
const { SnapshotRefused, cleanGitEnv, snapshotFileHash, takeSnapshot } = require('./snapshot');
const { seedExpression } = require('./dev-app-seed');

const STAY_HERE = 75;
const USAGE_ERROR = 2;
/** No computer that answered has the AI tools `--needs` names. Waiting would not change that. */
const TOOLS_MISSING = 3;
/** The tools `--needs` may name: the fixed list `devapp-providers` in remote-run.sh looks for. */
const NEEDABLE_TOOLS = ['claude', 'codex', 'copilot', 'gemini', 'agy', 'opencode', 'cursor-agent', 'grok'];
const RESULT_PREFIX = 'AIO_REMOTE_RESULT ';
/** Covers a first install of every package, both builds and Harness starting. */
const START_LIMIT_MS = 25 * 60_000;
const SHELL_LIMIT_MS = 10 * 60_000;
const TUNNEL_WAIT_MS = 20_000;
const PORT_FREE_WAIT_MS = 15_000;
const ANSWER_WAIT_MS = 15_000;
/** Busy from this 5-minute load per processor: the first step of src/main/runtime/system-load-monitor.ts. */
const BUSY_LOAD_PER_CORE = 1.5;
/** How long to wait before looking again when every computer is busy. AIO_DEVAPP_RECHECK_MS changes it. */
const RECHECK_MS = 2 * 60_000;
const SEED_WAIT_MS = 30_000;
const PLATFORM_WAIT_MS = 30_000;
const CDP_LIMIT_MS = 15_000;
/**
 * What a checkout needs for the copy to be owned as a live test: the far script runs the first, the app reads the second.
 * A branch cut before they landed has neither, and without this check it fails only after the install and both builds.
 */
const LIVE_TEST_FILES = ['scripts/remote-checks/live-test-copy.js', 'src/main/app/live-test-context.ts'];
const DATA_FOLDER = /^\/tmp\/aio-lt-[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;
/** The installed Harness's own coordinator port. A disposable worker never joins it. */
const INSTALLED_COORDINATOR_PORT = 4878;
const WORKER_LIMIT_MS = 5 * 60_000;
/** How long a revoked worker may stay in its copy's list of nodes before that counts as a failure. */
const REVOKE_WAIT_SECONDS = 60;
/** A stop that finds the worker's lock taken is asked again this many times, this far apart. */
const WORKER_STOP_ATTEMPTS = 12;
const WORKER_STOP_PAUSE_MS = 3_000;

const USAGE = `dev-app: a live test's Harness copy, run on another computer and driven from here.

  start --port <debugging port> --data /tmp/aio-lt-<name> [--remote-only] [--mac | --pc | --windows] [--needs <tools>] [--packaged] [--checked-tree <tree>]
      Sends this checkout's files, builds and starts Harness on the first computer that isn't busy (the test Mac,
      then the PC, then this Mac), and connects http://127.0.0.1:<port> here to it. Takes a few minutes, longer
      after a package change. When all are busy it waits, looking again every 2 minutes, until one isn't. Exit 75
      means use this Mac. Running it again with the same files joins the copy already starting or running.
      --mac skips the PC, whose copy has no AI tool signed in: for a check that needs one.
      --pc uses only the PC, never this Mac: for a check that needs Windows beside the copy (worker-start).
      --remote-only waits for an eligible remote computer; it never chooses this Mac or exits 75.
      --windows runs the copy on the PC's Windows desktop, not in its Linux space: for a check that needs Windows
      itself (key labels, a Windows screen reader). A window opens on the PC. Not with --mac, --packaged or --needs.
      --needs <tool,tool> (${NEEDABLE_TOOLS.join(', ')}) takes only a computer that has each installed, and never
      this Mac. When every computer has answered and none has them, nothing is sent and it exits 3, saying what each
      lacks. It proves installation only: whether a tool is signed in is for the copy to report.
      --packaged builds a signed directory package in the owned copy; it never installs or publishes it.
      --checked-tree sends the index only and refuses a tree mismatch before sending any files.
      --signing-password-stdin (packaged only) unlocks the signing keychain in that build's SSH session.
      Supply the password through a secure pipe; never a command argument, environment variable or file.
  shell --port <debugging port> '<command>'
      Runs a shell command in the copy's checkout, on its computer, with its data folder in AIO_DEV_USER_DATA_PATH.
  stop --port <debugging port>
      Stops the copy and closes the connection.
  worker-start --port <debugging port> --coordinator-port <port>
      Starts a disposable Windows worker on the PC for the copy there and joins it to that copy's coordinator on
      127.0.0.1:<coordinator port> (not 4878, the installed Harness's). The copy needs its remote nodes server on, from
      launch, and a pairing token from it: pipe the token in on stdin, never on the command line. The worker has a
      folder, home, node id and workspace of its own in Windows's temp folder and never touches the installed worker.
  worker-stop --port <debugging port>
      Stops that worker, removes its folder and revokes its node in the copy (through the debugging port), so the copy
      no longer lists it; says whether each happened. A copy that stops takes its worker too.
  status
      Lists the copies on each computer.
  seed --port <debugging port>
      Fills the copy's screens with labelled stand-ins (an AI tool shown as installed, two sessions with queued
      messages, an unavailable account, a Browser page) for a copy with no AI tool signed in. Screen only: nothing reaches
      a provider or account. Run it again after opening the Browser or Plan Queue account rules screen.`;

class UsageError extends Error {}

function parse(argv) {
  const [action, ...rest] = argv;
  if (!action || ['help', '--help', '-h'].includes(action)) return { action: 'help' };
  if (!['start', 'stop', 'shell', 'status', 'seed', 'worker-start', 'worker-stop'].includes(action)) throw new UsageError(`there is no dev-app ${action}`);
  const options = {
    port: null, data: null, command: [], mode: 'dev', windows: false, macOnly: false, pcOnly: false, remoteOnly: false, needs: [],
    checkedTree: null, unlockSigning: false, coordinatorPort: null,
  };
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (arg === '--remote-only') {
      if (action !== 'start') throw new UsageError(`dev-app ${action} doesn't take ${arg}`);
      options.remoteOnly = true;
    } else if (arg === '--packaged' && action === 'start') {
      options.mode = 'packaged';
    } else if (arg === '--mac' && action === 'start') {
      options.macOnly = true;
    } else if (arg === '--pc' && action === 'start') {
      options.pcOnly = true;
    } else if (arg === '--windows' && action === 'start') {
      options.windows = true;
    } else if (arg === '--needs' && action === 'start') {
      const value = rest[++at];
      const names = value ? value.split(',') : [];
      const unknown = names.filter(name => !NEEDABLE_TOOLS.includes(name));
      if (!names.length || unknown.length) {
        throw new UsageError(`--needs takes a comma-separated list from ${NEEDABLE_TOOLS.join(', ')}${unknown.length ? `, not ${unknown.join(', ')}` : ''}`);
      }
      options.needs = [...new Set(names)];
    } else if (arg === '--signing-password-stdin' && action === 'start') {
      options.unlockSigning = true;
    } else if (arg === '--checked-tree' && action === 'start') {
      const value = rest[++at];
      if (!value || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new UsageError('--checked-tree takes a full hexadecimal tree identity');
      options.checkedTree = value;
    } else if (arg === '--coordinator-port' && action === 'worker-start') {
      const value = Number(rest[++at]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new UsageError('--coordinator-port takes a number from 1024 to 65535');
      if (value === INSTALLED_COORDINATOR_PORT) throw new UsageError(`port ${INSTALLED_COORDINATOR_PORT} is the installed Harness's own`);
      options.coordinatorPort = value;
    } else if (arg === '--port' || arg === '--data') {
      const value = rest[at + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      at += 1;
    } else if (action === 'shell') {
      options.command = rest.slice(arg === '--' ? at + 1 : at);
      break;
    } else {
      throw new UsageError(`dev-app ${action} doesn't take ${arg}`);
    }
  }
  if (action !== 'status') {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError('--port takes the debugging port, a number from 1024 to 65535');
    options.port = port;
  }
  if (action === 'start' && (!options.data || !DATA_FOLDER.test(options.data) || options.data.includes('..'))) {
    throw new UsageError('--data takes the copy\'s own data folder, starting /tmp/aio-lt-');
  }
  if (action === 'shell' && !options.command.join(' ').trim()) throw new UsageError('dev-app shell needs a command');
  if (action === 'worker-start' && !options.coordinatorPort) throw new UsageError('worker-start needs --coordinator-port');
  if (options.macOnly && options.pcOnly) throw new UsageError('--mac and --pc cannot be used together');
  if (options.pcOnly && options.mode === 'packaged') throw new UsageError('a signed package needs a Mac, so it cannot use --pc');
  if (options.unlockSigning && options.mode !== 'packaged') throw new UsageError('--signing-password-stdin requires --packaged');
  if (options.windows) {
    if (options.mode === 'packaged' || options.macOnly || options.needs.length) throw new UsageError('--windows is a development copy on the PC; it does not go with --packaged, --mac or --needs');
    options.mode = 'windows';
  }
  return { action, options };
}

/** Bounded pipe input only; a secret must never turn into an interactive prompt. `what` names it in the errors. */
function readSecretPipe(input = process.stdin, timeoutMs = 15_000, what = 'The signing password') {
  if (input.isTTY) return Promise.reject(new UsageError(`${what} must arrive through a secure pipe`));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let used = 0;
    const finish = (error) => {
      clearTimeout(timer);
      input.off('data', onData).off('end', onEnd).off('error', onError);
      input.pause();
      const value = error ? null : Buffer.concat(chunks);
      chunks.forEach(chunk => chunk.fill(0));
      if (error) { input.destroy(); reject(error); } else resolve(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      used += bytes.length;
      if (used > 4096) finish(new UsageError(`${what} pipe must contain 1 to 4096 bytes`));
    };
    const onEnd = () => finish(used ? null : new UsageError(`${what} pipe must contain 1 to 4096 bytes`));
    const onError = () => finish(new UsageError(`Could not read ${what.toLowerCase()} pipe`));
    const timer = setTimeout(() => finish(new UsageError(`${what} pipe timed out`)), timeoutMs);
    input.on('data', onData).once('end', onEnd).once('error', onError);
  });
}

function gitPath(cwd, ...args) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', ...args], {
    cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** The checkout `cwd` is in, when it is a checkout of the repository `commonDir` belongs to; null otherwise. */
function harnessRoot(cwd, commonDir) {
  try {
    if (fs.realpathSync(gitPath(cwd, '--git-common-dir')) !== fs.realpathSync(commonDir)) return null;
    return fs.realpathSync(gitPath(cwd, '--show-toplevel'));
  } catch {
    return null;
  }
}

/**
 * The computers a copy may start on, in the order to try them: Macs first, so the test Mac comes before the PC. `only`
 * 'mac' leaves out the PC, and 'pc' leaves out the Macs: a copy for the PC's Windows side (--pc or --windows) goes to a
 * computer that isn't a Mac, whose far script says if it has no Windows desktop.
 */
function copyMachines(config, only = null) {
  const usable = (config?.machines ?? []).filter(machine => !machine.paused
    && (only !== 'mac' || machine.platform === 'darwin') && (only !== 'pc' || machine.platform !== 'darwin'));
  return [...usable.filter(machine => machine.platform === 'darwin'), ...usable.filter(machine => machine.platform !== 'darwin')];
}

/** Why a computer can't take another copy now, from its `{ load, cores, copies, limit }`; null when it can. */
function busyReason(label, { load, cores, copies, limit }) {
  if (copies >= limit) return `${label} already runs as many Harness copies as it takes (${copies})`;
  if (load >= cores * BUSY_LOAD_PER_CORE) return `${label} is busy (load ${Math.round(load)} on ${cores} processors)`;
  return null;
}

/** This Mac's own load, for when it is the last choice. Copies started here aren't counted: their load is. */
function thisMacLoad() {
  return { load: os.loadavg()[1], cores: os.cpus().length, copies: 0, limit: Infinity };
}

/**
 * Sends the far script and asks how busy the computer is and about the copy on `port` there, if one lives there:
 * `{ machine, script, reachable, busy, copy, kept }`, `busy` null when it isn't, `copy` `{ tree, data, mode }` or null,
 * and `kept` whether that port's folder is there, running or not.
 */
async function lookAt(machine, port) {
  const { script, sent } = await sendScript(machine, `devapp-load ${port}`);
  if (sent.code !== 0 || sent.timedOut) {
    return { machine, script, reachable: false, busy: `${machine.label} could not be reached`, copy: null, kept: false };
  }
  const line = sent.stdout.split('\n').find(row => row.startsWith(RESULT_PREFIX));
  try {
    const load = JSON.parse(line.slice(RESULT_PREFIX.length));
    return { machine, script, reachable: true, busy: busyReason(machine.label, load), copy: load.copy ?? null, kept: load.kept === true };
  } catch {
    return { machine, script, reachable: true, busy: `${machine.label} did not say how busy it is`, copy: null, kept: false };
  }
}

/**
 * Which of `machines` have every tool in `needs` installed, asked of each: `{ able, lacking, unasked }`, `lacking` being
 * `[{ machine, missing }]`. A computer that can't be asked, or answers oddly, is `unasked`, never `lacking`: it may have
 * them, so it is waited for rather than counted out. With nothing needed every machine is able and nobody is asked.
 */
async function haveTools(machines, needs) {
  if (!needs.length) return { able: machines, lacking: [], unasked: [] };
  const able = [];
  const lacking = [];
  const unasked = [];
  for (const machine of machines) {
    const { sent } = await sendScript(machine, 'devapp-providers');
    const line = sent.code === 0 && !sent.timedOut ? sent.stdout.split('\n').find(row => row.startsWith(RESULT_PREFIX)) : null;
    let installed = null;
    try {
      installed = line ? JSON.parse(line.slice(RESULT_PREFIX.length)).installed : null;
    } catch {
      installed = null;
    }
    if (!Array.isArray(installed)) {
      unasked.push(machine);
      continue;
    }
    const missing = needs.filter(name => !installed.includes(name));
    if (missing.length) lacking.push({ machine, missing });
    else able.push(machine);
  }
  return { able, lacking, unasked };
}

function recheckMs(env) {
  const value = Number(env.AIO_DEVAPP_RECHECK_MS);
  return Number.isFinite(value) && value >= 0 ? value : RECHECK_MS;
}

function clockTime(at) {
  return new Date(at).toTimeString().slice(0, 5);
}

function stateDir(env) {
  return path.join(remoteChecksDir(env), 'dev-apps');
}

function stateFile(env, port) {
  return path.join(stateDir(env), `${port}.json`);
}

function readState(env, port) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(env, port), 'utf8'));
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Whether the debugging port here answers as a browser's would, within `waitMs`. */
async function answersOnPort(port, waitMs = ANSWER_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2_000 }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(false));
    });
    if (ok || Date.now() >= deadline) return ok;
    await sleep(500);
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForFreePort(port, waitMs = PORT_FREE_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await portIsFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/**
 * Runs `expression` in the copy's window over its debugging port (here, through the tunnel) and resolves with the value.
 * Only ever the copy this runner started: the port is the tunnel to it, never an everyday app's.
 */
async function cdpEvaluate(port, expression, limitMs = CDP_LIMIT_MS) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(limitMs) })).json();
  const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl && /^http:\/\/localhost[:/]/.test(target.url ?? ''));
  if (!page) throw new Error('the copy has no window showing its screens yet');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('the copy did not answer')); }, limitMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message ?? message.result.exceptionDetails.exception?.description ?? 'the page refused it'));
      } else {
        resolve(message.result.result.value);
      }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('could not connect to the copy')); });
  });
}

/** Runs devapp-start, passing on what it prints. Resolves with its result line, or null if none arrived. */
function streamStart(machine, remoteCommand, data, write) {
  return new Promise((resolve) => {
    const child = spawn(machine.ssh || 'ssh', [
      ...(machine.sshConfig ? ['-F', machine.sshConfig] : []), ...SSH_OPTIONS, machine.host, remoteCommand,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    let result = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), START_LIMIT_MS);
    const takeLine = (line) => {
      if (!line.startsWith(RESULT_PREFIX)) {
        write(`${line}\n`);
        return;
      }
      try {
        result = JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch {
        result = null;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach(takeLine);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => write(chunk));
    child.stdin.on('error', () => { /* the far end went away; `close` reports it */ });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (pending) takeLine(pending);
      resolve(result);
    };
    child.on('error', finish);
    child.on('close', finish);
    // The folder name travels as data. Built into the command, a shell on the test Mac would read it.
    child.stdin.end(data, () => { if (Buffer.isBuffer(data)) data.fill(0); });
  });
}

/**
 * Opens the tunnel from this Mac's port to the copy's, as a process of its own that outlives this command. Its far end
 * (devapp-hold) says `held` once the forward is in place, and lasts as long as the copy. Resolves with the tunnel's
 * process id once it has, or null.
 */
async function openTunnel(machine, script, port, env) {
  fs.mkdirSync(stateDir(env), { recursive: true });
  const logPath = path.join(stateDir(env), `${port}.tunnel.log`);
  const out = fs.openSync(logPath, 'w');
  const child = spawn(machine.ssh || 'ssh', [
    ...(machine.sshConfig ? ['-F', machine.sshConfig] : []), ...SSH_OPTIONS,
    '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`,
    machine.host, `bash ${script} devapp-hold ${port}`,
  ], { detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  child.unref();
  const deadline = Date.now() + TUNNEL_WAIT_MS;
  while (Date.now() < deadline) {
    if (/^held$/m.test(fs.readFileSync(logPath, 'utf8'))) return child.pid;
    if (exited) return null;
    await sleep(200);
  }
  return null;
}

function isRunning(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logRun(env, started, machine, exitCode, reason, waitedMs = 0) {
  appendRunLog({
    at: new Date(started).toISOString(), project: 'ai-orchestrator', kind: 'dev-app', loop: isLoopRun(env),
    ranOn: exitCode === STAY_HERE ? 'none' : machine?.host ?? 'none', waitedMs,
    tookMs: Date.now() - started, exitCode, fellBackBecause: reason ?? null,
  }, env);
}

/** The name live-test receipts give the computer: its paired name (windows-pc) or its host (ct-test-mac). */
function computerName(machine) {
  return machine.nodeName ?? machine.host;
}

/**
 * Starts the copy on one computer, its far script already sent. Resolves `{ code }` when that settles it, or
 * `{ busy: reason }` when the computer turned it away for being busy or out of reach, so the next one can be tried.
 */
async function startOn({ machine, script, own, previous, root, snapshot, options, signingPassword, env, write, answers, evaluate, started }) {
  const { port, data, mode, unlockSigning } = options;
  // The commits it already has, so only what is new travels.
  const bases = await sshCommand(machine, `bash ${script} bases`);
  if (bases.code !== 0 || bases.timedOut) return { busy: `${machine.label} could not be reached` };
  write(`dev-app: sending this checkout to ${machine.label}\n`);
  const fault = await sendSnapshot(root, snapshot, machine, script, bases.stdout.split('\n').filter(Boolean), '');
  if (fault) return { busy: fault };

  const receipt = {
    tree: snapshot.tree, root, startedAt: new Date(started).toISOString(), computer: computerName(machine), mode, needs: options.needs,
  };
  write(`AIO_DEV_APP_START ${JSON.stringify(receipt)}\n`);

  const payload = signingPassword ? Buffer.concat([Buffer.from(`${data}\n`), signingPassword]) : data;
  const result = await streamStart(machine, `bash ${script} devapp-start ${port} ${snapshot.commit} ${mode} ${unlockSigning ? 1 : 0}`, payload, write);
  if (!result) {
    write(`dev-app: the connection to ${machine.label} was lost while Harness started. Run the same command again: `
      + 'it joins the copy if it is still starting.\n');
    return { code: 1, reason: 'the connection was lost' };
  }
  if (result.status === 'busy') return { busy: `${machine.label}: ${result.reason}` };
  if (result.status === 'taken') {
    write(`dev-app: ${result.reason}, for another data folder, so it was left alone. Use the port you were given.\n`);
    return { code: 1, reason: result.reason };
  }
  if (result.status !== 'ready') {
    write(`dev-app: Harness did not start on ${machine.label}: ${result.reason}. What it printed is above.\n`);
    const cleanup = await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
    if (cleanup.code !== 0 || cleanup.timedOut) {
      write(`dev-app: cleanup of the failed copy could not be confirmed; run stop --port ${port} and check status.\n`);
    }
    return { code: 1, reason: result.reason };
  }

  // A copy joined from this checkout's earlier start may still have its tunnel here.
  const joined = own && previous.tree === snapshot.tree && previous.data === data && previous.mode === mode && await answers(port, 2_000);
  // Written as soon as the tunnel exists, so a start cut off after this point can be run again and reuse it.
  const remember = tunnelPid => fs.writeFileSync(stateFile(env, port), `${JSON.stringify({
    host: machine.host, label: machine.label, port, data, root, tree: snapshot.tree, mode, tunnelPid,
    startedAt: new Date(started).toISOString(),
  })}\n`);
  if (!joined) {
    if (!await waitForFreePort(port)) {
      write(`dev-app: port ${port} is in use on this Mac, perhaps by a copy started here. Stop that, then run this again.\n`);
      await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
      return { code: 1, reason: 'the port was in use here' };
    }
    const tunnelPid = await openTunnel(machine, script, port, env);
    if (tunnelPid) remember(tunnelPid);
    if (!tunnelPid || !await answers(port)) {
      write(`dev-app: Harness started on ${machine.label}, but the connection to it from here did not work. `
        + `See ${path.join(stateDir(env), `${port}.tunnel.log`)}.\n`);
      await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
      fs.rmSync(stateFile(env, port), { force: true });
      return { code: 1, reason: 'the tunnel did not open' };
    }
  }
  if (joined) remember(previous.tunnelPid);
  if (mode === 'windows') {
    // The test is of Windows itself, so a copy that doesn't say it is Windows is no result at all.
    // The window may still be loading its screens, which it cannot be asked until it has.
    let platform = null;
    for (const until = Date.now() + PLATFORM_WAIT_MS; ;) {
      platform = await evaluate(port, 'navigator.platform').catch(() => null);
      if (typeof platform === 'string' || Date.now() >= until) break;
      await sleep(1_000);
    }
    if (typeof platform !== 'string' || !/^Win/.test(platform)) {
      write(`dev-app: the copy on ${machine.label} reports its platform as ${platform ?? 'nothing'}, not Windows, so it was stopped.\n`);
      await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
      fs.rmSync(stateFile(env, port), { force: true });
      return { code: 1, reason: 'the copy did not report a Windows platform' };
    }
    write(`dev-app: the copy reports navigator.platform ${platform}.\n`);
  }
  write(`dev-app: Harness is running on ${machine.label}, reached here at http://127.0.0.1:${port} (CDP). Its data `
    + `folder there is ${data}; read it with dev-app shell. Stop it with: node ${__filename} stop --port ${port}\n`);
  write(`AIO_DEV_APP_RECEIPT ${JSON.stringify(receipt)}\n`);
  return { code: 0, reason: null };
}

/**
 * Stops this test's copy on a computer this start passes by. Its tunnel here, if any, closes by itself as the copy
 * stops (devapp-hold ends with it), freeing the port; nothing on this Mac is ever signalled, as a recorded process id
 * may by now be another program's.
 */
async function stopOlderCopy(look, port, previous, why, write) {
  write(`dev-app: stopping this test's older copy on ${look.machine.label}, ${why}\n`);
  const stopped = await sshCommand(look.machine, `bash ${look.script} devapp-stop ${port}`);
  if (stopped.code !== 0 || stopped.timedOut) {
    write(`dev-app: the older copy on ${look.machine.label} could not be confirmed stopped; it stops by itself within 4 `
      + 'hours.\n');
  }
}

/**
 * Before this start's copy goes anywhere but where its earlier copy is, that copy goes, wherever it is: the computer may
 * since have been paused or left out of this start's choice, and its tunnel here would hold the port until it stops.
 * Only a copy of the recorded data folder is stopped: a record days old may name a port another test now uses there.
 */
async function leaveEarlierCopy(config, previous, port, write) {
  const machine = config?.machines.find(entry => entry.host === previous.host);
  if (!machine) return;
  const look = await lookAt(machine, port);
  if (look.copy?.data === previous.data) await stopOlderCopy(look, port, previous, 'before starting elsewhere', write);
}

async function start({ options, root, env, write, answers, evaluate, localLoad }) {
  const { port, mode, checkedTree, unlockSigning, needs } = options;
  const windowsOnly = mode === 'windows';
  const only = options.macOnly || mode === 'packaged' ? 'mac' : options.pcOnly || windowsOnly ? 'pc' : null;
  // A signed package and a Windows desktop have no procedure on this Mac, and it can't be asked what it has installed,
  // so a start that needs tools never lands here either.
  const remoteOnly = options.remoteOnly || mode === 'packaged' || options.pcOnly || windowsOnly || needs.length > 0;
  const started = Date.now();
  // The port here may only be held by this checkout's own earlier copy's tunnel, which this start reuses or replaces.
  // Held by anything else, it is someone else's, and nothing is sent.
  const previous = readState(env, port);
  const tunnelHere = previous?.root === root && isRunning(previous.tunnelPid);
  if (!tunnelHere && !await portIsFree(port)) {
    write(`dev-app: port ${port} is in use on this Mac, perhaps by a copy started here or another live test. Use the `
      + 'port you were given, or stop that copy first.\n');
    logRun(env, started, null, 1, 'the port was in use here');
    return 1;
  }

  // Taken again after every wait: the wait has no end, and a snapshot a day old is cleared away as abandoned.
  let snapshot;
  const takeChecked = () => {
    snapshot?.cleanup();
    snapshot = null;
    try {
      snapshot = takeSnapshot(root, checkedTree ? { folders: [] } : {});
    } catch (err) {
      if (!(err instanceof SnapshotRefused)) throw err;
      write(`dev-app: this checkout's files can't be sent: ${err.message}\n`);
      return false;
    }
    if (checkedTree && snapshot.tree !== checkedTree) {
      write('dev-app: the actual index snapshot does not match the checked tree; nothing was sent.\n');
      return false;
    }
    const missing = LIVE_TEST_FILES.find(file => snapshotFileHash(root, snapshot, file) === 'none');
    if (missing) {
      write(`dev-app: this checkout has no ${missing}, which a live-test copy needs. It was probably cut before that landed: `
        + 'merge main into it, then run this again. Nothing was sent.\n');
      return false;
    }
    return true;
  };
  let signingPassword;
  try {
    if (!takeChecked()) return 1;
    if (unlockSigning) signingPassword = await readSecretPipe();
    let waitedMs = 0;
    for (;;) {
      // Read each time round, so pausing or unpausing a computer during the wait counts.
      const config = readConfig(env);
      const reasons = config ? [] : ['no test machines are set up'];
      // Every unpaused computer is asked, so this test's copy is found even where this start can't go (a rerun with
      // --mac while it is on the PC); such a copy is stopped below, as its tunnel here would hold the port.
      const { able: eligible, lacking, unasked } = await haveTools(copyMachines(config, only), needs);
      if (needs.length && !eligible.length && !unasked.length && lacking.length) {
        const gaps = lacking.map(({ machine, missing }) => `${machine.label} lacks ${missing.join(' and ')}`).join('; ');
        write(`dev-app: no computer has ${needs.join(' and ')} installed: ${gaps}. Nothing was sent. Install and sign in `
          + `on a test computer, then run this again. This only checks installation, which is looked for on each login `
          + 'shell\'s PATH and the usual install folders.\n');
        logRun(env, started, null, TOOLS_MISSING, gaps, waitedMs);
        return TOOLS_MISSING;
      }
      const looks = [];
      for (const machine of copyMachines(config)) {
        const look = await lookAt(machine, port);
        if (eligible.includes(machine)) looks.push(look);
        // One that couldn't be asked what it has is not known to be unfit, so a copy on it is left running.
        else if (look.copy?.data === options.data && !unasked.includes(machine)) await stopOlderCopy(look, port, previous, 'which this start can\'t use', write);
      }
      if (needs.length) for (const machine of unasked) reasons.push(`${machine.label} could not be asked what is installed`);
      // A computer already running this port's copy goes first, busy or not, when the start would join it (same files,
      // data folder and mode: a start cut off part-way, run again) or the copy is another data folder's, which
      // devapp-start leaves alone. Replacing a copy means a fresh build, so a busy computer's old copy is stopped and
      // the build goes to the first computer that isn't busy, in order.
      const first = [];
      for (const look of looks) {
        const { copy } = look;
        if (!copy) continue;
        const joins = copy.tree === snapshot.tree && copy.data === options.data && copy.mode === mode;
        // A copy in the other mode is never replaced (devapp-start answers "taken"), so it is tried there to say so.
        if (joins || copy.data !== options.data || copy.mode !== mode || !look.busy) {
          first.push(look);
        } else {
          await stopOlderCopy(look, port, previous, 'which is busy', write);
        }
      }
      const order = [...first, ...looks.filter(look => !first.includes(look) && !look.busy)];
      for (const look of looks) if (look.busy && !first.includes(look)) reasons.push(look.busy);
      for (const { machine, script } of order) {
        const own = tunnelHere && previous.host === machine.host;
        if (tunnelHere && !own) await leaveEarlierCopy(config, previous, port, write);
        const outcome = await startOn({
          machine, script, own, previous, root, snapshot, options, signingPassword, env, write, answers, evaluate, started,
        });
        if (outcome.busy) {
          reasons.push(outcome.busy);
          continue;
        }
        logRun(env, started, machine, outcome.code, outcome.reason, waitedMs);
        return outcome.code;
      }
      // James, 14 November 2026: when the test Mac and the PC are busy, a live-test copy may use this Mac. That holds even
      // with "Use this Mac when the others are busy or away" off, which still governs test runs and checks.
      if (!remoteOnly) {
        const here = busyReason('this Mac', localLoad());
        if (!here) {
          if (tunnelHere) {
            await leaveEarlierCopy(config, previous, port, write);
            if (!await waitForFreePort(port)) {
              write(`dev-app: this Mac is free, but port ${port} is still in use here. Stop the copy with: node `
                + `${__filename} stop --port ${port}, then run this again.\n`);
              logRun(env, started, null, 1, 'the port was in use here', waitedMs);
              return 1;
            }
          }
          write(`dev-app: ${reasons.join('; ') || 'no other computer takes live-test copies'}. Start Harness on this Mac `
            + 'instead, as the live-test runbook\'s "On this Mac" part says.\n');
          logRun(env, started, null, STAY_HERE, reasons.join('; '), waitedMs);
          return STAY_HERE;
        }
        reasons.push(here);
      }
      const pause = recheckMs(env);
      const waiting = remoteOnly ? 'waiting for a remote computer that can run this copy' : 'every computer is busy';
      write(`dev-app: ${waiting} (${reasons.join('; ') || 'no unpaused remote computer supports this launch'}). Looking again at ${clockTime(Date.now() + pause)}, `
        + 'and on until one is free. Leave this running; if it is cut off, run the same command again.\n');
      await sleep(pause);
      waitedMs += pause;
      if (!takeChecked()) {
        logRun(env, started, null, 1, 'the files could not be sent', waitedMs);
        return 1;
      }
    }
  } finally {
    signingPassword?.fill(0);
    snapshot?.cleanup();
  }
}

/**
 * The computer a copy is on: the one its record here names, if that one still has it (or can't be asked), else
 * whichever says it has a copy on that port. The record can be out of date: a later start that moved the copy elsewhere
 * and was cut off before connecting never rewrote it. `{ machine }`, or `{ reason }` when none can be named.
 */
async function machineFor(env, port) {
  const config = readConfig(env);
  const state = readState(env, port);
  const named = state && config?.machines.find(entry => entry.host === state.host);
  if (named) {
    const look = await lookAt(named, port);
    if (look.copy || look.kept || !look.reachable) return { machine: named };
  }
  const machines = copyMachines(config).filter(machine => machine !== named);
  if (!machines.length && !named) return { reason: config ? 'every test machine is paused' : 'no test machines are set up' };
  const unreachable = [];
  for (const machine of machines) {
    const look = await lookAt(machine, port);
    if (look.copy || look.kept) return { machine };
    if (!look.reachable) unreachable.push(machine.label);
  }
  if (unreachable.length) return { reason: `${unreachable.join(' and ')} could not be reached to look for the copy on port ${port}` };
  return { reason: `no computer has a Harness copy on port ${port}`, none: true };
}

async function stop({ options, env, write }) {
  const place = await machineFor(env, options.port);
  if (!place.machine) {
    fs.rmSync(stateFile(env, options.port), { force: true });
    write(`dev-app: ${place.reason}${place.none ? ', so there was nothing to stop' : ''}.\n`);
    return place.none ? 0 : 1;
  }
  const { sent } = await sendScript(place.machine, `devapp-stop ${options.port}`);
  if (sent.code !== 0 || sent.timedOut) {
    write(`dev-app: ${place.machine.label} could not be reached. Its copy stops by itself within 4 hours, and the `
      + 'connection here closes when the link drops.\n');
    return 1;
  }
  fs.rmSync(stateFile(env, options.port), { force: true });
  fs.rmSync(path.join(stateDir(env), `${options.port}.tunnel.log`), { force: true });
  write(sent.stdout);
  if (!await waitForFreePort(options.port)) write(`dev-app: port ${options.port} is still in use here; something else may hold it.\n`);
  return 0;
}

async function shell({ options, env, write }) {
  const place = await machineFor(env, options.port);
  if (!place.machine) {
    write(`dev-app: ${place.reason}\n`);
    return 1;
  }
  const { script, sent } = await sendScript(place.machine, null);
  if (sent.code !== 0 || sent.timedOut) {
    write(`dev-app: ${place.machine.label} could not be reached\n`);
    return 1;
  }
  const ran = await sshCommand(place.machine, `bash ${script} devapp-shell ${options.port}`, {
    input: `${options.command.join(' ')}\n`, timeoutMs: SHELL_LIMIT_MS,
  });
  write(ran.stdout);
  if (ran.stderr) write(ran.stderr);
  if (ran.timedOut) write('dev-app: the command took over 10 minutes and was stopped\n');
  return ran.code;
}

/** The far script's answer, the last result line it printed, or null when it printed none. */
function resultOf(stdout) {
  const line = stdout.split('\n').filter(row => row.startsWith(RESULT_PREFIX)).pop();
  try {
    return line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : null;
  } catch {
    return null;
  }
}

/**
 * The PC (a computer with a Windows side) that has the copy on this port, for a worker's sake. A worker is only ever
 * made for a live copy, so `needCopy` refuses where none is found; a stop has no such need, as the copy may have gone.
 */
async function windowsMachineFor(env, port, needCopy, write) {
  const place = await machineFor(env, port);
  if (place.machine) {
    if (place.machine.platform === 'darwin') {
      write(`dev-app: the copy on port ${port} is on ${place.machine.label}, which has no Windows side. Start the copy with --pc.\n`);
      return null;
    }
    return place.machine;
  }
  if (needCopy || !place.none) {
    write(`dev-app: ${place.reason}${needCopy ? '; start the copy with --pc first' : ''}.\n`);
    return null;
  }
  const machine = copyMachines(readConfig(env), 'pc')[0];
  if (!machine) write('dev-app: no PC is set up, so there is no Windows worker to stop.\n');
  return machine ?? null;
}

/** One Runtime.evaluate over the copy's debugging port; its value, or an error text. */
function targetEvaluate(port, targetId, expression, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    const finish = (value) => {
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: 'the copy did not answer in time' }), timeoutMs);
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    } catch (error) {
      finish({ error: error.message });
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    socket.onerror = () => finish({ error: 'the connection to the copy failed' });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      finish(message.error || message.result?.exceptionDetails ? { error: message.error?.message ?? 'the copy raised an error' } : { value: message.result?.result?.value });
    };
  });
}

/** The first page of the copy behind the debugging port here, or null when it gives no list. */
function firstPageOf(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3_000 }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).find(target => target.type === 'page' && !String(target.url).startsWith('devtools://')) ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/**
 * A stopped worker's node stays in its copy's list of nodes: the copy keeps a record of every worker that signed in, and
 * lists it as disconnected until the record is revoked. A worker made for a check is revoked with its stop, so the copy
 * lists nothing of it. Says what happened, plainly; `ok` is false only when a copy that is there could not do it.
 */
async function revokeWorkerNode(port, nodeId, write) {
  const target = await firstPageOf(port);
  if (!target) {
    write(`dev-app: the copy on port ${port} does not answer, so there is no record of the worker's node ${nodeId} left to revoke.\n`);
    return { ok: true, revoked: false };
  }
  if (typeof WebSocket === 'undefined') {
    write(`dev-app: this Node has no WebSocket, so the worker's node ${nodeId} was not revoked in the copy: run electronAPI.remoteNodeRevokeNode('${nodeId}') in it.\n`);
    return { ok: false, revoked: false };
  }
  const id = JSON.stringify(nodeId);
  const done = await targetEvaluate(port, target.id, `(async () => {
    const api = window.electronAPI;
    if (!api || !api.remoteNodeRevokeNode || !api.remoteNodeList) return { error: 'the copy has no remote node controls' };
    const revoked = await api.remoteNodeRevokeNode(${id});
    if (!revoked || !revoked.success) return { error: 'the copy refused the revoke' };
    // The copy closes a dead worker's connection only after its own wait (about 30 seconds), and lists it until then.
    for (let tries = 0; ; tries += 1) {
      const listed = await api.remoteNodeList();
      if (!listed || !Array.isArray(listed.data)) return { error: 'the copy did not list its nodes' };
      if (!listed.data.some(row => row.id === ${id})) return { listed: false };
      if (tries >= ${REVOKE_WAIT_SECONDS}) return { listed: true };
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })()`, (REVOKE_WAIT_SECONDS + 15) * 1000);
  if (done.value && done.value.listed === false) {
    write(`dev-app: the worker's node ${nodeId} was revoked in the copy and is no longer listed.\n`);
    return { ok: true, revoked: true };
  }
  const why = done.error ?? done.value?.error ?? 'the node is still listed';
  write(`dev-app: the worker's node ${nodeId} could not be revoked in the copy (${why}): run electronAPI.remoteNodeRevokeNode('${nodeId}') in it.\n`);
  return { ok: false, revoked: false };
}

async function workerStart({ options, env, write, secretInput }) {
  const { port, coordinatorPort } = options;
  const machine = await windowsMachineFor(env, port, true, write);
  if (!machine) return 1;
  const token = await readSecretPipe(secretInput, 15_000, 'The pairing token');
  try {
    const { script, sent: placed } = await sendScript(machine, null);
    if (placed.code !== 0 || placed.timedOut) {
      write(`dev-app: ${machine.label} could not be reached\n`);
      return 1;
    }
    const started = new Date().toISOString();
    write(`dev-app: starting a disposable Windows worker on ${machine.label} for the copy on port ${port}\n`);
    // The pipe's own bytes, minus a trailing newline: the secret is never made into a string here.
    let end = token.length;
    while (end > 0 && [0x0a, 0x0d, 0x20].includes(token[end - 1])) end -= 1;
    const input = Buffer.concat([token.subarray(0, end), Buffer.from('\n')]);
    const ran = await sshCommand(machine, `bash ${script} devapp-worker-start ${port} ${coordinatorPort}`, { input, timeoutMs: WORKER_LIMIT_MS });
    input.fill(0);
    const result = resultOf(ran.stdout);
    if (ran.code !== 0 || ran.timedOut || !result) {
      // The far script cleans up after itself when it is cut off, but the line to it may be what failed, so ask again.
      const cleared = await stopRemoteWorker(machine, script, port);
      const clean = cleared?.status === 'stopped' && cleared.processGone === true && cleared.folderGone === true;
      write(`dev-app: the worker's start on ${machine.label} gave no answer${ran.timedOut ? ' in time' : ''}. `
        + (clean ? 'What it left was removed.\n'
          : `Its clean-up could not be confirmed: run worker-stop --port ${port}. If ${machine.label} stays unreachable it is removed when the copy stops.\n`));
      if (cleared?.nodeId) await revokeWorkerNode(port, cleared.nodeId, write);
      return 1;
    }
    if (result.status !== 'ready') {
      write(`dev-app: the Windows worker did not start: ${result.reason}${result.folderGone === false || result.processGone === false ? ' (its clean-up could not be confirmed: run worker-stop)' : ''}\n`);
      if (result.nodeId) await revokeWorkerNode(port, result.nodeId, write);
      return 1;
    }
    write(`dev-app: the Windows worker "${result.name}" (node ${result.nodeId}) is connected to the copy on port ${port}. Its workspace `
      + `is ${result.workspace}. Stop it with: node ${__filename} worker-stop --port ${port}\n`);
    write(`AIO_DEV_APP_WORKER_RECEIPT ${JSON.stringify({
      computer: computerName(machine), port, startedAt: started, joined: result.joined, nodeId: result.nodeId, name: result.name,
      workspace: result.workspace, folder: result.folder,
    })}\n`);
    return 0;
  } finally {
    token.fill(0);
  }
}

/**
 * Asks the far script to stop a port's worker and remove its folder; its answer, or null when there was none. A start
 * that was just cut off is still being undone there and holds the worker's lock, so a "busy" answer is asked again.
 */
async function stopRemoteWorker(machine, script, port) {
  for (let attempt = 1; ; attempt += 1) {
    const ran = await sshCommand(machine, `bash ${script} devapp-worker-stop ${port}`, { timeoutMs: WORKER_LIMIT_MS });
    const result = ran.code !== 0 || ran.timedOut ? null : resultOf(ran.stdout);
    if (result?.status !== 'busy' || attempt >= WORKER_STOP_ATTEMPTS) return result;
    await sleep(WORKER_STOP_PAUSE_MS);
  }
}

async function workerStop({ options, env, write }) {
  const machine = await windowsMachineFor(env, options.port, false, write);
  if (!machine) return 1;
  const { script, sent: placed } = await sendScript(machine, null);
  if (placed.code !== 0 || placed.timedOut) {
    write(`dev-app: ${machine.label} could not be reached. The worker stops by itself when its copy does, within 4 hours.\n`);
    return 1;
  }
  const result = await stopRemoteWorker(machine, script, options.port);
  if (!result) {
    write(`dev-app: ${machine.label} gave no answer to the stop. Look with: node ${__filename} status\n`);
    return 1;
  }
  if (result.status === 'none') {
    write(`AIO_DEV_APP_WORKER_RECEIPT ${JSON.stringify({ computer: computerName(machine), port: options.port, ...result })}\n`);
    write(`dev-app: ${result.reason}.\n`);
    return 0;
  }
  const clean = result.status === 'stopped' && result.processGone === true && result.folderGone === true;
  write(clean ? `dev-app: the Windows worker for port ${options.port} is stopped and its folder removed.\n`
    : `dev-app: the Windows worker for port ${options.port} could not be confirmed gone (${result.reason ?? 'see the receipt above'}).\n`);
  const revoked = result.nodeId ? await revokeWorkerNode(options.port, result.nodeId, write) : { ok: true, revoked: false };
  write(`AIO_DEV_APP_WORKER_RECEIPT ${JSON.stringify({ computer: computerName(machine), port: options.port, ...result, nodeRevoked: revoked.revoked })}\n`);
  return clean && revoked.ok ? 0 : 1;
}

async function status({ env, write }) {
  const config = readConfig(env);
  const machines = copyMachines(config);
  if (!machines.length) {
    write(`dev-app: ${config ? 'every test machine is paused' : 'no test machines are set up'}\n`);
    return 1;
  }
  let code = 0;
  for (const machine of machines) {
    const { sent } = await sendScript(machine, 'devapp-status');
    if (sent.code !== 0 || sent.timedOut) {
      write(`dev-app: ${machine.label} could not be reached\n`);
      code = 1;
    } else {
      write(`On ${machine.label}:\n${sent.stdout}`);
    }
  }
  return code;
}

/**
 * Fills the copy on `port` with fixtures (see dev-app-seed.js). Only a copy this runner started has a record here, so the
 * port is a tunnel to a copy of this runner's. The first-run flag needs a reload, so it is set first; then the fill is
 * repeated until the screens that exist have taken what they hold, since the sessions' screen appears only once the AI
 * tool list has been filled.
 */
async function seed({ options, env, write, evaluate }) {
  if (!readState(env, options.port)) {
    write(`dev-app: no copy started by this runner is on port ${options.port}. Start one first.\n`);
    return 1;
  }
  const run = async (stage) => JSON.parse(await evaluate(options.port, seedExpression(stage)));
  const applied = [];
  let last;
  try {
    const prepared = await run('prepare');
    if (prepared.error) throw new Error(prepared.error);
    applied.push(...prepared.applied);
    await sleep(Math.min(3_000, recheckMs(env)));
    const deadline = Date.now() + SEED_WAIT_MS;
    for (;;) {
      last = await run('fill').catch(() => null);
      if (last?.error) throw new Error(last.error);
      if (last) applied.push(...last.applied);
      // The two screens' fixtures wait for those screens to be opened; the rest settle by themselves.
      const settling = (last?.waiting ?? ['the screens']).filter(what => !what.startsWith('open '));
      if (!settling.length) break;
      if (Date.now() >= deadline) throw new Error(`still waiting for: ${settling.join(', ')}`);
      await sleep(Math.min(1_000, recheckMs(env)));
    }
  } catch (err) {
    write(`dev-app: could not fill the copy's screens: ${err.message}\n`);
    return 1;
  }
  for (const what of applied) write(`dev-app: filled: ${what}\n`);
  for (const what of last.waiting) write(`dev-app: not yet filled: ${what}; run seed again once it is open\n`);
  return 0;
}

/**
 * Resolves with the exit code. `commonDir` (the Harness repository's git folder), `answers` (whether a debugging port
 * answers), `localLoad` (this Mac's load) and `secretInput` (where a pairing token is piped in) are only ever different
 * in tests.
 */
async function main(argv, {
  cwd = process.cwd(), env = process.env, write = text => process.stdout.write(text),
  commonDir = gitPath(__dirname, '--git-common-dir'), answers = answersOnPort, localLoad = thisMacLoad, evaluate = cdpEvaluate,
  secretInput = process.stdin,
} = {}) {
  try {
    const { action, options } = parse(argv);
    if (action === 'help') {
      write(`${USAGE}\n`);
      return 0;
    }
    if (action === 'status') return await status({ env, write });
    if (action === 'stop') return await stop({ options, env, write });
    if (action === 'shell') return await shell({ options, env, write });
    if (action === 'worker-start') return await workerStart({ options, env, write, secretInput });
    if (action === 'worker-stop') return await workerStop({ options, env, write });
    if (action === 'seed') return await seed({ options, env, write, evaluate });
    const root = harnessRoot(cwd, commonDir);
    if (!root) throw new UsageError('run it from inside a Harness checkout (the main checkout or a queue worktree)');
    return await start({ options, root, env, write, answers, evaluate, localLoad });
  } catch (err) {
    if (err instanceof UsageError) {
      write(`dev-app: ${err.message}\n`);
      return USAGE_ERROR;
    }
    throw err;
  }
}

if (require.main === module) {
  // exitCode, not exit(): a long log can be more than a pipe holds, and exit() would cut it off.
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`dev-app: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { main, parse, readSecretPipe };
