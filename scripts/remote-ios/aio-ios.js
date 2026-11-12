#!/usr/bin/env node
'use strict';
/**
 * iPhone builds and simulator work on the test Mac, so Xcode, the simulator and Maestro don't load this one. It sends
 * the app's files on disk, uncommitted ones included, as a git pack (scripts/remote-checks/snapshot.js), runs the job
 * there with scripts/remote-ios/remote-ios.sh, streams what it prints, and brings back logs, screenshots and reports
 * into the repository's _scratch/aio-ios/<run>/.
 *
 * Exits with the job's own code: xcodebuild's, Maestro's or simctl's. 75 means the test Mac couldn't do the job, which
 * it then remembers for a while so the usual commands run on this Mac instead (see redirect.js). 2 is a usage mistake.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findApp, neverSent } = require('./apps');
const { SimArgsRefused, mapSimArgs } = require('./sim-args');
const { findTestMac, markUnusable, markUsable } = require('./test-mac');
const { appendRunLog, isLoopRun } = require('../remote-checks/route');
const { sendSnapshot, sshCommand } = require('../remote-checks/run-remote');
const { SnapshotRefused, cleanGitEnv, takeSnapshot } = require('../remote-checks/snapshot');

const MACHINE_AWAY = 75;
const USAGE_ERROR = 2;
const RESULT_PREFIX = 'AIO_IOS_RESULT ';
/** Stages at which the test Mac itself failed, rather than the app or the queue, so the usual commands run here for a while. */
const MACHINE_STAGES = new Set(['checkout', 'simulator', 'maestro', 'screenshot', 'build', 'xcodebuild']);
/** A little over the test Mac's own limit, for a job that goes quiet without the connection dropping. */
const JOB_LIMIT_MS = 92 * 60_000;

const USAGE = `aio-ios: iPhone builds and simulator work, on the test Mac. Run it inside the app's repository.

  aio-ios build [--app <name>]
      Build the app for the simulator.
  aio-ios run [--app <name>] [--fresh] [--wait <seconds>]
      Build, install and launch it, then take a screenshot once the screen stops changing (up to 30 seconds). A blank
      screen also stops changing: if the screenshot is blank, the app may still be starting, so take another with
      aio-ios sim io booted screenshot <file>.
  aio-ios test [--app <name>] [--fresh] [--env NAME=VALUE ...] <Maestro flow files or folders...>
      Build, install and run the flows. Flows get \${APP_ID}, and each --env, as Maestro's -e gives them.
  aio-ios sim [--seconds <n>] <the arguments xcrun simctl takes>
      For example: aio-ios sim io booted screenshot shot.png, aio-ios sim openurl booted https://...,
      aio-ios sim push booted <bundle id> payload.apns, aio-ios sim privacy booted grant photos <bundle id>.
      Files you name are sent or copied back. recordVideo records for --seconds (default 10).
  aio-ios logs [--app <name>] [--seconds <n>]
      The app's log for n seconds (default 30).
  aio-ios status       What your session holds on the test Mac.
  aio-ios stop         End your jobs there and free your simulator.

--fresh uninstalls the app first, so it starts with no saved data. Your simulator stays yours until aio-ios stop, or
30 minutes with nothing run. Logs, screenshots and reports land in _scratch/aio-ios/<run>/.
App Store builds (archive, export, upload) stay on this Mac. AIO_IOS_LOCAL=1 runs xcodebuild, xcrun simctl and
maestro on this Mac when James asks for that.`;

const OPTIONS = {
  build: ['--app'],
  run: ['--app', '--fresh', '--wait'],
  test: ['--app', '--fresh', '--env'],
  sim: ['--seconds'],
  logs: ['--app', '--seconds'],
  status: [],
  stop: [],
};

class UsageError extends Error {}

function seconds(value, flag, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new UsageError(`${flag} takes a whole number of seconds from 1 to ${max}`);
  return number;
}

