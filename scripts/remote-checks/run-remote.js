'use strict';
/**
 * Sends a test run to the machine named in the remote checks config, and brings
 * the result back as if Vitest had run here: output streams into the usual log, and the
 * usual JSON report arrives with the far machine's paths rewritten to local ones.
 *
 * `runOnRemote` never throws for a machine fault. It resolves `{ ok: false, reason }`,
 * and the caller then runs the suite on the Mac and says why. A result only counts if
 * the snapshot's fingerprint comes back and a report with tests in it arrives. With this Mac
 * switched off a confirmed run's report counts even with no tests in it: a spec that fails to
 * load reports no tests, and that is a real failure, not a reason to try another machine.
 */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const { SnapshotRefused, snapshotFileHash, snapshotFileText, takeSnapshot } = require('./snapshot');

const RESULT_PREFIX = 'AIO_REMOTE_RESULT ';
const SSH_UNREACHABLE = 255;
/** remote-run.sh's answer to a check it doesn't know. */
const REFUSED = 4;
const SETUP_LIMIT_MS = 5 * 60_000;
/** A little over the far machine's own limit, for a run that goes quiet without the connection dropping. */
const RUN_LIMIT_MS = 62 * 60_000;
const LOCK_FILE = 'package-lock.json';
/** How long work waits for a test machine when this Mac is switched off, and how long it sleeps between tries. */
const WAIT_LIMIT_MS = 20 * 60_000;
const RETRY_SLEEP_MS = 15_000;
/** Named-list runs a machine takes at once beside its full runs, unless its config says. */
const SMALL_SLOTS = { linux: 4, darwin: 2 };
const SSH_OPTIONS = [
  '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
];

function sshArgs(config, remoteCommand) {
  return [...(config.sshConfig ? ['-F', config.sshConfig] : []), ...SSH_OPTIONS, config.host, remoteCommand];
}

/** Runs one ssh command to completion, optionally feeding it a file or stream. */
function sshCommand(config, remoteCommand, { input, inputStream, timeoutMs = SETUP_LIMIT_MS, binary = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(config.ssh || 'ssh', sshArgs(config, remoteCommand), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => { /* the far end went away; `close` reports it */ });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: SSH_UNREACHABLE, stdout: '', stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = Buffer.concat(out);
      resolve({
        code: code === null ? SSH_UNREACHABLE : code,
        stdout: binary ? body : body.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });
    if (inputStream) inputStream.pipe(child.stdin);
    else child.stdin.end(input ?? '');
  });
}

