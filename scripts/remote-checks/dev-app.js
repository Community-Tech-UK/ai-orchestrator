#!/usr/bin/env node
'use strict';
/**
 * A live test's Harness copy, on the test Mac instead of this one. The agent stays here; the install, the builds, the
 * screens' server and Harness itself run on the first Mac in the remote checks config. A tunnel then carries this Mac's
 * debugging port to the copy's, so the agent drives it over CDP at http://127.0.0.1:<port> exactly as it would a copy
 * started here. The tunnel closes by itself when the copy stops.
 *
 *   node <Harness checkout>/scripts/remote-checks/dev-app.js start --port <debugging port> --data /tmp/aio-lt-<name>
 *   node .../dev-app.js shell --port <debugging port> '<command>'   # runs beside the copy, its data folder in
 *                                                                    # AIO_DEV_USER_DATA_PATH
 *   node .../dev-app.js stop --port <debugging port>
 *   node .../dev-app.js status
 *
 * Run it from inside the checkout being tested; the files on disk go, uncommitted ones included. Exits 0 when done, 1
 * when the copy failed to build or start (its output says why), 2 for a usage mistake, 75 when the test Mac can't take
 * it and the copy may start here instead, and 69 (`Not run`) when it can't and this Mac is switched off for test work.
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { NOT_RUN, appendRunLog, isLoopRun, readConfig, remoteChecksDir } = require('./route');
const { SSH_OPTIONS, sendScript, sendSnapshot, sshCommand } = require('./run-remote');
const { SnapshotRefused, cleanGitEnv, takeSnapshot } = require('./snapshot');

const STAY_HERE = 75;
const USAGE_ERROR = 2;
const RESULT_PREFIX = 'AIO_REMOTE_RESULT ';
/** Covers a first install of every package, both builds and Harness starting. */
const START_LIMIT_MS = 25 * 60_000;
const SHELL_LIMIT_MS = 10 * 60_000;
const TUNNEL_WAIT_MS = 20_000;
const PORT_FREE_WAIT_MS = 15_000;
const ANSWER_WAIT_MS = 15_000;
const DATA_FOLDER = /^\/tmp\/aio-lt-[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;

const USAGE = `dev-app: a live test's Harness copy, run on the test Mac and driven from here.

  start --port <debugging port> --data /tmp/aio-lt-<name>
      Sends this checkout's files, builds and starts Harness on the test Mac, and connects
      http://127.0.0.1:<port> here to it. Takes a few minutes, longer after a package change. Running it again with
      the same files joins the copy already starting or running.
  shell --port <debugging port> '<command>'
      Runs a shell command in the copy's checkout on the test Mac, with its data folder in AIO_DEV_USER_DATA_PATH.
  stop --port <debugging port>
      Stops the copy and closes the connection.
  status
      Lists the copies on the test Mac.`;

class UsageError extends Error {}

function parse(argv) {
  const [action, ...rest] = argv;
  if (!action || ['help', '--help', '-h'].includes(action)) return { action: 'help' };
  if (!['start', 'stop', 'shell', 'status'].includes(action)) throw new UsageError(`there is no dev-app ${action}`);
  const options = { port: null, data: null, command: [] };
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (arg === '--port' || arg === '--data') {
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
  return { action, options };
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

/** `{ config, machine }`, or `{ config, reason }` when no test Mac can take it. `config` is null when none is set up. */
function findTestMac(env) {
  const config = readConfig(env);
  if (!config) return { config, reason: 'no test machines are set up' };
  const machine = config.machines.find(entry => entry.platform === 'darwin');
  if (!machine) return { config, reason: 'no test Mac is in the test machine list' };
  if (machine.paused) return { config, reason: `${machine.label} is paused` };
  return { config, machine };
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
    child.stdin.end(data);
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

/** The test Mac couldn't take the copy: start it here when this Mac takes test work, otherwise it is not run. */
function away(config, reason, write) {
  if (!config || config.useThisMac) {
    write(`dev-app: ${reason}. Start Harness on this Mac instead, as the live-test runbook's "On this Mac" part says.\n`);
    return STAY_HERE;
  }
  write(`Not run: ${reason}, and this Mac is switched off for test work. Try again in a few minutes; if it still can't, `
    + 'record the checks that need Harness as waiting for the test Mac.\n');
  return NOT_RUN;
}

function logRun(env, started, machine, exitCode, reason) {
  appendRunLog({
    at: new Date(started).toISOString(), project: 'ai-orchestrator', kind: 'dev-app', loop: isLoopRun(env),
    ranOn: exitCode === NOT_RUN || exitCode === STAY_HERE ? 'none' : machine?.host ?? 'none', waitedMs: 0,
    tookMs: Date.now() - started, exitCode, fellBackBecause: reason ?? null,
  }, env);
}

async function start({ options, root, env, write, answers }) {
  const { port, data } = options;
  const started = Date.now();
  const place = findTestMac(env);
  if (!place.machine) {
    const code = away(place.config, place.reason, write);
    logRun(env, started, null, code, place.reason);
    return code;
  }
  const { config, machine } = place;
  const leave = (reason) => {
    const code = away(config, reason, write);
    logRun(env, started, machine, code, reason);
    return code;
  };
  // The port here may only be held by this checkout's own earlier copy's tunnel, which this start reuses or replaces.
  // Held by anything else, it is someone else's, and nothing is sent.
  const previous = readState(env, port);
  const ours = previous?.root === root && previous.host === machine.host && isRunning(previous.tunnelPid);
  if (!ours && !await portIsFree(port)) {
    write(`dev-app: port ${port} is in use on this Mac, perhaps by a copy started here or another live test. Use the `
      + 'port you were given, or stop that copy first.\n');
    logRun(env, started, machine, 1, 'the port was in use here');
    return 1;
  }

  let snapshot;
  try {
    snapshot = takeSnapshot(root);
  } catch (err) {
    if (!(err instanceof SnapshotRefused)) throw err;
    write(`dev-app: this checkout's files can't be sent: ${err.message}\n`);
    return 1;
  }
  try {
    const { script, sent } = await sendScript(machine, 'bases');
    if (sent.code !== 0 || sent.timedOut) return leave(`${machine.label} could not be reached`);
    write(`dev-app: sending this checkout to ${machine.label}\n`);
    const fault = await sendSnapshot(root, snapshot, machine, script, sent.stdout.split('\n').filter(Boolean), '');
    if (fault) return leave(fault);

    const result = await streamStart(machine, `bash ${script} devapp-start ${port} ${snapshot.commit}`, data, write);
    if (!result) {
      write(`dev-app: the connection to ${machine.label} was lost while Harness started. Run the same command again: `
        + 'it joins the copy if it is still starting.\n');
      logRun(env, started, machine, 1, 'the connection was lost');
      return 1;
    }
    if (result.status === 'busy') return leave(result.reason);
    if (result.status === 'taken') {
      write(`dev-app: ${result.reason}, for another data folder, so it was left alone. Use the port you were given.\n`);
      logRun(env, started, machine, 1, result.reason);
      return 1;
    }
    if (result.status !== 'ready') {
      write(`dev-app: Harness did not start on ${machine.label}: ${result.reason}. What it printed is above.\n`);
      logRun(env, started, machine, 1, result.reason);
      return 1;
    }

    // A copy joined from this checkout's earlier start may still have its tunnel here.
    const joined = ours && previous.tree === snapshot.tree && await answers(port, 2_000);
    // Written as soon as the tunnel exists, so a start cut off after this point can be run again and reuse it.
    const remember = tunnelPid => fs.writeFileSync(stateFile(env, port), `${JSON.stringify({
      host: machine.host, label: machine.label, port, data, root, tree: snapshot.tree, tunnelPid,
      startedAt: new Date(started).toISOString(),
    })}\n`);
    if (!joined) {
      if (!await waitForFreePort(port)) {
        write(`dev-app: port ${port} is in use on this Mac, perhaps by a copy started here. Stop that, then run this again.\n`);
        await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
        logRun(env, started, machine, 1, 'the port was in use here');
        return 1;
      }
      const tunnelPid = await openTunnel(machine, script, port, env);
      if (tunnelPid) remember(tunnelPid);
      if (!tunnelPid || !await answers(port)) {
        write(`dev-app: Harness started on ${machine.label}, but the connection to it from here did not work. `
          + `See ${path.join(stateDir(env), `${port}.tunnel.log`)}.\n`);
        await sshCommand(machine, `bash ${script} devapp-stop ${port}`);
        fs.rmSync(stateFile(env, port), { force: true });
        logRun(env, started, machine, 1, 'the tunnel did not open');
        return 1;
      }
    }
    if (joined) remember(previous.tunnelPid);
    logRun(env, started, machine, 0, null);
    write(`dev-app: Harness is running on ${machine.label}, reached here at http://127.0.0.1:${port} (CDP). Its data `
      + `folder there is ${data}; read it with dev-app shell. Stop it with: node ${__filename} stop --port ${port}\n`);
    return 0;
  } finally {
    snapshot.cleanup();
  }
}

/** The machine a copy was started on, or the test Mac now. */
function machineFor(env, port) {
  const state = readState(env, port);
  const place = findTestMac(env);
  const named = state && place.config?.machines.find(entry => entry.host === state.host);
  return named ? { machine: named } : place;
}

async function stop({ options, env, write }) {
  const place = machineFor(env, options.port);
  if (!place.machine) {
    write(`dev-app: ${place.reason}, so nothing could be stopped there.\n`);
    return 1;
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
  const place = machineFor(env, options.port);
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

async function status({ env, write }) {
  const place = findTestMac(env);
  if (!place.machine) {
    write(`dev-app: ${place.reason}\n`);
    return 1;
  }
  const { sent } = await sendScript(place.machine, 'devapp-status');
  if (sent.code !== 0 || sent.timedOut) {
    write(`dev-app: ${place.machine.label} could not be reached\n`);
    return 1;
  }
  write(`On ${place.machine.label}:\n${sent.stdout}`);
  return 0;
}

/**
 * Resolves with the exit code. `commonDir` (the Harness repository's git folder) and `answers` (whether a debugging
 * port answers) are only ever different in tests.
 */
async function main(argv, {
  cwd = process.cwd(), env = process.env, write = text => process.stdout.write(text),
  commonDir = gitPath(__dirname, '--git-common-dir'), answers = answersOnPort,
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
    const root = harnessRoot(cwd, commonDir);
    if (!root) throw new UsageError('run it from inside a Harness checkout (the main checkout or a queue worktree)');
    return await start({ options, root, env, write, answers });
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

module.exports = { main, parse };