/** Options come straight after the command. For `sim`, everything after them is simctl's. */
function parse(argv) {
  const [action, ...rest] = argv;
  if (!action || action === 'help' || action === '--help' || action === '-h') return { action: 'help' };
  if (!OPTIONS[action]) throw new UsageError(`there is no aio-ios ${action}`);
  const options = { app: null, fresh: false, waitSeconds: 30, seconds: null, env: [] };
  let at = 0;
  while (at < rest.length && OPTIONS[action].includes(rest[at])) {
    const flag = rest[at];
    if (flag === '--fresh') {
      options.fresh = true;
      at += 1;
      continue;
    }
    const value = rest[at + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === '--app') options.app = value;
    if (flag === '--env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new UsageError('--env takes NAME=VALUE');
      options.env.push(value);
    }
    if (flag === '--wait') options.waitSeconds = seconds(value, flag, 300);
    if (flag === '--seconds') options.seconds = seconds(value, flag, 600);
    at += 2;
  }
  const args = rest.slice(at);
  if (action === 'test' && !args.length) throw new UsageError('aio-ios test needs at least one Maestro flow file or folder');
  if (action === 'sim' && !args.length) throw new UsageError('aio-ios sim needs the arguments xcrun simctl would take');
  if (!['test', 'sim'].includes(action) && args.length) throw new UsageError(`aio-ios ${action} doesn't take ${args[0]}`);
  return { action, options, args };
}

/** The Harness session, which owns a simulator on the test Mac. A person in Terminal is one session of their own. */
function sessionName(env) {
  const raw = env.AI_ORCHESTRATOR_INSTANCE_ID || 'terminal';
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'terminal';
}

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Shell-quoted, for recipe.sh. */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** What remote-ios.sh sources: the app's recipe and this job's settings. */
function recipeText(app, { commit, options }) {
  const lines = [
    `APP=${quote(app?.id ?? '')}`,
    `COMMIT=${quote(commit ?? '')}`,
    `FRESH_INSTALL=${options.fresh ? 1 : 0}`,
    `SETTLE_SECONDS=${options.waitSeconds}`,
    `LOG_SECONDS=${options.seconds ?? 30}`,
    `VIDEO_SECONDS=${options.seconds ?? 10}`,
  ];
  if (app) {
    const kind = app.xcode.workspace ? 'workspace' : 'project';
    lines.push(
      `APP_DIR=${quote(app.folder)}`,
      `XCODE_KIND=${kind}`,
      `XCODE_PATH=${quote(app.xcode[kind])}`,
      `SCHEME=${quote(app.scheme)}`,
      `BUNDLE_ID=${quote(app.bundleId)}`,
      `NODE_FILE=${quote(app.nodeFile ?? '')}`,
      `NODE_VERSION=${quote(app.nodeVersion ?? '')}`,
      `INSTALL_INPUTS=${quote(app.installInputs.join(' '))}`,
      `recipe_install() {\n${app.install}\n}`,
      `recipe_web() {\n${app.web}\n}`,
      `recipe_sync() {\n${app.sync}\n}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** NUL after each item, which `read -d ''` in remote-ios.sh needs, the last one included. */
function nulList(items) {
  return items.map(item => `${item}\0`).join('');
}

function writeRequest(dir, { app, commit, options, sim, flows }) {
  fs.writeFileSync(path.join(dir, 'recipe.sh'), recipeText(app, { commit, options }));
  if (sim) {
    fs.writeFileSync(path.join(dir, 'args'), nulList(sim.remoteArgs));
    fs.mkdirSync(path.join(dir, 'files'));
    for (const input of sim.inputs) fs.copyFileSync(input.local, path.join(dir, 'files', input.name));
  }
  if (flows) {
    fs.writeFileSync(path.join(dir, 'flows'), nulList(flows));
    fs.writeFileSync(path.join(dir, 'flow-env'), nulList(options.env));
  }
}

/** Flow paths relative to the repository, as the test Mac's checkout has them. */
function flowPaths(args, cwd, root) {
  return args.map((given) => {
    const local = path.resolve(cwd, given);
    const relative = path.relative(root, local);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new UsageError(`${given} is not inside the repository`);
    if (!fs.existsSync(local)) throw new UsageError(`${given} doesn't exist`);
    return relative.split(path.sep).join('/');
  });
}

/** Streams the job's output here. Resolves with the result line, or null if it never arrived. */
function streamJob(machine, remoteCommand, write) {
  return new Promise((resolve) => {
    const child = spawn(machine.ssh || 'ssh', [
      ...(machine.sshConfig ? ['-F', machine.sshConfig] : []),
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
      machine.host, remoteCommand,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    let result = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), JOB_LIMIT_MS);
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
    // Held open for the whole job: the test Mac stops the job when this closes.
    child.stdin.on('error', () => { /* connection lost; `close` reports it */ });
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
  });
}

/** Sends remote-ios.sh, named by its content, then runs `then` with it, if given. */
async function withScript(machine, then, prefix = '') {
  const text = fs.readFileSync(path.join(__dirname, 'remote-ios.sh'));
  const script = `remote-ios/remote-ios-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.sh`;
  // Renamed into place: another job may be starting from this same file.
  const sent = await sshCommand(machine, `mkdir -p remote-ios && cat > ${script}.$$ && mv ${script}.$$ ${script}${then ? ` && ${prefix}bash ${script} ${then}` : ''}`, {
    input: text,
  });
  return { script, sent };
}

