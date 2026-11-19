#!/usr/bin/env node
'use strict';
/**
 * The Windows half of a live-test copy that runs on the PC's own desktop (`dev-app.js start --windows`). The PC's SSH
 * door opens in its Linux space, so remote-run.sh stays in charge there and calls this file through Windows' own Node
 * (`node.exe`, reached by WSL interop) for everything that must happen in Windows: the install, the builds, Harness
 * itself, the screens' server and the stop. Paths are Windows paths. It is copied into the copy's folder from the
 * snapshot at the start, so it is the version being tested.
 *
 *   install <install folder>                 npm ci in <install folder>\repo, then writes <install folder>\done
 *   build <copy folder> <install folder>     links the install's packages and builds the main process, the orchestrator
 *                                            tools helper and the screens
 *   start <copy folder> <data folder> <port> <tree> [relay host]
 *                                            owns the profile (live-test-copy.js), serves the screens, opens Harness in
 *                                            live-test mode with its debugging port and records them
 *   ready <port> <copy folder>               exits 0 once Harness's window exists and Harness's own receipt, checked
 *                                            against the ownership record, says it is ready; prints that receipt
 *   pids <copy folder>                       the recorded Harness process id if it is still running
 *   stop <copy folder>                       stops what `start` recorded, each only if it is still this copy's
 *   remove <copy folder>                     unlinks the packages and deletes the folder
 *   relay <listen host> <port> <host> <port> forwards one TCP port to another; never a wildcard address
 *   serve <folder> <port file>               the screens' server (the same one remote-run.sh uses on Linux)
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const RECORD = 'windows-copy.json';
const SERVE_WAIT_MS = 30_000;
const NPM_ATTEMPTS = 3;

class Refused extends Error {}

/** Loopback and private-network addresses only: a copy's debugging port must never be offered to a wider network. */
function isPrivateAddress(host) {
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Refused('the port must be a number from 1024 to 65535');
  return port;
}

function npmCli() {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) throw new Refused(`npm was not found beside ${process.execPath}`);
  return cli;
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Runs `node <args>` in `cwd`, its output going to `log`. Resolves with the exit code. */
function runNode(args, { cwd, log, env = {}, unset = [] }) {
  return new Promise((resolve) => {
    const out = fs.openSync(log, 'a');
    const inherited = { ...process.env };
    for (const name of unset) delete inherited[name];
    const child = spawn(process.execPath, args, { cwd, env: { ...inherited, ...env }, stdio: ['ignore', out, out] });
    child.on('error', () => resolve(1));
    child.on('close', (code) => { fs.closeSync(out); resolve(code ?? 1); });
  });
}

async function install(folder) {
  const repo = path.join(folder, 'repo');
  const log = path.join(folder, 'install.log');
  // Three tries, then one more that lets @electron/get fall back to Electron's own release address when the mirror is
  // the trouble, as scripts/ci-npm-ci.sh does.
  for (let at = 0; at <= NPM_ATTEMPTS; at += 1) {
    const code = await runNode([npmCli(), 'ci'], { cwd: repo, log, unset: at === NPM_ATTEMPTS ? ['ELECTRON_MIRROR'] : [] });
    if (code === 0) {
      fs.writeFileSync(path.join(folder, 'done'), '');
      return 0;
    }
    if (at < NPM_ATTEMPTS - 1) await new Promise(resolve => setTimeout(resolve, (at + 1) * 10_000));
  }
  process.stdout.write(`${tail(log, 30)}\n`);
  return 1;
}

