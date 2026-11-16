#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Never confuse another packaged test copy, or a helper process, with home base. */
function checkHarness({ appPath, pausePath, exists, processPaths, reopen, sourceUpdates }) {
  if (exists(pausePath)) return 'paused';
  const update = sourceUpdates();
  if (update === 'busy') return 'updating';
  if (update === 'blocked') return 'source-update-failed';
  if (!exists(appPath)) return 'not-installed';
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Harness');
  if (processPaths().split(/\r?\n/).some(line => line.trim() === executable)) return 'running';
  reopen(appPath);
  return 'reopened';
}

function sourceUpdateStatus(home, dryRun) {
  const folder = path.join(home, '.orchestrator', 'home-base');
  const config = path.join(folder, 'source-updates.json');
  if (!fs.existsSync(config)) return 'ready';
  try {
    if (dryRun) {
      const journal = path.join(folder, 'source-update-state.json');
      if (!fs.existsSync(journal)) return 'ready';
      const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source state');
      const phase = value.activation?.phase;
      return phase === 'startup_failed' ? 'blocked' : phase && phase !== 'acknowledged' ? 'busy' : 'ready';
    }
    const result = JSON.parse(execFileSync(process.execPath,
      [path.join(folder, 'source-update-launcher.cjs'), 'recover', '--config', config],
      { input: '{}', encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 }));
    if (!result || !['ready', 'busy', 'blocked'].includes(result.status)) throw new Error('Invalid source recovery status');
    return result.status;
  } catch {
    throw new Error('Source update recovery could not finish. Harness was left closed; inspect the update log.');
  }
}

function launchAgentPlist(node, script) {
  const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.harness.home-base.reopen</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
}

function install() {
  const home = os.homedir();
  const folder = path.join(home, '.orchestrator', 'home-base');
  const script = path.join(folder, 'reopen-harness.js');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.harness.home-base.reopen.plist');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  // First launch must be James's desktop session, before automatic reopen is enabled.
  if (!fs.existsSync(plist)) fs.writeFileSync(path.join(home, '.orchestrator', 'home-base-reopen.paused'), '', { mode: 0o600 });
  if (path.resolve(__filename) !== script) fs.copyFileSync(__filename, script);
  fs.chmodSync(script, 0o700);
  fs.writeFileSync(plist, launchAgentPlist(process.execPath, script), { mode: 0o600 });
  console.log('Prepared crash reopen (five minutes). It is paused until first launch and setup finish.');
  console.log('LaunchAgent: ' + plist);
  console.log('Pause file: ' + path.join(home, '.orchestrator', 'home-base-reopen.paused'));
  console.log('Load with: launchctl bootstrap gui/' + process.getuid() + ' ' + plist);
}

function main(args) {
  if (process.platform !== 'darwin') throw new Error('This crash-reopen check is for the home-base Mac.');
  if (args.includes('--install')) return install();
  const dryRun = args.includes('--status');
  const result = checkHarness({
    appPath: path.join(os.homedir(), 'Applications', 'Harness.app'),
    pausePath: path.join(os.homedir(), '.orchestrator', 'home-base-reopen.paused'),
    exists: fs.existsSync,
    sourceUpdates: () => sourceUpdateStatus(os.homedir(), dryRun),
    processPaths: () => execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 10000 }),
    reopen: appPath => { if (!dryRun) execFileSync('/usr/bin/open', ['-a', appPath], { timeout: 10000 }); },
  });
  console.log(dryRun && result === 'reopened' ? 'would-reopen' : result);
}

module.exports = { checkHarness, launchAgentPlist, sourceUpdateStatus };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