function makeRunDir(base, runId) {
  const parent = path.join(base, '_scratch', 'aio-ios');
  fs.mkdirSync(parent, { recursive: true });
  // So the app's repository never sends or shows these, whatever its own .gitignore says.
  fs.writeFileSync(path.join(parent, '.gitignore'), '*\n');
  const dir = path.join(parent, runId);
  fs.mkdirSync(dir);
  return dir;
}

/** Copies back what the job made. False if nothing arrived. */
async function fetchOutput(machine, script, runId, runDir) {
  const fetched = await sshCommand(machine, `bash ${script} fetch ${runId}`, { binary: true });
  if (fetched.code !== 0 || !fetched.stdout.length) return false;
  return spawnSync('tar', ['-xzf', '-', '--strip-components=1', '-C', runDir], { input: fetched.stdout }).status === 0;
}

function summary({ action, result, runDir, sim, app, tookSeconds }) {
  const where = `on the test Mac in ${tookSeconds}s`;
  if (result.status === 'no-job') return [];
  if (result.status === 'stopped') return [`aio-ios: this job was ended by aio-ios stop. Logs: ${runDir}`];
  if (result.status === 'refused') return [`aio-ios: the test Mac refused that. Logs: ${runDir}`];
  if (result.exit !== 0) return [`aio-ios: FAILED at ${result.stage} (exit ${result.exit}) ${where}. Logs: ${runDir}`];
  const lines = [];
  if (action === 'build') lines.push(`aio-ios: built ${app.bundleId} ${where}.`);
  if (action === 'run') lines.push(`aio-ios: ${app.bundleId} is running ${where}. Screenshot: ${path.join(runDir, 'screenshot.png')}`);
  if (action === 'test') lines.push(`aio-ios: the flows passed ${where}. Report: ${path.join(runDir, 'maestro-report.xml')}, screenshots in ${path.join(runDir, 'maestro')}`);
  if (action === 'logs') lines.push(`aio-ios: saved to ${path.join(runDir, 'logs.txt')}`);
  if (action === 'sim') lines.push(...sim.outputs.map(output => `aio-ios: saved ${output.local}`));
  lines.push(`Logs: ${runDir}`);
  return lines;
}

/** Copies each file simctl made to the path the agent named. */
function deliverOutputs(sim, runDir) {
  const missing = [];
  for (const output of sim?.outputs ?? []) {
    const made = path.join(runDir, output.name);
    if (!fs.existsSync(made)) {
      missing.push(output.local);
      continue;
    }
    fs.mkdirSync(path.dirname(output.local), { recursive: true });
    fs.copyFileSync(made, output.local);
  }
  return missing;
}

