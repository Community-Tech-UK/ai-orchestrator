'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { commit, HELPER_FILES, paths } = require('./source-update-config.cjs');
const { acquireLock, checkBackoff, failed, readState, writeState } = require('./source-update-state.cjs');
const { checked, run } = require('./source-update-runtime.cjs');

const TRUSTED_ORIGIN = /^(?:https:\/\/github\.com\/Community-Tech-UK\/ai-orchestrator(?:\.git)?|git@github\.com:Community-Tech-UK\/ai-orchestrator(?:\.git)?|ssh:\/\/git@github\.com\/Community-Tech-UK\/ai-orchestrator(?:\.git)?)$/u;
const git = (config, runner, args, label) => checked(config, runner, 'git', args, label);
async function inspect(config, runner) {
  const root = await git(config, runner, ['rev-parse', '--show-toplevel'], 'Inspect source repository');
  const common = await git(config, runner, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'Inspect source ownership');
  if (fs.realpathSync(root) !== config.repositoryPath || fs.realpathSync(common) !== path.join(config.repositoryPath, '.git')) throw new Error('Source updates require the exact dedicated repository clone');
  const origin = await git(config, runner, ['remote', 'get-url', '--all', 'origin'], 'Inspect source origin');
  if (!TRUSTED_ORIGIN.test(origin)) throw new Error('Source origin must be the trusted Harness GitHub repository');
  const branch = await git(config, runner, ['branch', '--show-current'], 'Inspect source branch');
  if (branch !== 'main') throw new Error('Source repository must remain on main');
  const dirty = await git(config, runner, ['status', '--porcelain', '--untracked-files=all'], 'Inspect clean source');
  if (dirty) throw new Error('Source repository must be clean; local changes were preserved');
  return commit(await git(config, runner, ['rev-parse', 'HEAD'], 'Inspect source commit'));
}
async function ancestor(config, runner, from, to) {
  const result = await runner('git', ['merge-base', '--is-ancestor', from, to], { cwd: config.repositoryPath, timeoutMs: 60_000 });
  if (result.code > 1) throw new Error('Could not establish source ancestry');
  return result.code === 0;
}
async function fetchTarget(config, runner) {
  await git(config, runner, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'Fetch source branch');
  return commit(await git(config, runner, ['rev-parse', 'refs/remotes/origin/main'], 'Inspect remote commit'));
}
function noPending(config, state) {
  if (state.activation && !['acknowledged', 'startup_failed'].includes(state.activation.phase)) throw new Error('An earlier source update is still awaiting recovery or readiness');
  if (require('./source-update-activation.cjs').restorationPending(config, state)) throw new Error('Idle conversations still await restoration before another source update');
}
async function probe(config, request, deps = {}) {
  const installed = commit(request.installedCommit);
  const release = acquireLock(config);
  try {
    const runner = deps.run ?? run;
    await require('./source-update-activation.cjs').recover(config);
    const state = readState(config); noPending(config, state);
    const head = await inspect(config, runner);
    const target = await fetchTarget(config, runner);
    if (head !== target && !(await ancestor(config, runner, head, target)) && !(await ancestor(config, runner, target, head))) throw new Error('Source repository ancestry has diverged');
    checkBackoff(state, target);
    if (target === installed || await ancestor(config, runner, target, installed)) {
      state.installedCommit = installed; delete state.offeredCommit; writeState(config, state);
      return { available: false };
    }
    if (!(await ancestor(config, runner, installed, target))) throw new Error('Installed build ancestry has diverged from the source branch');
    state.installedCommit = installed; state.offeredCommit = target; writeState(config, state);
    return { available: true, commit: target };
  } finally { release(); }
}
function npmCli(config) {
  const prefix = path.dirname(config.nodePath);
  const choices = [path.resolve(prefix, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(prefix, 'node_modules/npm/bin/npm-cli.js')];
  const found = choices.find(file => fs.existsSync(file));
  if (!found) throw new Error('The configured Node installation has no npm');
  return found;
}
function packageArguments(output) {
  return ['--mac', '--dir', '--arm64', '--publish=never', '--config.mac.notarize=false', '--config.mac.timestamp=none',
    '--config.mac.sign=scripts/sign-local-macos.js', '--config.afterPack=scripts/localbuild-after-pack.js', `--config.directories.output=${output}`];
}
async function packageApp(config, _sourceCommit, runner) {
  const npm = npmCli(config);
  const execute = (args, label, timeout) => checked(config, runner, config.nodePath, [npm, ...args], label, timeout);
  await execute(['ci', '--no-audit', '--no-fund'], 'Install locked dependencies', 30 * 60_000);
  await execute(['run', 'rebuild:native'], 'Prepare native dependencies', 20 * 60_000);
  await execute(['run', 'build'], 'Build complete application', 30 * 60_000);
  const output = path.join(config.repositoryPath, 'release', 'home-base-source');
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Packaging output must not be a symlink');
    fs.rmSync(output, { recursive: true });
  }
  await execute(['run', 'electron:build', '--', ...packageArguments(output)], 'Package signed application', 30 * 60_000);
  return path.join(output, 'mac-arm64', 'Harness.app');
}
function readStamp(app) {
  // Read only the small stamped file from ASAR. This stable helper deliberately
  // has no dependency on mutable node_modules in the candidate checkout.
  const archive = path.join(app, 'Contents/Resources/app.asar');
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('Invalid packaged source stamp');
    const headerSize = prefix.readUInt32LE(4); const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || headerSize > 32 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error('Invalid packaged source stamp');
    const header = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, header, 0, jsonSize, 16) !== jsonSize) throw new Error('Invalid packaged source stamp');
    const files = JSON.parse(header.toString('utf8')).files;
    if (!files?.dist?.files?.main?.files?.updates?.files?.['source-update-runtime.js']) throw new Error('Packaged app does not contain the source updater runtime');
    const entry = files?.dist?.files?.['build-info.json'];
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 65536 || !/^\d+$/u.test(entry.offset)) throw new Error('Invalid packaged source stamp');
    const offset = 8 + headerSize + Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset + entry.size > fs.fstatSync(fd).size) throw new Error('Invalid packaged source stamp');
    const stamp = Buffer.alloc(entry.size);
    if (fs.readSync(fd, stamp, 0, entry.size, offset) !== entry.size) throw new Error('Invalid packaged source stamp');
    return JSON.parse(stamp.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
async function verifyApp(config, app, sourceCommit, runner = run) {
  if (!fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink()) throw new Error('Signed candidate app is missing or invalid');
  const metadata = async target => {
    const verified = await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { timeoutMs: 60_000 });
    if (verified.code !== 0) throw new Error('Application signature verification failed');
    const result = await runner('/usr/bin/codesign', ['-dv', '--verbose=4', target], { timeoutMs: 60_000 });
    const text = `${result.stdout}\n${result.stderr}`;
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(text)?.[1];
    if (result.code !== 0 || !team) throw new Error('Application needs a real code-signing Team ID');
    return { team, identifier: /^Identifier=(.+)$/mu.exec(text)?.[1] };
  };
  const installed = await metadata(config.appPath);
  const candidate = app === config.appPath ? installed : await metadata(app);
  const helper = await metadata(path.join(app, 'Contents/Resources/desktop-helper/desktop-helper'));
  if (installed.identifier !== 'com.ai.orchestrator' || candidate.identifier !== installed.identifier || candidate.team !== installed.team || helper.team !== candidate.team) throw new Error('Candidate and installed app signing identities do not match');
  const stamp = readStamp(app);
  if (stamp.commit !== commit(sourceCommit) || stamp.dirty !== false || stamp.branch !== 'main') throw new Error('Packaged source stamp does not match the requested clean commit');
}
function assertHelpers(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || fs.readdirSync(directory).sort().join(',') !== [...HELPER_FILES].sort().join(',')) throw new Error('Updater helper directory must contain only its six managed modules');
  for (const name of HELPER_FILES) {
    const file = fs.lstatSync(path.join(directory, name));
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid()) throw new Error('Invalid updater helper module');
  }
}
async function stageHelpers(config, target, runner, state) {
  const destination = paths(config, target).candidateHelper;
  const temporary = `${destination}.${randomUUID()}.staging`;
  if (fs.existsSync(destination)) {
    if (state.candidate?.commit !== target || state.candidate.helperPath !== destination) throw new Error('Candidate helper path is not owned by this updater');
    assertHelpers(destination); fs.rmSync(destination, { recursive: true });
  }
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const name of HELPER_FILES) {
      const source = path.join(config.repositoryPath, 'scripts/home-base', name);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source commit does not contain the complete updater helper');
      await checked(config, runner, config.nodePath, ['--check', source], 'Validate candidate helper');
      fs.copyFileSync(source, path.join(temporary, name)); fs.chmodSync(path.join(temporary, name), 0o700);
    }
    assertHelpers(temporary); fs.renameSync(temporary, destination);
    return destination;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function build(config, request, deps = {}) {
  const target = commit(request.commit); const release = acquireLock(config);
  try {
    const runner = deps.run ?? run;
    await require('./source-update-activation.cjs').recover(config);
    const state = readState(config); noPending(config, state); checkBackoff(state, target);
    if (state.offeredCommit !== target || !state.installedCommit) throw new Error('Run a source update probe before building a candidate');
    const head = await inspect(config, runner);
    const remote = await fetchTarget(config, runner);
    if (remote !== target || !(await ancestor(config, runner, head, target)) || state.installedCommit === target
      || !(await ancestor(config, runner, commit(state.installedCommit), target))) throw new Error('Requested source commit is no longer a forward remote update');
    // No reset, checkout or force-clean: a failed build leaves any local edits.
    if (head !== target) await git(config, runner, ['merge', '--ff-only', '--quiet', target], 'Advance dedicated source clone');
    let createdApp; let createdHelpers;
    try {
      const packed = await (deps.packageApp ?? ((cfg, source) => packageApp(cfg, source, runner)))(config, target);
      if (await inspect(config, runner) !== target) throw new Error('Source changed during application build');
      const verify = deps.verifyApp ?? ((app, source) => verifyApp(config, app, source, runner));
      await verify(packed, target);
      const appPath = paths(config, target).candidate;
      if (fs.existsSync(appPath)) {
        if (state.candidate?.commit !== target || state.candidate.appPath !== appPath || fs.lstatSync(appPath).isSymbolicLink()) throw new Error('Candidate path already contains an unowned app');
        fs.rmSync(appPath, { recursive: true });
      }
      const temporary = `${appPath}.${randomUUID()}.staging`;
      try {
        fs.cpSync(packed, temporary, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        await verify(temporary, target);
        if (await inspect(config, runner) !== target) throw new Error('Source changed during application staging');
        fs.renameSync(temporary, appPath); createdApp = appPath;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      const helperPath = await stageHelpers(config, target, runner, state); createdHelpers = helperPath;
      if (await inspect(config, runner) !== target) throw new Error('Source changed during helper staging');
      state.candidate = { commit: target, appPath, helperPath }; delete state.failed;
      writeState(config, state);
      return { commit: target, appPath };
    } catch (error) {
      if (createdApp) fs.rmSync(createdApp, { recursive: true, force: true });
      if (createdHelpers) fs.rmSync(createdHelpers, { recursive: true, force: true });
      failed(config, target, 'Candidate build or verification failed'); throw error;
    }
  } finally { release(); }
}
module.exports = { assertHelpers, build, inspect, packageArguments, probe, readStamp, verifyApp };
