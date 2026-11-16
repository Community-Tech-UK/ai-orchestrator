'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { commit, paths, privateFile, validateSessions } = require('./source-update-config.cjs');
const { acquireLock, alive, atomicJson, checkBackoff, exclusiveJson, failed, readState, writeState } = require('./source-update-state.cjs');
const { run } = require('./source-update-runtime.cjs');

const readyFile = config => path.join(config.stateDirectory, 'source-update-ready.json');
function assertApp(app) {
  const stat = fs.lstatSync(app);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Invalid updater app bundle');
}
function journal(config, state) {
  const entry = state.activation;
  if (!entry) return null;
  commit(entry.commit);
  if (entry.appPath !== paths(config, entry.commit).candidate || entry.previousPath !== paths(config).previous
    || entry.helperPath !== paths(config, entry.commit).candidateHelper
    || !Number.isSafeInteger(entry.parentPid) || entry.parentPid < 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.nonce)) throw new Error('Invalid source activation journal');
  commit(entry.previousHelperCommit);
  validateSessions(entry.sessions);
  return entry;
}
async function processIdentity(config, pid, runner = run) {
  const result = await runner('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=,comm='], { timeoutMs: 10_000 });
  if (result.code === 1 && !result.stdout.trim()) return null;
  if (result.code !== 0) throw new Error('Could not inspect exact app process');
  const text = result.stdout.trim();
  const uid = /^\d+/u.exec(text)?.[0];
  if (uid !== String(process.getuid()) || !text.endsWith(path.join(config.appPath, 'Contents/MacOS/Harness'))) throw new Error('Updater parent is not the configured app');
  return text;
}
async function targetRunning(config) {
  const result = await run('/bin/ps', ['-axo', 'comm='], { timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error('Could not inspect installed app processes');
  return result.stdout.split(/\r?\n/u).some(line => line.trim() === path.join(config.appPath, 'Contents/MacOS/Harness'));
}
function launch(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--js-flags=--max-old-space-size=8192'], { detached: true, stdio: 'ignore', env: process.env });
    let exited = false;
    child.on('exit', () => { exited = true; });
    child.once('error', () => reject(new Error('Candidate application launch failed')));
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid, exited: () => exited });
    });
  });
}
function readiness(config, entry) {
  try {
    const stat = fs.lstatSync(readyFile(config));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Invalid source readiness marker');
    const ack = JSON.parse(fs.readFileSync(readyFile(config), 'utf8'));
    return ack.commit === entry.commit && ack.pid === entry.childPid && ack.nonce === entry.nonce;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function finishReady(config, state) {
  const entry = journal(config, state);
  entry.phase = 'acknowledged';
  state.installedCommit = entry.commit; delete state.failed; delete state.candidate;
  writeState(config, state);
}
function helperCommit(config) {
  const file = paths(config).helperPointer; privateFile(file);
  const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pointer.version !== 1 || Object.keys(pointer).length !== 2) throw new Error('Invalid updater helper pointer');
  return commit(pointer.commit);
}
function switchHelper(config, sourceCommit) {
  require('./source-update-build.cjs').assertHelpers(paths(config, sourceCommit).candidateHelper);
  atomicJson(paths(config).helperPointer, { version: 1, commit: sourceCommit });
}
function restorationPending(config, state) {
  const entry = journal(config, state);
  if (!entry || entry.phase !== 'acknowledged' || entry.sessions.length === 0) return false;
  if (!readiness(config, entry)) return true;
  return JSON.parse(fs.readFileSync(readyFile(config), 'utf8')).restored !== true;
}
function restoreBeforeLaunch(config, state, rename = fs.renameSync, selectHelper = source => switchHelper(config, source)) {
  const entry = journal(config, state);
  const locations = paths(config, entry.commit);
  if (![entry.previousHelperCommit, entry.commit].includes(helperCommit(config))) throw new Error('Updater helper pointer changed outside the pending activation');
  if (fs.existsSync(locations.previous)) {
    assertApp(locations.previous);
    if (fs.existsSync(config.appPath)) {
      assertApp(config.appPath);
      if (fs.existsSync(entry.appPath)) throw new Error('Cannot recover ambiguous source app bundles');
      rename(config.appPath, entry.appPath);
    }
    rename(locations.previous, config.appPath);
  } else if (!fs.existsSync(config.appPath)) throw new Error('Previous app is missing during source recovery');
  selectHelper(entry.previousHelperCommit);
  delete state.activation;
  writeState(config, state);
}
async function recover(config, deps = {}) {
  const state = readState(config); const entry = journal(config, state);
  if (!entry || ['acknowledged', 'startup_failed'].includes(entry.phase)) return;
  if (['launching', 'awaiting_ack'].includes(entry.phase)) {
    if (readiness(config, entry)) { finishReady(config, state); return; }
    if (entry.childPid && (deps.alive ?? alive)(entry.childPid)) throw new Error('Candidate application is still awaiting readiness');
    entry.phase = 'startup_failed'; writeState(config, state);
    failed(config, entry.commit, 'Candidate startup readiness was not acknowledged', true);
    return;
  }
  if (['old_moving', 'old_moved', 'new_moving', 'new_installed', 'helper_switching', 'helper_selected'].includes(entry.phase)) {
    if (await (deps.targetRunning ?? (() => targetRunning(config)))()) throw new Error('An app is running during interrupted source recovery');
    restoreBeforeLaunch(config, state, deps.rename, deps.switchHelper);
    return;
  }
  if (!['prepared', 'waiting_parent'].includes(entry.phase)) throw new Error('Unknown source activation phase');
  // An uncommitted or interrupted handoff never grants replacement authority.
  delete state.activation; writeState(config, state);
}
async function recoverStandalone(config, deps = {}) {
  let release;
  try { release = acquireLock(config); }
  catch (error) {
    if (error.message === 'Source updater is already busy') return { status: 'busy' };
    throw error;
  }
  try {
    try { await recover(config, deps); }
    catch (error) {
      if (error.message === 'Candidate application is still awaiting readiness') return { status: 'busy' };
      throw error;
    }
    const state = readState(config);
    return { status: state.activation?.phase === 'startup_failed' ? 'blocked' : 'ready' };
  } finally { release(); }
}
async function acknowledge(config, request, deps = {}) {
  commit(request.commit);
  if (!Number.isSafeInteger(request.pid) || request.pid < 1) throw new Error('Invalid candidate readiness process');
  const state = readState(config); const entry = journal(config, state);
  if (!entry || !['launching', 'awaiting_ack', 'acknowledged', 'startup_failed'].includes(entry.phase) || entry.commit !== request.commit
    || !(deps.alive ?? alive)(request.pid)) return { acknowledged: false, sessions: [] };
  if (entry.childPid !== request.pid) {
    if (!['acknowledged', 'startup_failed'].includes(entry.phase)) return { acknowledged: false, sessions: [] };
    // A later healthy bootstrap may retry unfinished restoration, but cannot
    // substitute for the exact child used to prove the initial launch.
    if (!(await (deps.parentIdentity ?? (pid => processIdentity(config, pid)))(request.pid))) return { acknowledged: false, sessions: [] };
  }
  await (deps.verifyApp ?? ((app, source) => require('./source-update-build.cjs').verifyApp(config, app, source)))(config.appPath, request.commit);
  const latest = readState(config);
  if (latest.activation?.nonce !== entry.nonce) return { acknowledged: false, sessions: [] };
  if (entry.phase === 'startup_failed') {
    entry.childPid = request.pid; entry.phase = 'acknowledged'; latest.activation = entry;
    latest.installedCommit = entry.commit; delete latest.failed; delete latest.candidate;
    writeState(config, latest);
    fs.rmSync(readyFile(config), { force: true });
  }
  const sessions = validateSessions(entry.sessions);
  if (fs.existsSync(readyFile(config))) {
    if (!readiness(config, entry)) throw new Error('Candidate readiness marker does not match activation');
    const marker = JSON.parse(fs.readFileSync(readyFile(config), 'utf8'));
    if (request.restored === true) {
      atomicJson(readyFile(config), { ...marker, restored: true });
      return { acknowledged: true, sessions: [] };
    }
    return { acknowledged: true, sessions: marker.restored ? [] : sessions };
  }
  if (request.restored === true) return { acknowledged: false, sessions: [] };
  if (!exclusiveJson(readyFile(config), { commit: entry.commit, pid: request.pid, nonce: entry.nonce })) {
    if (!readiness(config, entry)) throw new Error('Candidate readiness marker does not match activation');
    const marker = JSON.parse(fs.readFileSync(readyFile(config), 'utf8'));
    return { acknowledged: true, sessions: marker.restored ? [] : sessions };
  }
  return { acknowledged: true, sessions };
}
async function prepare(config, request, deps = {}) {
  const sourceCommit = commit(request.commit);
  const locations = paths(config, sourceCommit);
  if (request.appPath !== locations.candidate || !Number.isSafeInteger(request.parentPid) || request.parentPid < 1 || request.parentPid === process.pid) throw new Error('Invalid source activation candidate or parent');
  const sessions = validateSessions(request.sessions);
  const release = acquireLock(config);
  let released = false; const unlock = () => { if (!released) { released = true; release(); } };
  try {
    await recover(config, deps);
    const state = readState(config); checkBackoff(state, sourceCommit);
    if (restorationPending(config, state)) throw new Error('Idle conversations still await restoration before another source update');
    if (state.activation && !['acknowledged', 'startup_failed'].includes(state.activation.phase)) throw new Error('An activation is already pending');
    if (state.candidate?.commit !== sourceCommit || state.candidate.appPath !== locations.candidate || state.candidate.helperPath !== locations.candidateHelper) throw new Error('Source candidate is not owned by this updater');
    assertApp(request.appPath); assertApp(config.appPath);
    const { assertHelpers } = require('./source-update-build.cjs');
    const previousHelperCommit = helperCommit(config);
    assertHelpers(paths(config, previousHelperCommit).candidateHelper); assertHelpers(locations.candidateHelper);
    await (deps.verifyApp ?? ((app, source) => require('./source-update-build.cjs').verifyApp(config, app, source)))(request.appPath, sourceCommit);
    const identify = deps.parentIdentity ?? (pid => processIdentity(config, pid));
    const parentIdentity = await identify(request.parentPid);
    if (!parentIdentity) throw new Error('Source activation parent has already exited');
    // Retain each earlier backup under its own recorded name. Do not delete an
    // unowned .app or lose the known-good bundle after a failed startup.
    if (fs.existsSync(locations.previous)) {
      assertApp(locations.previous);
      if (!state.activation || !['acknowledged', 'startup_failed'].includes(state.activation.phase)) throw new Error('Unowned previous app prevents activation');
      if (state.activation.phase === 'acknowledged') fs.rmSync(locations.previous, { recursive: true });
      else fs.renameSync(locations.previous, `${locations.previous}.${state.activation.nonce}`);
    }
    fs.rmSync(readyFile(config), { force: true });
    state.activation = { commit: sourceCommit, appPath: request.appPath, previousPath: locations.previous, helperPath: locations.candidateHelper, previousHelperCommit, parentPid: request.parentPid,
      parentIdentity, sessions, nonce: randomUUID(), phase: 'prepared' };
    writeState(config, state);
    let committed = false;
    return {
      abort: async () => {
        if (committed) return;
        const current = readState(config);
        if (current.activation?.nonce === state.activation.nonce) { delete current.activation; writeState(config, current); }
        unlock();
      },
      commit: async () => {
        if (released || committed) throw new Error('Source activation is no longer prepared');
        committed = true; const entry = state.activation;
        const now = deps.now ?? Date.now; const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const rename = deps.rename ?? fs.renameSync;
        const selectHelper = deps.switchHelper ?? (source => switchHelper(config, source));
        let couldHaveRun = false;
        try {
          entry.phase = 'waiting_parent'; writeState(config, state);
          const deadline = now() + (deps.parentTimeoutMs ?? 60_000);
          while (await identify(entry.parentPid) === entry.parentIdentity) {
            if (now() >= deadline) throw new Error('Source activation parent did not exit before timeout');
            await sleep(250);
          }
          if (await (deps.targetRunning ?? (() => targetRunning(config)))()) throw new Error('Another installed app process is still running');
          await (deps.verifyApp ?? ((app, source) => require('./source-update-build.cjs').verifyApp(config, app, source)))(entry.appPath, entry.commit);
          entry.phase = 'old_moving'; writeState(config, state); rename(config.appPath, locations.previous);
          entry.phase = 'old_moved'; writeState(config, state);
          entry.phase = 'new_moving'; writeState(config, state); rename(entry.appPath, config.appPath);
          entry.phase = 'new_installed'; writeState(config, state);
          entry.phase = 'helper_switching'; writeState(config, state); selectHelper(entry.commit);
          entry.phase = 'helper_selected'; writeState(config, state);
          entry.phase = 'launching'; writeState(config, state);
          const child = await (deps.launch ?? launch)(path.join(config.appPath, 'Contents/MacOS/Harness'));
          couldHaveRun = true; entry.childPid = child.pid; entry.phase = 'awaiting_ack'; writeState(config, state);
          const readyDeadline = now() + (deps.readinessTimeoutMs ?? 120_000);
          while (true) {
            if (readiness(config, entry)) { finishReady(config, state); return; }
            if (child.exited() || now() >= readyDeadline) throw new Error('Candidate startup readiness was not acknowledged');
            await sleep(250);
          }
        } catch (error) {
          if (couldHaveRun) {
            entry.phase = 'startup_failed'; writeState(config, state);
            failed(config, entry.commit, 'Candidate startup readiness was not acknowledged', true);
          } else {
            if (['old_moving', 'old_moved', 'new_moving', 'new_installed', 'helper_switching', 'helper_selected', 'launching'].includes(entry.phase)) restoreBeforeLaunch(config, state, rename, selectHelper);
            else { delete state.activation; writeState(config, state); }
            failed(config, sourceCommit, 'Source activation or launch failed');
          }
          throw error;
        } finally { unlock(); }
      },
    };
  } catch (error) { unlock(); throw error; }
}
module.exports = { acknowledge, launch, prepare, processIdentity, recover, recoverStandalone, restorationPending, targetRunning };
