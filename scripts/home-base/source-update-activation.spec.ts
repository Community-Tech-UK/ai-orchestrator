import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionIdentity, SourceUpdateConfig } from './source-update-types';
const require = createRequire(import.meta.url);
interface Dependencies {
  verifyApp: (app: string, commit: string) => Promise<void>;
  parentIdentity: (pid: number) => Promise<string | null>;
  targetRunning: () => Promise<boolean>;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  launch: (file: string) => Promise<{ pid: number; exited: () => boolean }>;
  rename?: (from: string, to: string) => void;
  switchHelper?: (commit: string) => void;
  parentTimeoutMs?: number;
  readinessTimeoutMs?: number;
}
const activation = () => require('./source-update-activation.cjs') as {
  prepare: (config: SourceUpdateConfig, request: unknown, deps: Dependencies) => Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }>;
  acknowledge: (config: SourceUpdateConfig, request: { commit: string; pid: number; restored?: boolean }, deps?: Partial<Dependencies>) => Promise<{ acknowledged: boolean; sessions: SessionIdentity[] }>;
  recover: (config: SourceUpdateConfig, deps?: Partial<Dependencies>) => Promise<void>;
  recoverStandalone: (config: SourceUpdateConfig, deps?: Partial<Dependencies>) => Promise<{ status: 'ready' | 'busy' | 'blocked' }>;
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'source-activate-'))); roots.push(root);
  const appPath = path.join(root, 'Harness.app'); mkdirSync(appPath); writeFileSync(path.join(appPath, 'marker'), 'old');
  const commit = 'b'.repeat(40);
  const staged = path.join(root, `.Harness.app.source-${commit}.app`); mkdirSync(staged); writeFileSync(path.join(staged, 'marker'), 'new');
  const helperDirectory = path.join(root, 'source-updater', 'versions', 'a'.repeat(40));
  const helperCandidate = path.join(root, 'source-updater', 'versions', commit);
  mkdirSync(helperDirectory, { recursive: true, mode: 0o700 }); mkdirSync(helperCandidate, { mode: 0o700 });
  for (const name of ['driver', 'config', 'state', 'runtime', 'build', 'activation']) {
    writeFileSync(path.join(helperDirectory, `source-update-${name}.cjs`), 'old helper', { mode: 0o600 });
    writeFileSync(path.join(helperCandidate, `source-update-${name}.cjs`), 'new helper', { mode: 0o600 });
  }
  const pointer = path.join(root, 'source-updater/current.json'); writeFileSync(pointer, JSON.stringify({ version: 1, commit: 'a'.repeat(40) }), { mode: 0o600 });
  const config: SourceUpdateConfig = { version: 1, repositoryPath: path.join(root, 'source'), remote: 'origin', branch: 'main', appPath, nodePath: process.execPath, driverPath: path.join(root, 'source-update-launcher.cjs'), stateDirectory: root };
  writeFileSync(config.driverPath, 'immutable launcher', { mode: 0o700 });
  const sessions = [{ instanceId: 'idle', historyEntryId: 'history', workingDirectory: '/work' }];
  const request = { commit, appPath: staged, parentPid: 123, sessions };
  let parent = true; let clock = 0; let launched = 0; let childExited = false;
  let onSleep: (() => Promise<void>) | undefined;
  const deps: Dependencies = {
    verifyApp: async () => undefined, parentIdentity: async () => parent ? 'exact-parent-start' : null,
    targetRunning: async () => parent, alive: () => !childExited,
    now: () => clock, sleep: async ms => { clock += ms; await onSleep?.(); },
    launch: async () => { launched++; return { pid: 456, exited: () => childExited }; },
    parentTimeoutMs: 1000, readinessTimeoutMs: 1000,
  };
  writeFileSync(path.join(root, 'source-update-state.json'), JSON.stringify({ candidate: { commit, appPath: staged, helperPath: helperCandidate } }), { mode: 0o600 });
  return { root, config, request, deps, staged, sessions, parentGone: () => { parent = false; }, exitChild: () => { childExited = true; }, onSleep: (fn: () => Promise<void>) => { onSleep = fn; }, launched: () => launched,
    state: () => JSON.parse(readFileSync(path.join(root, 'source-update-state.json'), 'utf8')),
    helper: () => readFileSync(path.join(root, 'source-updater', 'versions', JSON.parse(readFileSync(pointer, 'utf8')).commit, 'source-update-driver.cjs'), 'utf8'),
    marker: () => readFileSync(path.join(appPath, 'marker'), 'utf8') };
}
describe('source update activation', () => {
  it('prepares without replacing or launching and abort leaves the installed bundle intact', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps);
    expect(f.marker()).toBe('old'); expect(f.launched()).toBe(0);
    await prepared.abort(); expect(f.marker()).toBe('old'); expect(f.launched()).toBe(0);
    expect(f.state().activation).toBeUndefined();
  });
  it('times out while the exact parent remains alive without touching its app', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps);
    await expect(prepared.commit()).rejects.toThrow('parent');
    expect(f.marker()).toBe('old'); expect(f.launched()).toBe(0);
  });
  it('swaps only after parent exit and accepts readiness only from the exact launched PID', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps);
    f.parentGone(); let acknowledged = false;
    f.onSleep(async () => {
      if (!f.launched() || acknowledged) return;
      expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 999 }, f.deps)).toEqual({ acknowledged: false, sessions: [] });
      expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 456 }, f.deps)).toEqual({ acknowledged: true, sessions: f.sessions });
      acknowledged = true;
    });
    await prepared.commit();
    expect(f.marker()).toBe('new'); expect(f.launched()).toBe(1); expect(f.state().installedCommit).toBe(f.request.commit);
    expect(f.helper()).toBe('new helper'); expect(readFileSync(f.config.driverPath, 'utf8')).toBe('immutable launcher');
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 456 }, f.deps)).toEqual({ acknowledged: true, sessions: f.sessions });
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 456, restored: true }, f.deps)).toEqual({ acknowledged: true, sessions: [] });
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 456 }, f.deps)).toEqual({ acknowledged: true, sessions: [] });
  });
  it('restores the prior app if the second rename fails', async () => {
    const f = fixture();
    f.deps.rename = (from, to) => { if (from === f.staged) throw new Error('fixture rename failed'); renameSync(from, to); };
    const prepared = await activation().prepare(f.config, f.request, f.deps); f.parentGone();
    await expect(prepared.commit()).rejects.toThrow('rename');
    expect(f.marker()).toBe('old'); expect(f.launched()).toBe(0);
  });
  it('returns unfinished restoration identities to a later verified bootstrap', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps); f.parentGone();
    f.onSleep(async () => { if (f.launched()) await activation().acknowledge(f.config, { commit: f.request.commit, pid: 456 }, f.deps); });
    await prepared.commit();
    const later = { ...f.deps, parentIdentity: async (pid: number) => pid === 789 ? 'verified-later-app' : null };
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 789 }, later)).toEqual({ acknowledged: true, sessions: f.sessions });
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 789, restored: true }, later)).toEqual({ acknowledged: true, sessions: [] });
    expect(await activation().acknowledge(f.config, { commit: f.request.commit, pid: 789 }, later)).toEqual({ acknowledged: true, sessions: [] });
  });
  it('restores the prior bundle if spawning fails before any candidate can execute', async () => {
    const f = fixture(); f.deps.launch = async () => { throw new Error('fixture launch failed'); };
    const prepared = await activation().prepare(f.config, f.request, f.deps); f.parentGone();
    await expect(prepared.commit()).rejects.toThrow('launch'); expect(f.marker()).toBe('old');
    expect(f.helper()).toBe('old helper');
  });
  it('restores app and helper together if installing the new stable helper fails', async () => {
    const f = fixture();
    f.deps.switchHelper = source => {
      if (source === f.request.commit) throw new Error('helper selection failed');
      writeFileSync(path.join(f.root, 'source-updater/current.json'), JSON.stringify({ version: 1, commit: source }));
    };
    const prepared = await activation().prepare(f.config, f.request, f.deps); f.parentGone();
    await expect(prepared.commit()).rejects.toThrow('helper selection');
    expect(f.marker()).toBe('old'); expect(f.helper()).toBe('old helper'); expect(f.launched()).toBe(0);
  });
  it('retains new and prior bundles after early child exit without downgrading user data', async () => {
    const f = fixture(); const data = path.join(f.root, 'user-data'); writeFileSync(data, 'migrated data');
    const prepared = await activation().prepare(f.config, f.request, f.deps); f.parentGone(); f.exitChild();
    await expect(prepared.commit()).rejects.toThrow('readiness');
    expect(f.marker()).toBe('new'); expect(existsSync(path.join(f.root, '.Harness.app.source-previous.app'))).toBe(true);
    expect(readFileSync(data, 'utf8')).toBe('migrated data');
    expect(f.state().failed).toMatchObject({ commit: f.request.commit, permanent: true });
  });
  it('recovers an interrupted first rename, but never rolls back an uncertain launch', async () => {
    const f = fixture(); await activation().prepare(f.config, f.request, f.deps);
    const state = f.state(); state.activation.phase = 'old_moving';
    renameSync(f.config.appPath, path.join(f.root, '.Harness.app.source-previous.app'));
    writeFileSync(path.join(f.root, 'source-update-state.json'), JSON.stringify(state));
    f.parentGone();
    await activation().recover(f.config, f.deps); expect(f.marker()).toBe('old');
    const next = fixture(); await activation().prepare(next.config, next.request, next.deps);
    const pending = next.state(); pending.activation.phase = 'launching';
    renameSync(next.config.appPath, path.join(next.root, '.Harness.app.source-previous.app')); renameSync(next.staged, next.config.appPath);
    writeFileSync(path.join(next.root, 'source-update-state.json'), JSON.stringify(pending));
    await activation().recover(next.config, next.deps); expect(next.marker()).toBe('new'); expect(next.state().failed.permanent).toBe(true);
  });
  it('keeps the launcher callable and recovers a power loss before launch when the app is absent', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps);
    const saved = f.state(); await prepared.abort(); saved.activation.phase = 'old_moving';
    renameSync(f.config.appPath, path.join(f.root, '.Harness.app.source-previous.app'));
    writeFileSync(path.join(f.root, 'source-update-state.json'), JSON.stringify(saved)); f.parentGone();
    const { selectPayload } = require('./source-update-launcher.cjs') as { selectPayload: (file: string, launcher: string) => string };
    const configFile = path.join(f.root, 'config.json'); const { stateDirectory: _stateDirectory, ...onDisk } = f.config;
    writeFileSync(configFile, JSON.stringify(onDisk), { mode: 0o600 });
    expect(selectPayload(configFile, f.config.driverPath)).toContain('source-update-driver.cjs');
    expect(existsSync(f.config.appPath)).toBe(false);
    expect(await activation().recoverStandalone(f.config, f.deps)).toEqual({ status: 'ready' });
    expect(f.marker()).toBe('old'); expect(f.helper()).toBe('old helper'); expect(f.launched()).toBe(0);
  });
  it('reports a live updater owner as busy and a failed startup as blocked', async () => {
    const f = fixture(); const prepared = await activation().prepare(f.config, f.request, f.deps);
    expect(await activation().recoverStandalone(f.config, f.deps)).toEqual({ status: 'busy' });
    f.parentGone(); f.exitChild(); await expect(prepared.commit()).rejects.toThrow('readiness');
    expect(await activation().recoverStandalone(f.config, f.deps)).toEqual({ status: 'blocked' }); expect(f.marker()).toBe('new');
  });
  it('rejects arbitrary candidate paths and identity payloads before preparing', async () => {
    const f = fixture();
    await expect(activation().prepare(f.config, { ...f.request, appPath: '/arbitrary/Harness.app' }, f.deps)).rejects.toThrow('candidate');
    await expect(activation().prepare(f.config, { ...f.request, sessions: [{ ...f.sessions[0], prompt: 'placeholder' }] }, f.deps)).rejects.toThrow('session');
  });
});