async function build(copy, installFolder) {
  const repo = path.join(copy, 'repo');
  const packages = path.join(repo, 'node_modules');
  fs.rmSync(packages, { force: true, recursive: false });
  // A junction needs no privilege, unlike a symbolic link, and shares one install between copies.
  fs.symlinkSync(path.join(installFolder, 'repo', 'node_modules'), packages, 'junction');
  const steps = [
    ['the main process', 'build.log', [npmCli(), 'run', 'build:main']],
    // After build:main, which clears dist/. Without this helper the copy's sessions get no orchestrator tools (LT-1103).
    ['the orchestrator tools helper', 'aio-mcp.log', [npmCli(), 'run', 'build:aio-mcp-dist']],
    ['the screens', 'renderer.log', [path.join(packages, '@angular', 'cli', 'bin', 'ng.js'), 'build', '--configuration',
      'development', '--output-path', path.join(copy, 'renderer')]],
  ];
  for (const [what, logName, args] of steps) {
    process.stdout.write(`[dev app] building ${what}\n`);
    const log = path.join(copy, logName);
    if (await runNode(args, { cwd: repo, log, env: { NG_CLI_ANALYTICS: 'false' } }) !== 0) {
      process.stdout.write(`${tail(log)}\nbuilding ${what} failed\n`);
      return 1;
    }
  }
  return 0;
}

/** The screens' server: serves the built screens, sending index.html for any path that names no file. */
function serve(folder, portFile) {
  const root = path.resolve(folder);
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  };
  const fileFor = (url) => {
    let name;
    try { name = decodeURIComponent(new URL(url, 'http://localhost').pathname); } catch { return path.join(root, 'index.html'); }
    const file = path.resolve(root, `.${name}`);
    const found = file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
    return found ? file : path.join(root, 'index.html');
  };
  const server = http.createServer((request, response) => {
    const file = fileFor(request.url || '/');
    fs.readFile(file, (err, body) => {
      if (err) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(`${portFile}.tmp`, `${server.address().port}\n`);
    fs.renameSync(`${portFile}.tmp`, portFile);
  });
}

function relay(listenHost, listenPort, targetHost, targetPort) {
  if (!isPrivateAddress(listenHost) || !isPrivateAddress(targetHost)) {
    throw new Refused('a relay joins loopback or private-network addresses only, never a wildcard');
  }
  const server = net.createServer((client) => {
    const upstream = net.connect(requirePort(targetPort), targetHost);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(requirePort(listenPort), listenHost);
}

function readRecord(copy) {
  try {
    return JSON.parse(fs.readFileSync(path.join(copy, RECORD), 'utf8'));
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function commandLineOf(pid) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout: 20_000 });
  } catch {
    return '';
  }
}

/** Opens a program of the copy's apart from this command, its output in the copy's folder. */
function launch(copy, name, file, args, env) {
  const out = fs.openSync(path.join(copy, `${name}.out`), 'a');
  const err = fs.openSync(path.join(copy, `${name}.err`), 'a');
  const child = spawn(file, args, { cwd: path.join(copy, 'repo'), env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, err] });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  return child.pid;
}

/** The shared ownership helper, from the copy's own snapshot: this file is copied out of the repo on its own. */
function liveTestCopy(copy) {
  return require(path.join(copy, 'repo', 'scripts', 'remote-checks', 'live-test-copy.js'));
}

async function start(copy, data, port, tree, relayHost) {
  requirePort(port);
  const electron = path.join(copy, 'repo', 'node_modules', 'electron', 'dist', 'electron.exe');
  // Writes the ownership record and the profile's marker. Harness starts in live-test mode only with all three of the
  // variables below, and refuses to start if the record, the profile or this executable does not match (live-test-context.ts).
  liveTestCopy(copy).prepareOwner({ root: copy, data, executablePath: electron, mode: 'dev', tree, port: Number(port) });
  const portFile = path.join(copy, 'renderer-port');
  fs.rmSync(portFile, { force: true });
  const record = { copy, port, startedAt: new Date().toISOString() };
  record.server = launch(copy, 'serve', process.execPath, [path.join(copy, 'windows-copy.js'), 'serve', path.join(copy, 'renderer', 'browser'), portFile], {});
  fs.writeFileSync(path.join(copy, RECORD), JSON.stringify(record));
  const deadline = Date.now() + SERVE_WAIT_MS;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Refused('the screens server did not start');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const rendererPort = fs.readFileSync(portFile, 'utf8').trim();
  // Without the heap flag Harness would start itself again under another process id (src/main/main-process-bootstrap.ts).
  record.electron = launch(copy, 'app', electron, ['--js-flags=--max-old-space-size=8192', path.join(copy, 'repo'), `--remote-debugging-port=${port}`], {
    AIO_DEV_USER_DATA_PATH: data, PORT: rendererPort,
    AIO_LIVETEST: '1', AIO_LIVETEST_USER_DATA_PATH: data, AIO_LIVETEST_OWNER_FILE: path.join(copy, 'livetest-owner.json'),
  });
  // The debugging port listens on this computer's loopback only. WSL can't reach that, so a relay offers it on the
  // address the Linux space reaches this computer by, which belongs to the virtual network between the two.
  if (relayHost) {
    record.relay = launch(copy, 'relay', process.execPath, [path.join(copy, 'windows-copy.js'), 'relay', relayHost, String(port), '127.0.0.1', String(port)], {});
  }
  fs.writeFileSync(path.join(copy, RECORD), JSON.stringify(record));
  return 0;
}

