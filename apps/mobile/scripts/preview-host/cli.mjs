#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createPreviewHost } from './server.mjs';

const fixturePort = Number(process.env['HARNESS_PREVIEW_PORT'] || 4173);
const angularPort = Number(process.env['HARNESS_PREVIEW_ANGULAR_PORT'] || 4200);
const publicHost = process.env['HARNESS_PREVIEW_HOST'] || '127.0.0.1';
const bindHost = process.env['HARNESS_PREVIEW_BIND'] || '127.0.0.1';
const scenarioArgument = process.argv.find((argument) => argument.startsWith('--scenario='));
const initialScenario = scenarioArgument?.slice('--scenario='.length) || 'default';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const angular = spawn(npx, [
  'ng', 'serve',
  '--host', '127.0.0.1',
  '--port', String(angularPort),
  '--live-reload=false',
], { cwd: process.cwd(), stdio: 'inherit' });

const preview = await createPreviewHost({
  port: fixturePort,
  host: bindHost,
  publicHost,
  scenario: initialScenario,
  upstreamOrigin: `http://127.0.0.1:${angularPort}`,
});

console.log('\nHarness mobile preview');
console.log(`Open: ${preview.baseUrl}/?scenario=${preview.scenario()}`);
console.log('Paste this connection code in Add host:');
console.log(preview.pairingCode);
console.log('Scenarios: default, streaming, gap, disconnect, 401, empty-inbox, offline, stale-probe, transcript-1000\n');

let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  angular.kill('SIGTERM');
  await preview.close().catch(() => undefined);
  process.exitCode = exitCode;
}

angular.on('exit', (code, signal) => {
  if (!stopping) void stop(signal ? 1 : (code ?? 1));
});
process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });
