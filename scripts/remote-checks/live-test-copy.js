'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getElectronBuilderArgs } = require('../localbuild');

const PROFILE_MARKER = '.aio-livetest-profile.json';
function canonical(file) {
  const resolved = path.resolve(file).replace(/^\/tmp(?=\/|$)/, fs.realpathSync('/tmp'));
  const actual = fs.realpathSync(file);
  if (actual !== resolved) throw new Error('Live-test paths must be canonical, without symlinked children');
  return actual;
}

function prepareOwner({ root, data, executablePath, mode, tree, port }) {
  root = canonical(root);
  if (!['dev', 'packaged'].includes(mode) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)
    || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid live-test ownership');
  if (!path.isAbsolute(data) || !path.resolve(data).startsWith('/tmp/aio-lt-') && !path.resolve(data).startsWith(`${fs.realpathSync('/tmp')}/aio-lt-`)) {
    throw new Error('Live-test profile must be under /tmp/aio-lt-');
  }
  const existed = fs.existsSync(data);
  if (!existed) {
    // Resolve ancestors before creating anything: a link below /tmp/aio-lt- may point into everyday state.
    let ancestor = path.dirname(data);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    canonical(ancestor);
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  }
  const dataPath = canonical(data);
  const marker = path.join(dataPath, PROFILE_MARKER);
  if (existed) {
    if (!fs.existsSync(marker)) throw new Error('Existing live-test profile is not owned by this runner');
    const previous = JSON.parse(fs.readFileSync(canonical(marker), 'utf8'));
    if (previous.schemaVersion !== 1 || previous.mode !== mode || previous.dataPath !== dataPath) {
      throw new Error('Existing live-test profile belongs to a different mode or directory');
    }
  } else {
    fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, mode, dataPath }), { mode: 0o600, flag: 'wx' });
  }
  for (const dir of [root, dataPath]) {
    if (process.getuid && fs.statSync(dir).uid !== process.getuid()) throw new Error('Live-test directory belongs to another user');
    fs.chmodSync(dir, 0o700);
  }
  executablePath = fs.realpathSync(executablePath);
  if (mode === 'packaged' && !executablePath.startsWith(`${root}${path.sep}`)) throw new Error('Package must be inside its owned copy');
  const owner = { schemaVersion: 1, mode, tree, dataPath, executablePath, port };
  fs.writeFileSync(path.join(root, 'livetest-owner.json'), JSON.stringify(owner), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'executable'), executablePath);
  fs.rmSync(path.join(root, 'runtime.json'), { force: true });
  return owner;
}

function readRuntime(root) {
  const owner = JSON.parse(fs.readFileSync(path.join(root, 'livetest-owner.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
  for (const key of ['schemaVersion', 'mode', 'tree', 'dataPath', 'executablePath', 'port']) {
    if (owner[key] !== runtime[key]) throw new Error(`Live-test runtime ${key} does not match its owner`);
  }
  if (runtime.ready !== true || runtime.isPackaged !== (owner.mode === 'packaged')
    || !Number.isInteger(runtime.pid) || runtime.pid <= 0) throw new Error('Owned live-test runtime is not ready');
  return runtime;
}

function packagedBuildArgs(output, identity) {
  return [...getElectronBuilderArgs('darwin').filter(arg => arg !== 'dmg'), '--dir', '--publish=never',
    '--config.forceCodeSigning=true', `--config.mac.identity=${identity}`, `--config.directories.output=${output}`];
}

/** npm list drops nested versions/paths through a linked node_modules root. Clone only into this owned copy. */
function materializePackageDependencies(root) {
  const target = path.join(root, 'repo', 'node_modules');
  if (!fs.lstatSync(target).isSymbolicLink()) return;
  const staged = path.join(root, 'repo', 'node_modules-packaging');
  try {
    fs.cpSync(fs.realpathSync(target), staged, {
      recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
    });
    fs.unlinkSync(target);
    fs.renameSync(staged, target);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function buildPackage(root) {
  if (process.platform !== 'darwin') throw new Error('Packaged live tests require the test Mac');
  const { readInstalledCodeSigningIdentities, selectCodeSigningIdentity } = require('../sign-local-macos');
  const { verifyMacHelperIdentity } = require('../verify-macos-helper-identity');
  const { findAppBundle } = require('../localbuild-after-pack');
  // Inspect metadata only. Never export signing keys, bypass signing, install, publish or restart the everyday app.
  const identity = selectCodeSigningIdentity(readInstalledCodeSigningIdentities());
  materializePackageDependencies(root);
  const output = path.join(root, 'repo', 'release-livetest');
  const run = (args) => {
    const result = spawnSync('npm', args, { cwd: path.join(root, 'repo'), stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Live-test package command failed (${result.status ?? 'spawn'})`);
  };
  run(['run', 'build']);
  run(['run', 'electron:build', '--', ...packagedBuildArgs(output, identity.name)]);
  const bundle = findAppBundle(path.join(output, 'mac-arm64'));
  verifyMacHelperIdentity(bundle);
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  if (verified.error || verified.status !== 0) throw new Error('Packaged live-test signature verification failed');
  fs.writeFileSync(path.join(root, 'bundle'), bundle);
}

if (require.main === module) {
  const [command, root, data, executablePath, mode, tree, port] = process.argv.slice(2);
  try {
    if (command === 'prepare') prepareOwner({ root, data, executablePath, mode, tree, port: Number(port) });
    else if (command === 'ready') process.stdout.write(`${JSON.stringify(readRuntime(root))}\n`);
    else if (command === 'package') buildPackage(root);
    else throw new Error('Unknown live-test copy command');
  } catch (error) {
    if (command !== 'ready') process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepareOwner, readRuntime, packagedBuildArgs, materializePackageDependencies };