/** Resolves `{ ready, why }`: ready once the debugging port lists Harness's window as a page; `why` says what was seen. */
function ready(port) {
  requirePort(port);
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const page = response.statusCode === 200 && /"type":\s*"page"/.test(body);
        resolve({ ready: page, why: page ? 'ready' : `the port answered ${response.statusCode} but lists no window yet` });
      });
    });
    request.on('timeout', () => request.destroy(new Error('the port did not answer within 3 seconds')));
    request.on('error', err => resolve({ ready: false, why: `nothing answered on the port (${err.code ?? err.message})` }));
  });
}

function stop(copy) {
  const record = readRecord(copy);
  if (!record) return 0;
  for (const name of ['relay', 'electron', 'server']) {
    const pid = record[name];
    if (!isRunning(pid)) continue;
    // A recorded id may by now be another program's: only one whose command line names this copy's folder goes.
    if (!commandLineOf(pid).toLowerCase().includes(copy.toLowerCase())) continue;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20_000 });
    } catch {
      /* it may have exited meanwhile; `pids` says whether anything is left */
    }
  }
  return 0;
}

function remove(copy) {
  // The packages are a junction into a shared install: unlink it first, so nothing below follows it. A junction goes
  // with rmdir on Windows; a symbolic link (anywhere else) with unlink.
  const packages = path.join(copy, 'repo', 'node_modules');
  try {
    if (fs.lstatSync(packages).isSymbolicLink()) {
      try { fs.rmdirSync(packages); } catch { fs.unlinkSync(packages); }
    }
  } catch {
    /* none linked */
  }
  if (fs.existsSync(packages) && fs.lstatSync(packages).isSymbolicLink()) throw new Refused('the packages link could not be unlinked, so nothing was deleted');
  fs.rmSync(copy, { recursive: true, force: true });
  return 0;
}

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'install': return install(args[0]);
    case 'build': return build(args[0], args[1]);
    case 'start': return start(args[0], args[1], args[2], args[3], args[4]);
    case 'ready': {
      const seen = await ready(args[0]);
      if (!seen.ready) { process.stderr.write(`${seen.why}\n`); return 1; }
      // Harness's own receipt, which names its real process, executable, profile and snapshot; only now is it ready.
      let runtime;
      try {
        runtime = liveTestCopy(args[1]).readRuntime(args[1]);
      } catch (err) {
        process.stderr.write(`the window is open but Harness has not reported itself ready as the owned copy (${err.message})\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ ...runtime, platform: process.platform })}\n`);
      return 0;
    }
    case 'pids': {
      const record = readRecord(args[0]);
      if (record && isRunning(record.electron)) process.stdout.write(`${record.electron}\n`);
      return 0;
    }
    case 'stop': return stop(args[0]);
    case 'remove': return remove(args[0]);
    case 'relay': relay(args[0], args[1], args[2], args[3]); return null;
    case 'serve': serve(args[0], args[1]); return null;
    default: throw new Refused('unknown windows-copy command');
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== null) process.exitCode = code; },
    (err) => {
      process.stderr.write(`windows-copy: ${err instanceof Refused ? err.message : err.stack}\n`);
      process.exitCode = err instanceof Refused ? 2 : 1;
    },
  );
}

module.exports = { isPrivateAddress, main, relay, requirePort };
