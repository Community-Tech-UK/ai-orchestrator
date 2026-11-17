import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { prepareOwner, readRuntime, packagedBuildArgs, materializePackageDependencies } = require('./live-test-copy.js');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/aio-lt-runner-'));
  dirs.push(root);
  const data = join(root, 'profile');
  const executablePath = join(root, 'repo/release/Harness.app/Contents/MacOS/Harness');
  mkdirSync(join(executablePath, '..'), { recursive: true });
  writeFileSync(executablePath, 'fixture');
  return { root, data, executablePath, port: 9877, tree: 'a'.repeat(40), mode: 'packaged' };
}

describe('isolated live-test copy', () => {
  it('gives npm a real dependency root so nested package metadata reaches the signed package', () => {
    const f = fixture();
    const cache = join(f.root, 'install/node_modules');
    const repo = join(f.root, 'repo');
    for (const name of ['fixture-parent', 'fixture-child']) {
      mkdirSync(join(cache, name), { recursive: true });
      writeFileSync(join(cache, name, 'package.json'), JSON.stringify({ name, version: '1.0.0',
        ...(name === 'fixture-parent' ? { dependencies: { 'fixture-child': '1.0.0' } } : {}) }));
    }
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture-project', version: '1.0.0', dependencies: { 'fixture-parent': '1.0.0' } }));
    symlinkSync(cache, join(repo, 'node_modules'));
    const inspect = () => {
      const result = spawnSync('npm', ['list', '-a', '--include', 'prod', '--include', 'optional', '--omit', 'dev', '--json', '--long', '--silent', '--loglevel=error'], { cwd: repo, encoding: 'utf8' });
      return JSON.parse(result.stdout).dependencies['fixture-parent'].dependencies['fixture-child'];
    };
    expect(inspect().version).toBeUndefined();
    materializePackageDependencies(f.root);
    expect(lstatSync(join(repo, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(inspect()).toMatchObject({ version: '1.0.0', path: join(repo, 'node_modules/fixture-child') });
    writeFileSync(join(repo, 'node_modules/fixture-child/package.json'), 'owned change');
    expect(JSON.parse(readFileSync(join(cache, 'fixture-child/package.json'), 'utf8')).version).toBe('1.0.0');
  });
  it('removes a stand-in provider left in a reused profile, keeping the rest of its data', () => {
    const f = fixture();
    prepareOwner(f);
    mkdirSync(join(f.data, 'live-test-overrides'));
    writeFileSync(join(f.data, 'live-test-overrides/claude'), 'stand-in');
    writeFileSync(join(f.data, 'kept'), 'saved pause');
    prepareOwner(f);
    expect(existsSync(join(f.data, 'live-test-overrides'))).toBe(false);
    expect(readFileSync(join(f.data, 'kept'), 'utf8')).toBe('saved pause');
  });
  it('creates its own profile and can relaunch that profile without replacing its data', () => {
    const f = fixture();
    prepareOwner(f);
    writeFileSync(join(f.data, 'kept'), 'saved pause');
    prepareOwner(f);
    expect(readFileSync(join(f.data, 'kept'), 'utf8')).toBe('saved pause');
    expect(() => prepareOwner({ ...f, mode: 'dev' })).toThrow(/profile/);
  });

  it('refuses an existing unowned profile or a symlink instead of claiming it', () => {
    const f = fixture();
    mkdirSync(f.data);
    expect(() => prepareOwner(f)).toThrow(/owned/);
    expect(existsSync(join(f.data, '.aio-livetest-profile.json'))).toBe(false);
    rmSync(f.data, { recursive: true });
    symlinkSync(join(f.root, 'repo'), f.data);
    expect(() => prepareOwner(f)).toThrow(/canonical/);
  });

  it('requires matching runtime identity, real packaged mode and readiness', () => {
    const f = fixture();
    prepareOwner(f);
    const runtime = { schemaVersion: 1, dataPath: f.data, executablePath: f.executablePath, tree: f.tree,
      mode: f.mode, port: f.port, isPackaged: true, ready: true, pid: process.pid, version: 'test' };
    const file = join(f.root, 'runtime.json');
    writeFileSync(file, JSON.stringify(runtime));
    expect(readRuntime(f.root)).toMatchObject({ ready: true, isPackaged: true });
    for (const change of [{ dataPath: '/tmp/aio-lt-other' }, { tree: 'b'.repeat(40) }, { isPackaged: false }, { ready: false }, { executablePath: '/Applications/Harness.app/Contents/MacOS/Harness' }]) {
      writeFileSync(file, JSON.stringify({ ...runtime, ...change }));
      expect(() => readRuntime(f.root)).toThrow();
    }
  });

  it('keeps the signed normal packaging hooks and never installs or publishes', () => {
    const args = packagedBuildArgs('/tmp/aio-lt-package/output', 'fixture-signing-identity');
    expect(args).toContain('--dir');
    expect(args).not.toContain('dmg');
    expect(args).toContain('--publish=never');
    expect(args).toContain('--config.forceCodeSigning=true');
    expect(args).toContain('--config.mac.sign=scripts/sign-local-macos.js');
    expect(args).toContain('--config.afterPack=scripts/localbuild-after-pack.js');
    expect(args).toContain('--config.mac.identity=fixture-signing-identity');
  });
});
