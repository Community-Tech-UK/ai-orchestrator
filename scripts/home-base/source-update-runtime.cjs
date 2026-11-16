'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const children = new Set();
function stopChild(child, signal = 'SIGTERM') {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stopChildren(signal) { for (const child of children) stopChild(child, signal); }
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = ''; let stderr = ''; let failure; let killTimer;
    const capture = (current, chunk) => (current + chunk.toString('utf8')).slice(-128 * 1024);
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(() => {
      failure = new Error('Updater subprocess timed out'); stopChild(child);
      killTimer = setTimeout(() => stopChild(child, 'SIGKILL'), 2000);
    }, options.timeoutMs ?? 60_000);
    child.on('error', () => { failure = new Error('Could not start updater subprocess'); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
      if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
function record(config, label, code) {
  // Only controlled stage names and numeric results enter disk logs. Raw tool
  // output can contain Git authentication URLs or environment-derived secrets.
  const file = path.join(config.stateDirectory, 'source-update.log');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Updater log must not be a symlink');
  if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) fs.renameSync(file, file + '.previous');
  fs.appendFileSync(file, `${new Date().toISOString()} ${label} ${code}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
async function checked(config, runner, file, args, label, timeoutMs = 60_000) {
  let result;
  try { result = await runner(file, args, { cwd: config.repositoryPath, timeoutMs, env: {
    ...process.env, PATH: `${path.dirname(config.nodePath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  } }); }
  catch { record(config, label, -1); throw new Error(`${label} failed or timed out`); }
  record(config, label, result.code);
  if (result.code !== 0) throw new Error(`${label} failed`);
  return result.stdout.trim();
}
module.exports = { checked, record, run, stopChildren };
