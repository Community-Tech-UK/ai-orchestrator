'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { paths } = require('./source-update-config.cjs');

function atomicJson(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Updater state must not be a symlink');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function exclusiveJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd);
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return true;
  } finally { try { fs.closeSync(fd); } catch { /* already closed before publication */ } fs.rmSync(temporary, { force: true }); }
}
function readState(config) {
  const file = paths(config).state;
  if (!fs.existsSync(file)) return {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Updater state is not private');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid updater state');
  return state;
}
function writeState(config, state) { atomicJson(paths(config).state, state); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw new Error('Could not inspect updater process'); }
}
function acquireDirectoryLock(location) {
  const nonce = randomUUID();
  try { fs.mkdirSync(location, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Could not acquire updater lock');
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Invalid updater lock');
    const ownerFile = path.join(location, 'owner.json');
    // A lock without its owner may still be being created. Never steal it.
    let owner; try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { throw new Error('Source updater is already busy'); }
    if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error('Source updater is already busy');
    const retired = `${location}.stale-${nonce}`;
    fs.renameSync(location, retired);
    fs.rmSync(retired, { recursive: true });
    return acquireDirectoryLock(location);
  }
  try { atomicJson(path.join(location, 'owner.json'), { pid: process.pid, nonce }); }
  catch (error) { fs.rmSync(location, { recursive: true }); throw error; }
  return () => {
    const owner = JSON.parse(fs.readFileSync(path.join(location, 'owner.json'), 'utf8'));
    if (owner.nonce !== nonce) throw new Error('Updater lock ownership changed');
    fs.rmSync(location, { recursive: true });
  };
}
function acquireLock(config) {
  const helperDirectory = paths(config).helperDirectory;
  const locations = [paths(config).appLock, path.join(config.stateDirectory, 'source-update-owner-lock'),
    path.join(path.dirname(helperDirectory), `.${path.basename(helperDirectory)}.source-update-lock`)];
  const repoGit = path.join(config.repositoryPath, '.git');
  if (fs.existsSync(repoGit) && fs.lstatSync(repoGit).isDirectory()) locations.push(path.join(repoGit, 'source-update-lock'));
  const releases = [];
  try {
    for (const location of locations.sort()) releases.push(acquireDirectoryLock(location));
  } catch (error) { for (const release of releases.reverse()) release(); throw error; }
  return () => { for (const release of releases.reverse()) release(); };
}
function failed(config, sourceCommit, label, permanent = false) {
  const state = readState(config);
  state.failed = { commit: sourceCommit, reason: label, permanent, retryAfter: permanent ? null : Date.now() + 2 * 60 * 60_000 };
  writeState(config, state);
}
function checkBackoff(state, target) {
  if (state.failed?.commit === target && (state.failed.permanent || state.failed.retryAfter > Date.now())) throw new Error('This source update failed earlier; waiting for another commit or retry window');
}
module.exports = { acquireLock, alive, atomicJson, checkBackoff, exclusiveJson, failed, readState, writeState };
