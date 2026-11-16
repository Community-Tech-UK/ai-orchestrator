'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_KEYS = ['version', 'repositoryPath', 'remote', 'branch', 'appPath', 'nodePath', 'driverPath'];
const SESSION_KEYS = ['instanceId', 'historyEntryId', 'providerSessionId', 'workingDirectory', 'accountProfileId'];
function absolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/u.test(value);
}
function within(root, value) { return value === root || value.startsWith(root + path.sep); }
function commit(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) throw new Error('Invalid source commit');
  return value;
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Updater configuration must not be a symlink');
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) throw new Error('Updater configuration must be private and owned by this user');
}
function readConfig(file) {
  if (!absolute(file)) throw new Error('Updater configuration path must be absolute');
  privateFile(file);
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!input || Array.isArray(input) || Object.keys(input).length !== CONFIG_KEYS.length
    || CONFIG_KEYS.some(key => !Object.hasOwn(input, key)) || input.version !== 1 || input.remote !== 'origin' || input.branch !== 'main'
    || ['repositoryPath', 'appPath', 'nodePath', 'driverPath'].some(key => !absolute(input[key]))) throw new Error('Invalid updater configuration');
  const stateDirectory = path.dirname(file);
  const directoryStat = fs.statSync(stateDirectory);
  if (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o022)) throw new Error('Updater configuration directory must be private');
  for (const location of [input.repositoryPath, stateDirectory, path.dirname(input.appPath), path.dirname(input.driverPath)]) {
    if (fs.realpathSync(location) !== location) throw new Error('Updater paths must not use symlink directories');
  }
  if (!input.appPath.endsWith('.app') || path.basename(input.nodePath) !== 'node' || path.basename(input.driverPath) !== 'source-update-launcher.cjs'
    || !fs.statSync(input.nodePath).isFile() || !fs.lstatSync(input.driverPath).isFile() || fs.lstatSync(input.driverPath).isSymbolicLink()) throw new Error('Invalid updater configuration paths');
  const repoStat = fs.lstatSync(input.repositoryPath);
  const gitStat = fs.lstatSync(path.join(input.repositoryPath, '.git'));
  if (!repoStat.isDirectory() || repoStat.uid !== process.getuid() || !gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('Source updates require a dedicated repository clone');
  if (within(input.repositoryPath, input.driverPath) || within(input.repositoryPath, stateDirectory)
    || within(input.repositoryPath, input.appPath) || within(input.appPath, input.driverPath)) throw new Error('Updater driver, state and app must be outside the source clone');
  const helperDirectory = path.join(path.dirname(input.driverPath), 'source-updater');
  if (within(helperDirectory, stateDirectory) || within(helperDirectory, input.repositoryPath) || within(helperDirectory, input.appPath)
    || within(input.appPath, stateDirectory) || within(input.appPath, input.repositoryPath)) throw new Error('Updater helper directory must be separate from configuration, repository and app data');
  return { ...input, stateDirectory };
}
function validateSessions(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid updater session identities');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !SESSION_KEYS.includes(key))
      || ['instanceId', 'historyEntryId', 'workingDirectory'].some(key => typeof entry[key] !== 'string' || !entry[key])
      || Object.values(entry).some(field => typeof field !== 'string' || field.length > 4096 || /[\0\r\n]/u.test(field))) throw new Error('Invalid updater session identities');
    return { ...entry };
  });
}
function paths(config, sourceCommit) {
  const helperDirectory = path.join(path.dirname(config.driverPath), 'source-updater');
  return {
    candidate: sourceCommit ? path.join(path.dirname(config.appPath), `.${path.basename(config.appPath)}.source-${commit(sourceCommit)}.app`) : undefined,
    previous: path.join(path.dirname(config.appPath), `.${path.basename(config.appPath)}.source-previous.app`),
    appLock: path.join(path.dirname(config.appPath), `.${path.basename(config.appPath)}.source-update-lock`),
    state: path.join(config.stateDirectory, 'source-update-state.json'),
    helperDirectory,
    candidateHelper: sourceCommit ? path.join(helperDirectory, 'versions', commit(sourceCommit)) : undefined,
    helperPointer: path.join(helperDirectory, 'current.json'),
  };
}
const HELPER_FILES = ['source-update-driver.cjs', 'source-update-config.cjs', 'source-update-state.cjs', 'source-update-runtime.cjs', 'source-update-build.cjs', 'source-update-activation.cjs'];
module.exports = { absolute, commit, HELPER_FILES, paths, privateFile, readConfig, validateSessions, within };
