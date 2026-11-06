'use strict';
/**
 * Sends a full test run to the machine named in the remote checks config, and brings
 * the result back as if Vitest had run here: output streams into the usual log, and the
 * usual JSON report arrives with the far machine's paths rewritten to local ones.
 *
 * `runOnRemote` never throws for a machine fault. It resolves `{ ok: false, reason }`,
 * and the caller then runs the suite on the Mac and says why. A result only counts if
 * the snapshot's fingerprint comes back and a report with tests in it arrives.
 */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const { SnapshotRefused, snapshotFileHash, snapshotFileText, takeSnapshot } = require('./snapshot');

const RESULT_PREFIX = 'AIO_REMOTE_RESULT ';
const SSH_UNREACHABLE = 255;
const SETUP_LIMIT_MS = 5 * 60_000;
/** A little over the far machine's own limit, for a run that goes quiet without the connection dropping. */
const RUN_LIMIT_MS = 62 * 60_000;
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
async function sendSnapshot(root, snapshot, config, script, listedBases) {
  const bases = sharedBases(root, snapshot.env, listedBases);
  const pack = spawn('git', ['pack-objects', '--revs', '--thin', '--stdout', '--quiet'], {
    cwd: root, env: snapshot.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  pack.stdin.on('error', () => { /* pack-objects died; its exit code reports it */ });
  const packDone = new Promise(resolve => pack.on('close', resolve));
  pack.stdin.end(`${snapshot.commit}\n${bases.map(base => `^${base}\n`).join('')}`);
  const sent = await sshCommand(config, `bash ${script} receive ${snapshot.commit} ${snapshot.head ?? 'none'}`, {
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

function escapeForJson(text) {
  return JSON.stringify(text).slice(1, -1);
}

/** Fetches the report and swaps the far machine's folder for this one, inside failure messages too. */
async function fetchReport(config, script, id, remoteRoot, root, jsonPath) {
  const fetched = await sshCommand(config, `bash ${script} fetch ${id}`, { binary: true });
  if (fetched.code !== 0 || fetched.stdout.length === 0) return false;
  const gunzip = createGunzip();
  const text = await new Promise((resolve) => {
    const parts = [];
    gunzip.on('data', part => parts.push(part));
    gunzip.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    gunzip.on('error', () => resolve(null));
    gunzip.end(fetched.stdout);
  });
  if (text === null) return false;
  const rewritten = remoteRoot ? text.split(escapeForJson(remoteRoot)).join(escapeForJson(root)) : text;
  let report;
  try {
    report = JSON.parse(rewritten);
  } catch {
    return false;
  }
  if (!(report.numTotalTests > 0)) return false;
  fs.writeFileSync(jsonPath, rewritten);
  return true;
}

/**
 * @param {object} options
 * @param {{host: string, label: string, ssh?: string, sshConfig?: string}} options.config
 * @param {string} options.root repository being tested
 * @param {string} options.logPath
 * @param {string} options.jsonPath
 * @param {boolean} options.noCache
 * @param {string|undefined} options.ci value of `CI` to pass through
 */
async function runOnRemote({ config, root, logPath, jsonPath, noCache, ci }) {
  let snapshot;
  try {
    snapshot = takeSnapshot(root);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof SnapshotRefused ? `the snapshot was refused: ${err.message}` : 'the snapshot failed',
    };
  }

  try {
    const expected = {
      tree: snapshot.tree,
      node: snapshotFileText(root, snapshot, '.nvmrc'),
      lock: snapshotFileHash(root, snapshot, 'package-lock.json'),
    };

    const scriptText = fs.readFileSync(path.join(__dirname, 'remote-run.sh'));
    const scriptName = `remote-run-${crypto.createHash('sha256').update(scriptText).digest('hex').slice(0, 12)}.sh`;
    const script = `remote-checks/${scriptName}`;
    const prepared = await sshCommand(
      config,
      // Renamed into place: other runs may be starting from this same file.
      `mkdir -p remote-checks && cat > ${script}.$$ && mv ${script}.$$ ${script} && bash ${script} bases`,
      { input: scriptText },
    );
    if (prepared.code !== 0 || prepared.timedOut) return { ok: false, reason: `${config.label} could not be reached` };

    const sendFault = await sendSnapshot(root, snapshot, config, script, prepared.stdout.split('\n').filter(Boolean));
    if (sendFault) return { ok: false, reason: sendFault };

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const flag = value => (value ? '1' : '0');
    const result = await streamRun(config, `bash ${script} run ${id} ${snapshot.commit} ${flag(ci)} ${flag(noCache)}`, logPath);

    if (!result) return { ok: false, reason: `the connection to ${config.label} was lost during the run` };
    if (result.status === 'no-slot') return { ok: false, reason: `${config.label} had no free slot` };
    if (result.status !== 'ok') return { ok: false, reason: `${config.label} could not set up: ${result.reason || 'unknown fault'}` };
    if (result.tree !== expected.tree || result.node !== expected.node || result.lock !== expected.lock) {
      return { ok: false, reason: `the result from ${config.label} did not match the code sent` };
    }
    if (!await fetchReport(config, script, id, result.root, root, jsonPath)) {
      return { ok: false, reason: `${config.label} sent back no usable report` };
    }
    return { ok: true, exitCode: result.exit, fingerprint: snapshot.tree, waitedMs: (result.waited ?? 0) * 1000 };
  } catch (err) {
    return { ok: false, reason: `the run could not be sent: ${err.message}` };
  } finally {
    snapshot.cleanup();
  }
}

module.exports = { runOnRemote };
