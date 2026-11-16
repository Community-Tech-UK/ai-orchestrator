import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceUpdateConfig, SessionIdentity } from './source-update-types';
const require = createRequire(import.meta.url);
const configModule = () => require('./source-update-config.cjs') as {
  readConfig: (file: string) => SourceUpdateConfig;
  validateSessions: (value: unknown) => SessionIdentity[];
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'source-config-'))); roots.push(root);
  const repositoryPath = path.join(root, 'source');
  mkdirSync(path.join(repositoryPath, '.git'), { recursive: true });
  const appPath = path.join(root, 'Harness.app'); mkdirSync(appPath);
  const driverPath = path.join(root, 'source-update-launcher.cjs'); writeFileSync(driverPath, '');
  const file = path.join(root, 'config.json');
  const input = { version: 1, repositoryPath, remote: 'origin', branch: 'main', appPath, nodePath: process.execPath, driverPath };
  const save = (value: unknown = input) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save(); return { root, file, input, save };
}
describe('source updater configuration', () => {
  it('reads only explicit paths and derives private state beside the configuration', () => {
    const f = fixture();
    expect(configModule().readConfig(f.file)).toEqual({ ...f.input, stateDirectory: f.root });
  });
  it.each(['command', 'token', 'stateDirectory'])('rejects unrecognised %s', field => {
    const f = fixture(); f.save({ ...f.input, [field]: 'placeholder' });
    expect(() => configModule().readConfig(f.file)).toThrow('configuration');
  });
  it('rejects public configuration, symlinks and a driver within the mutable clone', () => {
    const f = fixture(); chmodSync(f.file, 0o644);
    expect(() => configModule().readConfig(f.file)).toThrow('private');
    chmodSync(f.file, 0o600);
    const link = path.join(f.root, 'link.json'); symlinkSync(f.file, link);
    expect(() => configModule().readConfig(link)).toThrow('symlink');
    const driverPath = path.join(f.input.repositoryPath, 'source-update-launcher.cjs'); writeFileSync(driverPath, '');
    f.save({ ...f.input, driverPath });
    expect(() => configModule().readConfig(f.file)).toThrow('outside');
  });
  it('preserves session identities and rejects prompt or credential payloads', () => {
    const identities = [{ instanceId: 'instance', historyEntryId: 'history', workingDirectory: '/work', accountProfileId: 'profile' }];
    expect(configModule().validateSessions(identities)).toEqual(identities);
    expect(() => configModule().validateSessions([{ ...identities[0], prompt: 'placeholder' }])).toThrow('session');
    expect(() => configModule().validateSessions([{ ...identities[0], token: 'placeholder' }])).toThrow('session');
  });
  it('rejects a stable helper directory that would move updater configuration or app data', () => {
    const f = fixture(); const unsafe = path.join(f.root, 'source-updater'); mkdirSync(unsafe, { mode: 0o700 });
    const file = path.join(unsafe, 'config.json'); writeFileSync(file, JSON.stringify(f.input), { mode: 0o600 });
    expect(() => configModule().readConfig(file)).toThrow('separate');
  });
});
