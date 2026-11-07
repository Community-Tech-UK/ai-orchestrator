import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareScoringDependencies, verifyScoringDependencies } from './scoring-setup';

const roots: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scoring-setup-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('historical scoring dependencies', () => {
  it('materializes a locked Electron runtime without invoking application postinstall', async () => {
    const dir = workspace();
    mkdirSync(join(dir, 'fake-electron'));
    writeFileSync(join(dir, 'fake-electron/package.json'), '{"name":"electron","version":"0.0.0"}');
    writeFileSync(join(dir, 'fake-electron/install.js'), 'const fs = require("fs"); fs.writeFileSync("native-marker", "prepared"); fs.writeFileSync("cache-roots.json", JSON.stringify({ npm: process.env.npm_config_cache, electron: process.env.electron_config_cache, nodeGyp: process.env.npm_package_config_node_gyp_devdir }));');
    const pkg = { name: 'fixture', version: '1.0.0', dependencies: { electron: 'file:fake-electron' }, scripts: { postinstall: 'exit 9' } };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, lockfileVersion: 3,
      packages: { '': pkg, 'fake-electron': { version: '0.0.0' }, 'node_modules/electron': { resolved: 'fake-electron', link: true } },
    }));
    const receipt = await prepareScoringDependencies(dir);
    expect(readFileSync(join(dir, 'native-marker'), 'utf8')).toBe('prepared');
    expect(receipt.runtimePreparation.map(step => step.exitCode)).toEqual([0]);
    const caches = JSON.parse(readFileSync(join(dir, 'cache-roots.json'), 'utf8'));
    for (const key of ['npm', 'electron', 'nodeGyp']) expect(caches[key]).toMatch(new RegExp(`^${dir}/_scratch/`));
  });
  it('installs from the frozen lock and refuses a changed manifest after setup', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }));
    const receipt = await prepareScoringDependencies(dir);
    expect(receipt.command).toEqual(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(verifyScoringDependencies(dir).fingerprint).toBe(receipt.fingerprint);
    expect(JSON.parse(readFileSync(join(dir, '_scratch/scoring-dependencies.json'), 'utf8')).exitCode).toBe(0);
    writeFileSync(join(dir, 'package.json'), '{"name":"changed"}');
    expect(() => verifyScoringDependencies(dir)).toThrow(/changed/);
  });

  it('rejects a host dependency symlink and a missing install receipt', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(() => verifyScoringDependencies(dir)).toThrow(/receipt/);
    const { symlinkSync } = await import('fs');
    const donor = workspace();
    mkdirSync(join(donor, 'node_modules'));
    symlinkSync(join(donor, 'node_modules'), join(dir, 'node_modules'));
    await expect(prepareScoringDependencies(dir)).rejects.toThrow(/symlink/);
  });

  it('fails setup rather than scoring against a broken lockfile', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
    writeFileSync(join(dir, 'package-lock.json'), 'broken lock');
    await expect(prepareScoringDependencies(dir)).rejects.toThrow(/dependency setup failed/);
    expect(() => verifyScoringDependencies(dir)).toThrow(/failed/);
  });

  it('allows dependency-free fixtures and rejects manifests without a frozen lockfile', async () => {
    const dir = workspace();
    expect((await prepareScoringDependencies(dir)).command).toEqual([]);
    writeFileSync(join(dir, 'package.json'), '{}');
    await expect(prepareScoringDependencies(dir)).rejects.toThrow(/lockfile/);
  });

  it('rejects deleting every manifest and the local receipt after dependency setup', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(dir, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}');
    const receipt = await prepareScoringDependencies(dir);
    rmSync(join(dir, 'package.json'));
    rmSync(join(dir, 'package-lock.json'));
    expect(() => verifyScoringDependencies(dir, receipt)).toThrow(/changed/);
    rmSync(join(dir, '_scratch/scoring-dependencies.json'));
    expect(() => verifyScoringDependencies(dir, receipt)).toThrow(/receipt/);
  });

  it('rejects installed ancestor dependencies before running an install', async () => {
    const root = workspace();
    mkdirSync(join(root, 'node_modules'));
    const dir = join(root, 'exports/task');
    mkdirSync(dir, { recursive: true });
    await expect(prepareScoringDependencies(dir)).rejects.toThrow(/ancestor node_modules/);
    expect(() => verifyScoringDependencies(dir)).toThrow(/ancestor node_modules/);
  });

  it('checks the real workspace and ancestor dependency symlink targets', async () => {
    const { symlinkSync } = await import('fs');
    const root = workspace();
    const target = workspace();
    mkdirSync(join(target, 'dependencies'));
    symlinkSync(join(target, 'dependencies'), join(root, 'node_modules'));
    mkdirSync(join(root, 'export'));
    await expect(prepareScoringDependencies(join(root, 'export'))).rejects.toThrow(/ancestor node_modules/);
    const aliasRoot = workspace();
    symlinkSync(join(root, 'export'), join(aliasRoot, 'export'));
    await expect(prepareScoringDependencies(join(aliasRoot, 'export'))).rejects.toThrow(/ancestor node_modules/);
  });

  it('rejects inherited global module search directories in an otherwise clean export', async () => {
    const dir = workspace();
    const modules = workspace();
    mkdirSync(join(modules, 'global-fixture'));
    writeFileSync(join(modules, 'global-fixture/index.js'), 'module.exports = 42;');
    const { runCommand } = await import('./exec');
    const source = `console.log(require.resolve('global-fixture')); require(${JSON.stringify(join(process.cwd(), 'benchmarks/plan-execute-ab/scoring-setup.ts'))}).prepareScoringDependencies(${JSON.stringify(dir)}).then(() => process.exit(0), error => { console.error(error.message); process.exit(2); });`;
    const result = await runCommand([process.execPath, join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), '-e', source], { cwd: dir, env: { ...process.env, NODE_PATH: modules } });
    expect(result.stdout).toContain('global-fixture');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('global module path');
  });
});
