import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, SourceUpdateConfig } from './source-update-types';
const require = createRequire(import.meta.url);
interface Dependencies { run: Run; verifyApp?: (app: string, commit: string) => Promise<void>; packageApp?: (config: SourceUpdateConfig, commit: string) => Promise<string> }
const updater = () => require('./source-update-build.cjs') as {
  probe: (config: SourceUpdateConfig, request: { installedCommit: string }, deps?: Dependencies) => Promise<{ available: boolean; commit?: string }>;
  build: (config: SourceUpdateConfig, request: { commit: string }, deps?: Dependencies) => Promise<{ commit: string; appPath: string }>;
  packageArguments: (output: string) => string[];
  verifyApp: (config: SourceUpdateConfig, app: string, commit: string, run?: Run) => Promise<void>;
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'source-build-'))); roots.push(root);
  const repositoryPath = path.join(root, 'source'); mkdirSync(repositoryPath);
  git(repositoryPath, 'init', '-q', '-b', 'main');
  const helpers = ['driver', 'config', 'state', 'runtime', 'build', 'activation'].map(name => `source-update-${name}.cjs`);
  mkdirSync(path.join(repositoryPath, 'scripts/home-base'), { recursive: true });
  for (const name of helpers) writeFileSync(path.join(repositoryPath, 'scripts/home-base', name), 'module.exports = {};');
  writeFileSync(path.join(repositoryPath, 'source.txt'), 'one'); git(repositoryPath, 'add', '.'); git(repositoryPath, 'commit', '-qm', 'one');
  const initial = git(repositoryPath, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repositoryPath, 'source.txt'), 'two'); git(repositoryPath, 'commit', '-qam', 'two');
  const target = git(repositoryPath, 'rev-parse', 'HEAD');
  const remote = path.join(root, 'remote.git'); git(root, 'clone', '-q', '--bare', repositoryPath, remote);
  git(repositoryPath, 'remote', 'add', 'origin', 'git@github.com:Community-Tech-UK/ai-orchestrator.git');
  git(repositoryPath, 'reset', '--hard', initial);
  const appPath = path.join(root, 'Harness.app'); mkdirSync(appPath);
  const helperDirectory = path.join(root, 'source-updater', 'versions', initial); mkdirSync(helperDirectory, { recursive: true });
  for (const name of helpers) writeFileSync(path.join(helperDirectory, name), 'module.exports = {};');
  writeFileSync(path.join(root, 'source-updater/current.json'), JSON.stringify({ version: 1, commit: initial }), { mode: 0o600 });
  const config: SourceUpdateConfig = { version: 1, repositoryPath, remote: 'origin', branch: 'main', appPath, nodePath: process.execPath, driverPath: path.join(root, 'source-update-launcher.cjs'), stateDirectory: root };
  const calls: string[][] = [];
  const run: Run = async (file, args, options) => {
    calls.push([file, ...args]);
    const actual = file === 'git' && args[0] === 'fetch' ? ['fetch', '--quiet', '--no-tags', remote, '+refs/heads/main:refs/remotes/origin/main'] : args;
    try { return { code: 0, stdout: execFileSync(file, actual, { cwd: options?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
    catch (error) { const failed = error as { status: number; stderr: string }; return { code: failed.status, stdout: '', stderr: String(failed.stderr) }; }
  };
  return { root, config, initial, target, remote, calls, run };
}
describe('source update Git planning and building', () => {
  it('fetches the actual remote branch and offers only a forward commit without changing source', async () => {
    const f = fixture();
    expect(await updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).toEqual({ available: true, commit: f.target });
    expect(git(f.config.repositoryPath, 'rev-parse', 'HEAD')).toBe(f.initial);
    expect(f.calls.find(call => call[1] === 'fetch')).toEqual(['git', 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  });
  it('leaves an installed build ahead of the remote branch intact', async () => {
    const f = fixture();
    git(f.root, '--git-dir', f.remote, 'update-ref', 'refs/heads/main', f.initial);
    expect(await updater().probe(f.config, { installedCommit: f.target }, { run: f.run })).toEqual({ available: false });
  });
  it('preserves a genuinely divergent committed clone without resetting it', async () => {
    const f = fixture();
    writeFileSync(path.join(f.config.repositoryPath, 'source.txt'), 'local branch edit'); git(f.config.repositoryPath, 'commit', '-qam', 'local divergence');
    const head = git(f.config.repositoryPath, 'rev-parse', 'HEAD');
    await expect(updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).rejects.toThrow('diverged');
    expect(git(f.config.repositoryPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(f.config.repositoryPath, 'source.txt'), 'utf8')).toBe('local branch edit');
  });
  it('rejects a dirty clone, an unrelated installed build and an untrusted origin', async () => {
    const f = fixture();
    writeFileSync(path.join(f.config.repositoryPath, 'untracked.txt'), 'preserve');
    await expect(updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).rejects.toThrow('clean');
    rmSync(path.join(f.config.repositoryPath, 'untracked.txt'));
    await expect(updater().probe(f.config, { installedCommit: 'a'.repeat(40) }, { run: f.run })).rejects.toThrow('ancestry');
    git(f.config.repositoryPath, 'remote', 'set-url', 'origin', 'https://example.invalid/another.git');
    await expect(updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).rejects.toThrow('origin');
  });
  it('stages a verified candidate as a sibling while preserving the installed app', async () => {
    const f = fixture(); writeFileSync(path.join(f.config.appPath, 'installed'), 'old');
    await updater().probe(f.config, { installedCommit: f.initial }, { run: f.run });
    const packed = path.join(f.root, 'pack', 'Harness.app'); mkdirSync(packed, { recursive: true }); writeFileSync(path.join(packed, 'candidate'), 'new');
    const result = await updater().build(f.config, { commit: f.target }, { run: f.run, packageApp: async () => packed, verifyApp: async () => undefined });
    expect(result.commit).toBe(f.target); expect(path.dirname(result.appPath)).toBe(path.dirname(f.config.appPath));
    expect(readFileSync(path.join(result.appPath, 'candidate'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(f.config.appPath, 'installed'), 'utf8')).toBe('old');
    expect(git(f.config.repositoryPath, 'rev-parse', 'HEAD')).toBe(f.target);
    expect(readFileSync(path.join(f.root, 'source-updater', 'versions', f.target, 'source-update-driver.cjs'), 'utf8')).toBe('module.exports = {};');
  });
  it('rejects source touched during packaging and backs off the failed commit', async () => {
    const f = fixture();
    await updater().probe(f.config, { installedCommit: f.initial }, { run: f.run });
    await expect(updater().build(f.config, { commit: f.target }, { run: f.run, packageApp: async () => {
      writeFileSync(path.join(f.config.repositoryPath, 'source.txt'), 'user edit'); return '/not-used';
    }, verifyApp: async () => undefined })).rejects.toThrow('clean');
    expect(readFileSync(path.join(f.config.repositoryPath, 'source.txt'), 'utf8')).toBe('user edit');
    expect(JSON.parse(readFileSync(path.join(f.root, 'source-update-state.json'), 'utf8')).failed.commit).toBe(f.target);
  });
  it('rejects direct build requests without a checked installed baseline', async () => {
    const f = fixture();
    await expect(updater().build(f.config, { commit: f.target }, { run: f.run, packageApp: async () => '/unused' })).rejects.toThrow('probe');
  });
  it('holds the owner lock for the entire in-flight build', async () => {
    const f = fixture(); await updater().probe(f.config, { installedCommit: f.initial }, { run: f.run });
    const packed = path.join(f.root, 'packed.app'); mkdirSync(packed);
    let entered: () => void = () => undefined; let finish: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const building = new Promise<void>(resolve => { finish = resolve; });
    const first = updater().build(f.config, { commit: f.target }, { run: f.run, packageApp: async () => { entered(); await building; return packed; }, verifyApp: async () => undefined });
    await started;
    try { await expect(updater().build(f.config, { commit: f.target }, { run: f.run })).rejects.toThrow('busy'); }
    finally { finish(); }
    await first;
  });
  it('reports failed-target backoff and allows a later remote commit immediately', async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'source-update-state.json'), JSON.stringify({ failed: { commit: f.target, permanent: true } }), { mode: 0o600 });
    await expect(updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).rejects.toThrow('failed earlier');
    git(f.config.repositoryPath, 'merge', '--ff-only', f.target);
    writeFileSync(path.join(f.config.repositoryPath, 'source.txt'), 'three'); git(f.config.repositoryPath, 'commit', '-qam', 'three');
    const third = git(f.config.repositoryPath, 'rev-parse', 'HEAD'); git(f.config.repositoryPath, 'push', '-q', f.remote, 'HEAD:refs/heads/main');
    expect(await updater().probe(f.config, { installedCommit: f.initial }, { run: f.run })).toEqual({ available: true, commit: third });
  });
  it('uses directory packaging and the normal local signer and fuse hook', () => {
    const args = updater().packageArguments('/private/output');
    expect(args).toContain('--dir'); expect(args).not.toContain('dmg');
    expect(args).toContain('--config.mac.sign=scripts/sign-local-macos.js');
    expect(args).toContain('--config.afterPack=scripts/localbuild-after-pack.js');
    expect(args).toContain('--publish=never');
  });
});
