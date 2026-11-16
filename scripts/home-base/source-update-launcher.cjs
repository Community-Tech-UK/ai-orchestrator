#!/usr/bin/env node
'use strict';
// This deliberately tiny entry stays in place for the life of the installation.
// Only a private, atomic commit pointer chooses the replaceable driver payload.
const fs = require('node:fs');
const path = require('node:path');
const FILES = ['driver', 'config', 'state', 'runtime', 'build', 'activation'].map(name => `source-update-${name}.cjs`);
function owned(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || (directory ? !stat.isDirectory() : !stat.isFile()) || fs.realpathSync(file) !== file) throw new Error('Invalid updater installation');
  return stat;
}
function selectPayload(configFile, launcherPath = __filename) {
  if (!path.isAbsolute(configFile) || path.resolve(configFile) !== configFile) throw new Error('Invalid updater installation');
  const configStat = owned(configFile);
  if ((configStat.mode & 0o077) || configStat.size > 65536) throw new Error('Invalid updater installation');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  owned(launcherPath);
  if (config.version !== 1 || config.driverPath !== launcherPath) throw new Error('Invalid updater installation');
  const root = path.join(path.dirname(launcherPath), 'source-updater'); owned(root, true);
  const versions = path.join(root, 'versions'); owned(versions, true);
  const pointer = path.join(root, 'current.json');
  const pointerStat = owned(pointer);
  if ((pointerStat.mode & 0o077) || pointerStat.size > 256) throw new Error('Invalid updater payload pointer');
  const selected = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (Object.keys(selected).length !== 2 || selected.version !== 1 || !/^[a-f0-9]{40}$/u.test(selected.commit)) throw new Error('Invalid updater payload pointer');
  const directory = path.join(versions, selected.commit); owned(directory, true);
  if (fs.readdirSync(directory).sort().join(',') !== [...FILES].sort().join(',')) throw new Error('Incomplete updater payload');
  for (const name of FILES) owned(path.join(directory, name));
  return path.join(directory, 'source-update-driver.cjs');
}
function main(args) {
  if (args.length !== 3 || args[1] !== '--config') throw new Error('Invalid updater command');
  const payload = selectPayload(args[2]);
  require(payload).runCli(args, { entrypoint: __filename });
}
if (require.main === module) {
  process.stdout.on('error', error => {
    // The old app closes its pipe after committing the handoff.
    if (error.code !== 'EPIPE') process.exitCode = 1;
  });
  try { main(process.argv.slice(2)); }
  catch { process.stdout.write('{"error":"Source update installation could not be read safely"}\n'); process.exitCode = 1; }
}
module.exports = { main, selectPayload };
