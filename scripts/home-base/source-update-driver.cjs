#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { readConfig } = require('./source-update-config.cjs');
const builder = require('./source-update-build.cjs');
const activation = require('./source-update-activation.cjs');
const { stopChildren } = require('./source-update-runtime.cjs');

function channel(input) {
  let buffer = ''; let ended = false; let fault; let waiter; let received = 0; let bytes = 0;
  const queue = [];
  const wake = () => { const current = waiter; waiter = undefined; current?.(); };
  const add = text => {
    if (!text.trim()) return;
    if (++received > 2) { fault = new Error('Too many source updater protocol messages'); return; }
    queue.push(text);
  };
  const data = chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 512 * 1024) { fault = new Error('Source updater request is too large'); wake(); return; }
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) { add(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    wake();
  };
  const end = () => { add(buffer); buffer = ''; ended = true; wake(); };
  const error = () => { fault = new Error('Source updater input closed unexpectedly'); wake(); };
  input.on('data', data); input.on('end', end); input.on('error', error);
  return {
    async read(timeout = 30_000) {
      const deadline = Date.now() + timeout;
      while (!fault && !queue.length && !ended) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Source updater handshake timed out');
        await new Promise(resolve => { const timer = setTimeout(() => { waiter = undefined; resolve(); }, remaining); waiter = () => { clearTimeout(timer); resolve(); }; });
      }
      if (fault) throw fault;
      if (!queue.length) return null;
      let value; try { value = JSON.parse(queue.shift()); } catch { throw new Error('Invalid source updater JSON request'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source updater JSON request');
      return value;
    },
    dispose() { input.off('data', data); input.off('end', end); input.off('error', error); input.pause(); },
  };
}
function keys(value, required, optional = []) {
  if (!value || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid source updater request fields');
}
async function protocol(command, config, input = process.stdin, output = process.stdout, deps = {}) {
  const messages = channel(input);
  const reply = value => output.write(JSON.stringify(value) + '\n');
  let prepared;
  try {
    const request = await messages.read();
    if (command === 'probe') { keys(request, ['installedCommit']); reply(await (deps.probe ?? builder.probe)(config, request)); }
    else if (command === 'build') { keys(request, ['commit']); reply(await (deps.build ?? builder.build)(config, request)); }
    else if (command === 'recover') { keys(request, []); reply(await (deps.recoverStandalone ?? activation.recoverStandalone)(config)); }
    else if (command === 'ack') {
      keys(request, ['commit', 'pid'], ['restored']);
      if (Object.hasOwn(request, 'restored') && request.restored !== true) throw new Error('Invalid source readiness acknowledgement');
      reply(await (deps.acknowledge ?? activation.acknowledge)(config, request));
    } else if (command === 'activate') {
      keys(request, ['commit', 'appPath', 'parentPid', 'sessions']);
      prepared = await (deps.prepare ?? activation.prepare)(config, request);
      reply({ ready: true });
      const action = await messages.read(deps.handoffTimeoutMs ?? 30_000);
      if (!action) { await prepared.abort(); return; }
      keys(action, ['action']);
      if (action.action === 'abort') { await prepared.abort(); return; }
      if (action.action !== 'commit') throw new Error('Invalid source activation handoff');
      // EOF after this point is normal: the old app closes its pipe as it quits.
      messages.dispose();
      await prepared.commit();
    } else throw new Error('Unknown source updater operation');
  } catch (error) { await prepared?.abort(); throw error; }
  finally { messages.dispose(); }
}
const SAFE_ERRORS = new Set([
  'Source updates are only supported on the configured Mac', 'Invalid source updater command',
  'Updater entrypoint does not match its configured stable installation',
  'This source update failed earlier; waiting for another commit or retry window',
  'Source repository must be clean; local changes were preserved', 'Source repository must remain on main',
  'Source origin must be the trusted Harness GitHub repository', 'Source repository ancestry has diverged',
  'Installed build ancestry has diverged from the source branch', 'Could not establish source ancestry',
  'Source updater is already busy', 'An earlier source update is still awaiting recovery or readiness',
  'Candidate application is still awaiting readiness', 'Source activation parent did not exit before timeout',
  'Candidate startup readiness was not acknowledged', 'Application signature verification failed',
  'Idle conversations still await restoration before another source update',
  'Run a source update probe before building a candidate',
  'Candidate and installed app signing identities do not match', 'Packaged source stamp does not match the requested clean commit',
  'Source updater handshake timed out', 'Invalid source updater JSON request', 'Invalid source updater request fields',
]);
function safeError(error) {
  const message = error instanceof Error ? error.message : '';
  if (SAFE_ERRORS.has(message)) return message;
  const stages = ['Fetch source branch', 'Install locked dependencies', 'Prepare native dependencies', 'Build complete application', 'Package signed application'];
  if (stages.some(stage => message === `${stage} failed` || message === `${stage} failed or timed out`)) return message;
  return 'Source update helper could not complete this request';
}
async function main(args, options = {}) {
  if (args.length !== 3 || !['probe', 'build', 'activate', 'ack', 'recover'].includes(args[0]) || args[1] !== '--config') throw new Error('Invalid source updater command');
  if (process.platform !== 'darwin') throw new Error('Source updates are only supported on the configured Mac');
  const config = readConfig(args[2]);
  if (fs.realpathSync(config.driverPath) !== fs.realpathSync(options.entrypoint ?? __filename) || fs.realpathSync(config.nodePath) !== fs.realpathSync(process.execPath)) throw new Error('Updater entrypoint does not match its configured stable installation');
  await protocol(args[0], config);
}
function runCli(args, options = {}) {
  // Parent stdout may disappear after commit. Never turn that normal close into
  // a crash halfway through the recoverable bundle replacement.
  process.stdout.on('error', error => { if (error.code !== 'EPIPE') process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopChildren('SIGTERM');
    setTimeout(() => { stopChildren('SIGKILL'); process.exit(1); }, 2000);
  });
  main(args, options).catch(error => {
    process.stdout.write(JSON.stringify({ error: safeError(error) }) + '\n');
    process.exitCode = 1;
  });
}
if (require.main === module) runCli(process.argv.slice(2));
module.exports = { main, protocol, runCli, safeError };
