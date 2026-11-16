import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, SourceUpdateConfig } from './source-update-types';
const require = createRequire(import.meta.url);
interface ProtocolDependencies {
  prepare: (config: SourceUpdateConfig, request: unknown) => Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }>;
  handoffTimeoutMs?: number;
}
const driver = () => require('./source-update-driver.cjs') as {
  protocol: (command: string, config: SourceUpdateConfig, input: PassThrough, output: PassThrough, deps: ProtocolDependencies) => Promise<void>;
};
const runtime = () => require('./source-update-runtime.cjs') as { run: Run };
const stateModule = () => require('./source-update-state.cjs') as {
  acquireLock: (config: SourceUpdateConfig) => () => void;
  exclusiveJson: (file: string, value: unknown) => boolean;
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'source-protocol-'))); roots.push(root);
  const config: SourceUpdateConfig = { version: 1, remote: 'origin', branch: 'main', repositoryPath: root, appPath: path.join(root, 'Harness.app'), nodePath: process.execPath, driverPath: path.join(root, 'driver.cjs'), stateDirectory: root };
  const input = new PassThrough(); const output = new PassThrough(); let result = '';
  output.on('data', data => { result += data.toString(); });
  return { root, config, input, output, result: () => result };
}
describe('source update standalone protocol', () => {
  it('emits ready before accepting commit and tolerates EOF after commit', async () => {
    const f = fixture(); let committed = false; let aborted = false;
    const running = driver().protocol('activate', f.config, f.input, f.output, { prepare: async () => ({ commit: async () => { committed = true; }, abort: async () => { aborted = true; } }) });
    f.input.write(JSON.stringify({ commit: 'b'.repeat(40), appPath: '/candidate', parentPid: 123, sessions: [] }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.result()).toBe('{"ready":true}\n'); expect(committed).toBe(false);
    f.input.end('{"action":"commit"}\n'); await running;
    expect(committed).toBe(true); expect(aborted).toBe(false);
  });
  it('aborts a prepared helper on stdin close or malformed handoff', async () => {
    const f = fixture(); let aborted = false;
    const running = driver().protocol('activate', f.config, f.input, f.output, { prepare: async () => ({ commit: async () => { throw new Error('must not commit'); }, abort: async () => { aborted = true; } }) });
    f.input.end('{"commit":"' + 'b'.repeat(40) + '","appPath":"/candidate","parentPid":123,"sessions":[]}\n');
    await running; expect(aborted).toBe(true);
  });
  it('aborts and releases a prepared handoff on malformed action', async () => {
    const f = fixture(); let aborted = false;
    const running = driver().protocol('activate', f.config, f.input, f.output, { prepare: async () => ({ commit: async () => { throw new Error('must not commit'); }, abort: async () => { aborted = true; } }) });
    f.input.end('{"commit":"' + 'b'.repeat(40) + '","appPath":"/candidate","parentPid":123,"sessions":[]}\n{"action":"unexpected"}\n');
    await expect(running).rejects.toThrow('handoff'); expect(aborted).toBe(true);
  });
  it('returns only controlled errors from the actual CLI', () => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/home-base/source-update-driver.cjs'), 'probe', '--config', '/no/such/private-config.json'], { input: '{"installedCommit":"placeholder"}\n', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty('error');
    expect(result.stdout + result.stderr).not.toContain('/no/such/private-config');
  });
  it('permits only one owner even when two configurations target the same app', () => {
    const f = fixture(); const release = stateModule().acquireLock(f.config);
    mkdirSync(path.join(f.root, 'other'));
    expect(() => stateModule().acquireLock({ ...f.config, stateDirectory: path.join(f.root, 'other') })).toThrow('busy');
    release(); const releaseNext = stateModule().acquireLock(f.config); releaseNext();
  });
  it('publishes complete readiness records once without replacing an existing acknowledgement', () => {
    const f = fixture(); const file = path.join(f.root, 'ready.json');
    expect(stateModule().exclusiveJson(file, { ready: true })).toBe(true);
    expect(stateModule().exclusiveJson(file, { ready: false })).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ready: true });
  });
  it('bounds subprocess time and terminates the actual child process', async () => {
    const f = fixture(); const pidFile = path.join(f.root, 'child.pid');
    const script = path.join(f.root, 'child.cjs'); writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
    await expect(runtime().run(process.execPath, [script, pidFile], { timeoutMs: 250 })).rejects.toThrow('timed out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('launches the tracked fixture child with the app bootstrap flag', async () => {
    const f = fixture(); const report = path.join(f.root, 'report.json');
    const binary = path.join(f.root, 'fixture-binary');
    writeFileSync(binary, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(report) + ', JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })); setInterval(() => {}, 1000);');
    chmodSync(binary, 0o700);
    const { launch } = require('./source-update-activation.cjs') as { launch: (file: string) => Promise<{ pid: number; exited: () => boolean }> };
    const child = await launch(binary);
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(report) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ pid: child.pid, args: ['--js-flags=--max-old-space-size=8192'] });
    } finally { try { process.kill(child.pid, 'SIGTERM'); } catch { /* fixture already exited */ } }
  });
});
