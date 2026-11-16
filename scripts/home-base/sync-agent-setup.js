#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSyncPackage, atomicWrite } = require('./sync-files');
const { applySyncPackage } = require('./sync-runtime');
const { filterCodexConfig } = require('./sync-policy');
const BEGIN = '# BEGIN Harness home-base setup sync';
const END = '# END Harness home-base setup sync';

function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function validateRemote(remote) {
  if (!/^[a-z0-9][a-z0-9_.@-]*$/i.test(remote)) throw new Error('Use a saved SSH host name without command options');
}
function renderSyncHook(text, { scriptPath, remote, destinationHome, remoteNode }) {
  validateRemote(remote);
  if (!path.isAbsolute(scriptPath) || !path.isAbsolute(destinationHome)
    || (remoteNode !== 'node' && (typeof remoteNode !== 'string' || !path.isAbsolute(remoteNode)))) throw new Error('Sync paths must be absolute');
  const block = `${BEGIN}\nnode ${shellQuote(scriptPath)} sync --remote ${shellQuote(remote)} --destination-home ${shellQuote(destinationHome)} --remote-node ${shellQuote(remoteNode)}\n${END}\n`;
  const first = text.indexOf(BEGIN); const last = text.indexOf(END);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) throw new Error('Existing setup sync block is incomplete; file left untouched');
  return first < 0 ? text.replace(/\n?$/, '\n') + block : text.slice(0, first) + block + text.slice(last + END.length).replace(/^\n/, '');
}
function syncRemote(pkg, { remote, destinationHome, remoteNode = 'node' }) {
  validateRemote(remote);
  if (!path.isAbsolute(destinationHome) || (remoteNode !== 'node' && !path.isAbsolute(remoteNode))) throw new Error('Remote paths must be absolute');
  const sshOptions = ['-oBatchMode=yes', '-oConnectTimeout=5', remote];
  const preflight = spawnSync('ssh', [...sshOptions, 'true'], { stdio: 'ignore', timeout: 10_000 });
  if (preflight.status !== 0) return { skipped: true };
  const esbuild = require('esbuild');
  const bundle = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'sync-runtime.js')], platform: 'node', target: 'node22',
    format: 'iife', globalName: 'homeBaseSetup', bundle: true, write: false, logLevel: 'silent' }).outputFiles[0].text;
  const encoded = Buffer.from(JSON.stringify(pkg)).toString('base64');
  const program = `${bundle}\ntry { const result = homeBaseSetup.applySyncPackage(JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8')), ${JSON.stringify({ destinationHome })}); console.log(JSON.stringify(result)); } catch { console.error('Remote setup preflight or apply refused. Existing login files were not transferred.'); process.exitCode = 1; }\n`;
  const result = spawnSync('ssh', [...sshOptions, shellQuote(remoteNode)], { input: program, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Remote setup sync did not finish successfully; inspect the destination setup before retrying');
  let report; try { report = JSON.parse(result.stdout.trim()); } catch { throw new Error('Remote setup sync returned an invalid report'); }
  return report;
}
function main(argv) {
  const command = argv[0]; const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!['--source-home', '--destination-home', '--remote', '--remote-node'].includes(key) || !value) throw new Error('Invalid setup sync option');
    options[key] = value;
  }
  const sourceHome = options['--source-home'] || os.homedir();
  if (command === 'install-hook') {
    const script = path.join(sourceHome, '.agents', 'sync-tool-files.sh');
    const text = fs.readFileSync(script, 'utf8');
    const next = renderSyncHook(text, { scriptPath: __filename, remote: options['--remote'], destinationHome: options['--destination-home'], remoteNode: options['--remote-node'] || 'node' });
    atomicWrite(script, next, fs.statSync(script).mode & 0o777);
    console.log('Added home-base setup sync to the existing global sync script.');
    return;
  }
  if (!['inspect', 'sync'].includes(command)) throw new Error('Use inspect, sync or install-hook');
  const pkg = buildSyncPackage({ sourceHome });
  if (command === 'inspect') {
    console.log(`Prepared ${pkg.files.length} approved setup files and ${pkg.assets.length} reviewed asset${pkg.assets.length === 1 ? '' : 's'}; excluded ${pkg.exclusions.length} setup items. Nothing was changed.`);
    return;
  }
  const result = syncRemote(pkg, { remote: options['--remote'], destinationHome: options['--destination-home'], remoteNode: options['--remote-node'] });
  if (result.skipped) console.log('Home-base setup sync skipped: the saved SSH connection did not answer its preflight.');
  else {
    console.log(`Home-base setup synced: ${result.changed} changes; ${result.exclusions} setup items excluded.`);
    for (const item of result.omitted) console.log(`Not copied because its local path is absent: ${item}`);
  }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    if (Array.isArray(error.refusals)) {
      const report = path.resolve(__dirname, '../../_scratch/home-base/sync-refusals.log');
      atomicWrite(report, error.refusals.join('\n') + '\n', 0o600);
      console.error(`Full filename-only refusal report: ${report}`);
    }
    process.exitCode = 1;
  }
}
module.exports = { buildSyncPackage, applySyncPackage, filterCodexConfig, renderSyncHook, syncRemote };