function git(root, env, args) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Commits the far machine has that this repository also has, so the pack can leave them out. */
function sharedBases(root, env, listed) {
  return listed.filter((commit) => {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
    try {
      git(root, env, ['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  });
}

/** Streams the snapshot's missing objects into the far repository. Never a `git push`. */
async function sendSnapshot(root, snapshot, config, script, listedBases, prefix) {
  const bases = sharedBases(root, snapshot.env, listedBases);
  const pack = spawn('git', ['pack-objects', '--revs', '--thin', '--stdout', '--quiet'], {
    cwd: root, env: snapshot.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  pack.stdin.on('error', () => { /* pack-objects died; its exit code reports it */ });
  const packDone = new Promise(resolve => pack.on('close', resolve));
  pack.stdin.end(`${snapshot.commit}\n${bases.map(base => `^${base}\n`).join('')}`);
  const sent = await sshCommand(config, `${prefix}bash ${script} receive ${snapshot.commit} ${snapshot.head ?? 'none'}`, {
    inputStream: pack.stdout,
  });
  // If the far end stopped early, nothing reads the pack any more, and it would block on a full pipe forever.
  pack.stdout.destroy();
  pack.kill('SIGKILL');
  const packCode = await packDone;
  if (sent.code === SSH_UNREACHABLE || sent.timedOut) return `${config.label} could not be reached`;
  if (sent.code !== 0) return `${config.label} could not store the snapshot`;
  if (packCode !== 0) return 'the snapshot could not be packed';
  return null;
}

/** Streams the run into the log. Resolves with the result line, or null if it never arrived. */
function streamRun(config, remoteCommand, logPath) {
  return new Promise((resolve) => {
    const child = spawn(config.ssh || 'ssh', sshArgs(config, remoteCommand), { stdio: ['pipe', 'pipe', 'pipe'] });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    let pending = '';
    let result = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_LIMIT_MS);
    const takeLine = (line) => {
      if (line.startsWith(RESULT_PREFIX)) {
        try {
          result = JSON.parse(line.slice(RESULT_PREFIX.length));
        } catch {
          result = null;
        }
      } else {
        logStream.write(`${line}\n`);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach(takeLine);
    });
    child.stderr.pipe(logStream, { end: false });
    child.stdin.on('error', () => { /* connection lost; `close` reports it */ });
    const finish = () => {
      clearTimeout(timer);
      if (pending) takeLine(pending);
      logStream.end(() => resolve(result));
    };
    child.on('error', finish);
    child.on('close', finish);
  });
}

/** A project may leave off the `v`, or name only a major version, like `24`. */
function sameNode(wanted, actual) {
  const version = wanted.replace(/^v/, '');
  return actual === `v${version}` || (/^\d+$/.test(version) && actual.startsWith(`v${version}.`));
}

function escapeForJson(text) {
  return JSON.stringify(text).slice(1, -1);
}

/** Fetches the run's results file and swaps the far machine's folder for this one, inside messages too. Null if it can't. */
async function fetchResults(config, script, id, remoteRoot, root) {
  const fetched = await sshCommand(config, `bash ${script} fetch ${id}`, { binary: true });
  if (fetched.code !== 0 || fetched.stdout.length === 0) return null;
  const gunzip = createGunzip();
  const text = await new Promise((resolve) => {
    const parts = [];
    gunzip.on('data', part => parts.push(part));
    gunzip.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    gunzip.on('error', () => resolve(null));
    gunzip.end(fetched.stdout);
  });
  if (text === null) return null;
  const rewritten = remoteRoot ? text.split(escapeForJson(remoteRoot)).join(escapeForJson(root)) : text;
  try {
    return { text: rewritten, value: JSON.parse(rewritten) };
  } catch {
    return null;
  }
}

async function fetchReport(config, script, id, remoteRoot, root, jsonPath, acceptEmpty) {
  const results = await fetchResults(config, script, id, remoteRoot, root);
  const total = results?.value?.numTotalTests;
  if (!Number.isInteger(total) || (total === 0 && !acceptEmpty)) return false;
  fs.writeFileSync(jsonPath, results.text);
  return true;
}

/** Every check that was sent, in order, each with a result. Null for anything less. */
async function fetchChecks(config, script, id, remoteRoot, root, checks) {
  const results = await fetchResults(config, script, id, remoteRoot, root);
  const value = results?.value;
  if (!Array.isArray(value) || value.length !== checks.length) return null;
  const complete = value.every((check, at) => check?.command === checks[at] && Number.isInteger(check.exitCode)
    && Number.isFinite(check.durationMs) && typeof check.output === 'string');
  return complete ? value : null;
}

/**
 * @param {object} options
 * @param {{host: string, label: string, ssh?: string, sshConfig?: string}} options.config
 * @param {string} options.root repository being tested
 * @param {string} options.logPath
 * @param {string} options.jsonPath
 * @param {boolean} options.noCache
 * @param {string|undefined} options.ci value of `CI` to pass through
 * @param {(root: string) => object} [options.take] how to capture the code; the files on disk by default
 * @param {string[]} [options.relatedTo] run only the tests related to these files, not the whole suite
 * @param {string[]} [options.checks] run these check commands instead of the tests. Each must be on the far machine's
 *   list. The result's `checks` holds each one's exit code, time and output, and `jsonPath` is unused.
 * @param {{id: string, suite: string, nodeFile: string, lockFile: string}} [options.project] another repository's
 *   recipe, from projects.js. Its own runner reports on the far machine, so no report comes back: the result
 *   line's test count is the proof instead, and `jsonPath` is unused.
 * @param {string[]} [options.argv] the runner's own arguments, such as a folder or `-t name`, sent as data
 * @param {boolean} [options.small] take one of the far machine's small-run slots rather than a full-run one
 * @param {boolean} [options.acceptEmpty] a confirmed run that ran no tests is still its result, rather than a fault
 */
async function runOnRemote({
  config, root, logPath, jsonPath, noCache, ci, take = takeSnapshot, relatedTo, checks, project, argv, small = false, acceptEmpty = false, waitForSlot = true,
}) {
  let snapshot;
  try {
    snapshot = take(root);
  } catch (err) {
    // Another machine would get the same snapshot, so trying again cannot help.
    return {
      ok: false,
      final: true,
      reason: err instanceof SnapshotRefused ? `the snapshot was refused: ${err.message}` : 'the snapshot failed',
    };
  }

  try {
    const expected = {
      tree: snapshot.tree,
      node: snapshotFileText(root, snapshot, project?.nodeFile ?? '.nvmrc'),
      lock: snapshotFileHash(root, snapshot, project?.lockFile ?? LOCK_FILE),
    };
    // The id and suite are fixed names from projects.js, never anything a run supplied.
    const prefix = project ? `AIO_PROJECT=${project.id} AIO_SUITE=${project.suite} ` : '';

    const scriptText = fs.readFileSync(path.join(__dirname, 'remote-run.sh'));
    const scriptName = `remote-run-${crypto.createHash('sha256').update(scriptText).digest('hex').slice(0, 12)}.sh`;
    const script = `remote-checks/${scriptName}`;
    const prepared = await sshCommand(
      config,
      // Renamed into place: other runs may be starting from this same file.
      `mkdir -p remote-checks && cat > ${script}.$$ && mv ${script}.$$ ${script} && ${prefix}bash ${script} bases`,
      { input: scriptText },
    );
    if (prepared.code !== 0 || prepared.timedOut) return { ok: false, reason: `${config.label} could not be reached` };

    const sendFault = await sendSnapshot(root, snapshot, config, script, prepared.stdout.split('\n').filter(Boolean), prefix);
    if (sendFault) return { ok: false, reason: sendFault };

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    if (relatedTo) {
      // File names travel as data. Built into the command, a shell on the far machine would read them.
      const listed = await sshCommand(config, `bash ${script} related ${id}`, { input: JSON.stringify(relatedTo) });
      if (listed.code !== 0 || listed.timedOut) return { ok: false, reason: `${config.label} could not be reached` };
    }
    if (checks) {
      // Commands travel as data too, and the far machine runs only those on its own list.
      const listed = await sshCommand(config, `bash ${script} checks ${id}`, { input: `${checks.join('\n')}\n` });
      if (listed.code === REFUSED) return { ok: false, final: true, reason: `${config.label} does not know one of these checks` };
      if (listed.code !== 0 || listed.timedOut) return { ok: false, reason: `${config.label} could not be reached` };
    }
    if (argv) {
      // Arguments travel as data, like file names.
      const listed = await sshCommand(config, `bash ${script} argv ${id}`, { input: JSON.stringify(argv) });
      if (listed.code !== 0 || listed.timedOut) return { ok: false, reason: `${config.label} could not be reached` };
    }
    const flag = value => (value ? '1' : '0');
    // Slot counts from the config, which readConfig has already held to 1 to 8.
    const smallSlots = Number.isInteger(config.smallSlots) ? config.smallSlots : SMALL_SLOTS[config.platform] ?? SMALL_SLOTS.linux;
    const slots = `${small ? `AIO_SMALL_RUN=1 AIO_SMALL_SLOT_COUNT=${smallSlots} ` : ''}`
      + `${Number.isInteger(config.slots) ? `AIO_SLOT_COUNT=${config.slots} ` : ''}${waitForSlot ? '' : 'AIO_SLOT_WAIT=0 '}`;
    const result = await streamRun(config, `${prefix}${slots}bash ${script} run ${id} ${snapshot.commit} ${flag(ci)} ${flag(noCache)}`, logPath);

    if (!result) return { ok: false, reason: `the connection to ${config.label} was lost during the run` };
    if (result.status === 'no-slot') return { ok: false, reason: `${config.label} had no free slot` };
    if (result.status !== 'ok') return { ok: false, reason: `${config.label} could not set up: ${result.reason || 'unknown fault'}` };
    if (result.tree !== expected.tree || !sameNode(expected.node, result.node) || result.lock !== expected.lock) {
      return { ok: false, reason: `the result from ${config.label} did not match the code sent` };
    }
    const checkResults = checks ? await fetchChecks(config, script, id, result.root, root, checks) : undefined;
    const reported = project ? result.tests > 0 || acceptEmpty
      : checks ? checkResults !== null : await fetchReport(config, script, id, result.root, root, jsonPath, acceptEmpty);
    if (!reported) return { ok: false, reason: `${config.label} sent back no usable report` };
    return {
      ok: true, exitCode: result.exit, fingerprint: snapshot.tree, waitedMs: (result.waited ?? 0) * 1000, farRoot: result.root, tests: result.tests,
      ...(checks ? { checks: checkResults } : {}),
    };
  } catch (err) {
    return { ok: false, reason: `the run could not be sent: ${err.message}` };
  } finally {
    snapshot.cleanup();
  }
}

/**
 * Tries each machine in order, and resolves the first that runs the work, with `machine` saying which. Every machine
 * but the last is asked not to wait for a slot, so a busy one passes the work on at once. When none can, resolves
 * `{ ok: false, reason }` with every machine's reason, so the caller can say why it ran here. With `patient`, for when
 * this Mac is switched off, it keeps going round them instead: see runPatiently.
 */
async function runOnMachines(machines, options) {
  if (options.patient) return runPatiently(machines, options);
  const reasons = [];
  for (const [at, machine] of machines.entries()) {
    const result = await runOnRemote({ ...options, config: machine, waitForSlot: at === machines.length - 1 });
    if (result.ok) return { ...result, machine };
    reasons.push(result.reason);
  }
  return { ok: false, reason: reasons.join('; ') || 'no test machine takes this work' };
}

function msFromEnv(name, fallback, env = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function minutesText(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * For when this Mac is switched off: goes round the machines without waiting on any one of them, retrying whatever
 * went wrong, until one runs the work or `waitLimitMs` (AIO_REMOTE_WAIT_LIMIT_MS, 20 minutes by default) has gone.
 * The limit is checked only between tries, so a run that has started is never cut off. A run that completed on the
 * code sent is the answer even when it ran no tests: only faults on the way there are retried. Gives up with
 * `{ ok: false, notRun: true, reason }`, naming each machine's last problem.
 */
async function runPatiently(machines, options) {
  const env = options.env ?? process.env;
  const limitMs = options.waitLimitMs ?? msFromEnv('AIO_REMOTE_WAIT_LIMIT_MS', WAIT_LIMIT_MS, env);
  const sleepMs = msFromEnv('AIO_REMOTE_RETRY_SLEEP_MS', RETRY_SLEEP_MS, env);
  const say = options.say ?? (text => process.stderr.write(`${text}\n`));
  const { patient: _patient, waitLimitMs: _limit, say: _say, env: _env, ...runOptions } = options;
  const started = Date.now();
  const last = new Map();
  const giveUp = (lead) => {
    const problems = machines.map(machine => last.get(machine) ?? `${machine.label} was not tried`).join('; ');
    return { ok: false, notRun: true, reason: `${lead}${problems ? ` (${problems})` : ''}, and this Mac is switched off` };
  };
  if (!machines.length) return { ok: false, notRun: true, reason: 'no test machine takes this work, and this Mac is switched off' };
  for (let round = 0; ; round += 1) {
    for (const machine of machines) {
      if (round > 0 && Date.now() - started >= limitMs) return giveUp(`no test machine could take it in ${minutesText(limitMs)}`);
      const result = await runOnRemote({ ...runOptions, config: machine, waitForSlot: false, acceptEmpty: true });
      if (result.ok) return { ...result, machine };
      last.set(machine, result.reason);
      if (result.final) return { ok: false, notRun: true, reason: `${result.reason}, and this Mac is switched off` };
    }
    const left = limitMs - (Date.now() - started);
    if (left <= 0) return giveUp(`no test machine could take it in ${minutesText(limitMs)}`);
    say(`[remote checks] waiting for a test machine (${[...last.values()].join('; ')}); this Mac is switched off.`);
    await new Promise(resolve => setTimeout(resolve, Math.min(sleepMs, left)));
  }
}

module.exports = { WAIT_LIMIT_MS, runOnMachines, runOnRemote, sendSnapshot, sshCommand };