async function runJob({ action, options, args, cwd, env, home, apps, write, now = Date.now }) {
  const found = ['build', 'run', 'test', 'logs'].includes(action) || options.app ? findApp(cwd, { appId: options.app, home, apps }) : null;
  const needsApp = action !== 'sim';
  if (needsApp && !found) {
    throw new UsageError("this folder isn't in an app on the test Mac's list (scripts/remote-ios/apps.js in ai-orchestrator). "
      + 'Its iPhone builds run here with the usual commands.');
  }
  if (found?.choices) throw new UsageError(`this repository has several iPhone apps. Name one with --app: ${found.choices.join(', ')}`);
  const app = found?.app ?? null;
  const root = found?.root ?? gitRoot(cwd) ?? cwd;
  if (neverSent(root, home)) throw new UsageError('nothing under ~/work/ebrd goes to the test Mac');
  const sim = action === 'sim' ? mapSimArgs(args, cwd) : null;
  const flows = action === 'test' ? flowPaths(args, cwd, root) : null;

  const place = findTestMac(env);
  if (!place.machine) {
    write(`aio-ios: ${place.reason}, so the usual xcodebuild, xcrun simctl and maestro commands run on this Mac.\n`);
    return MACHINE_AWAY;
  }
  const machine = place.machine;
  /** `remember`: the test Mac itself is at fault, so the redirect lets the usual commands run here for a while. */
  const away = (reason, remember = true) => {
    if (!remember) {
      write(`aio-ios: ${reason}.\n`);
      return MACHINE_AWAY;
    }
    write(`aio-ios: ${reason}. For the next 10 minutes the usual xcodebuild, xcrun simctl and maestro commands run on this Mac.\n`);
    markUnusable(machine, reason, { env });
    return MACHINE_AWAY;
  };

  const started = now();
  const runId = `${started.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const session = sessionName(env);
  const withSnapshot = ['build', 'run', 'test'].includes(action);
  const prefix = app && withSnapshot ? `AIO_IOS_APP=${app.id} ` : '';
  let snapshot = null;
  const requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ios-request-'));
  try {
    const { script, sent } = await withScript(machine, withSnapshot ? 'bases' : null, prefix);
    if (sent.code !== 0 || sent.timedOut) return away(`${machine.label} could not be reached`);

    if (withSnapshot) {
      write(`aio-ios: sending ${app.id} to ${machine.label}\n`);
      try {
        snapshot = takeSnapshot(root);
      } catch (err) {
        if (err instanceof SnapshotRefused) throw new UsageError(`the app's files couldn't be sent: ${err.message}`);
        throw err;
      }
      const fault = await sendSnapshot(root, snapshot, machine, script, sent.stdout.split('\n').filter(Boolean), prefix);
      if (fault) return away(fault);
    }

    writeRequest(requestDir, { app, commit: snapshot?.commit, options, sim, flows });
    const tar = spawn('tar', ['-czf', '-', '-C', requestDir, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const put = await sshCommand(machine, `bash ${script} put ${runId}`, { inputStream: tar.stdout });
    if (put.code !== 0 || put.timedOut) return away(`${machine.label} could not take the request`);

    const result = await streamJob(machine, `bash ${script} job ${runId} ${session} ${action}`, write);
    if (!result) return away(`the connection to ${machine.label} was lost during the job`);
    if (result.status === 'no-slot') return away(`${machine.label}'s simulator stayed busy with another session; try again later`, false);
    if (result.status === 'setup-failed') return away(`${machine.label} could not do the job (${result.stage})`, MACHINE_STAGES.has(result.stage));
    if (snapshot && result.tree && result.tree !== snapshot.tree) return away(`what ${machine.label} built did not match the files sent`);

    const runDir = makeRunDir(root, runId);
    const fetched = await fetchOutput(machine, script, runId, runDir);
    const missing = result.exit === 0 ? deliverOutputs(sim, runDir) : [];
    markUsable(machine, { env });
    const exitCode = result.status === 'refused' ? USAGE_ERROR : missing.length ? 1 : result.exit;
    appendRunLog({
      at: new Date(started).toISOString(), project: app?.id ?? null, kind: 'ios', action, loop: isLoopRun(env),
      ranOn: machine.host, waitedMs: 0, tookMs: now() - started, exitCode, fellBackBecause: null,
    }, env);
    const tookSeconds = Math.round((now() - started) / 1000);
    for (const line of summary({ action, result, runDir, sim, app, tookSeconds })) write(`${line}\n`);
    if (!fetched) write(`aio-ios: the job's logs didn't come back from ${machine.label}\n`);
    for (const file of missing) write(`aio-ios: simctl made no ${path.basename(file)}, so nothing was saved at ${file}\n`);
    return exitCode;
  } finally {
    snapshot?.cleanup();
    fs.rmSync(requestDir, { recursive: true, force: true });
  }
}

/** `status` and `stop`: one short command each, printed as the test Mac says it. */
async function sessionCommand(action, { env, write }) {
  const place = findTestMac(env);
  if (!place.machine) {
    write(`aio-ios: ${place.reason}\n`);
    return MACHINE_AWAY;
  }
  const { sent } = await withScript(place.machine, `${action} ${sessionName(env)}`);
  if (sent.code !== 0 || sent.timedOut) {
    write(`aio-ios: ${place.machine.label} could not be reached\n`);
    return MACHINE_AWAY;
  }
  write(sent.stdout);
  return 0;
}

/** Resolves with the exit code. `home` and `apps` are only ever different in tests. */
async function main(argv, {
  cwd = process.cwd(), env = process.env, home = os.homedir(), apps = undefined, write = text => process.stdout.write(text),
} = {}) {
  try {
    const { action, options, args } = parse(argv);
    if (action === 'help') {
      write(`${USAGE}\n`);
      return 0;
    }
    if (action === 'status' || action === 'stop') return await sessionCommand(action, { env, write });
    return await runJob({ action, options, args, cwd, env, home, apps, write });
  } catch (err) {
    if (err instanceof UsageError || err instanceof SimArgsRefused) {
      write(`aio-ios: ${err.message}\n`);
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
      process.stderr.write(`aio-ios: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { main, parse, recipeText, sessionName };
