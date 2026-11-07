import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { scoreRun } from './scorer';
import { prepareScoringDependencies } from './scoring-setup';
import type { TaskDefinition } from './types';

const roots: string[] = [];
const task: TaskDefinition = {
  id: 'FIXTURE', repoId: 'fixture', commitSha: 'fixed', parentSha: 'parent', commitMessage: '',
  size: 'small', prompt: 'Fixture', hiddenTests: ['fixture.cjs'], hiddenTestCommand: [], damageCommands: [], sourceFiles: [],
  verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
};
async function workspace(script = '') {
  const dir = mkdtempSync(join(tmpdir(), 'scoring-fixture-'));
  roots.push(dir);
  const pkg = { name: 'fixture', version: '1.0.0', scripts: { test: script } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
  return { dir, dependencies: await prepareScoringDependencies(dir) };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('scoring infrastructure and dependency isolation', () => {
  it('allows workspace-owned modules and global npm tooling', async () => {
    const { dir, dependencies } = await workspace('node -e "if (require(\'local-fixture\') !== 42) process.exit(1)"');
    mkdirSync(join(dir, 'node_modules/local-fixture'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/local-fixture/index.js'), 'module.exports = 42;');
    const score = await scoreRun({ ...task, hiddenTestCommand: ['npm', 'test'] }, { workspaceDir: dir, dependencies });
    expect(score.hiddenTests.passed).toBe(true);
  });
  it('does not turn a missing executable into a model failure', async () => {
    const { dir, dependencies } = await workspace();
    await expect(scoreRun({ ...task, hiddenTestCommand: ['missing-benchmark-fixture-executable'] }, { workspaceDir: dir, dependencies })).rejects.toThrow(/infrastructure/);
  });

  it('does not turn an npm script missing its test executable into a model failure', async () => {
    const { dir, dependencies } = await workspace('missing-benchmark-fixture-executable');
    await expect(scoreRun({ ...task, hiddenTestCommand: ['npm', 'test'] }, { workspaceDir: dir, dependencies })).rejects.toThrow(/infrastructure/);
  });

  it('accepts a successful test that merely logs a simulated cache error', async () => {
    const { dir, dependencies } = await workspace();
    const score = await scoreRun({ ...task, hiddenTestCommand: [process.execPath, '-e', 'process.stderr.write("npm error code ENOTCACHED\\n");'] }, { workspaceDir: dir, dependencies });
    expect(score.hiddenTests.passed).toBe(true);
  });

  it('disables model-backed test summaries even when the caller enables them', async () => {
    const { dir, dependencies } = await workspace();
    const score = await scoreRun({ ...task, hiddenTestCommand: [process.execPath, '-e', 'if (process.env.AIO_TEST_SUMMARY !== "0") process.exit(1);'] }, { workspaceDir: dir, dependencies, env: { ...process.env, AIO_TEST_SUMMARY: '1' } });
    expect(score.hiddenTests.passed).toBe(true);
  });

  it.each([
    ['CommonJS', ['-e', 'console.log(require.resolve("vitest/package.json"))']],
    ['ES modules', ['--input-type=module', '-e', 'await import("vitest/config");']],
  ])('cannot satisfy %s imports in a clean temporary fixture', async (_kind, args) => {
    const { dir, dependencies } = await workspace();
    const score = await scoreRun({ ...task, hiddenTestCommand: [process.execPath, ...args] }, { workspaceDir: dir, dependencies });
    expect(score.hiddenTests.passed).toBe(false);
  });

  it('refuses a native-bundler or compiler workspace below an installed ancestor', async () => {
    const scratch = join(process.cwd(), '_scratch');
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, 'scoring-rejected-'));
    roots.push(dir);
    await expect(scoreRun({ ...task, hiddenTestCommand: ['esbuild', 'fixture.ts', '--bundle'] }, { workspaceDir: dir })).rejects.toThrow(/ancestor node_modules/);
  });

  it.each(['direct', 'symlink'])('refuses inherited dependency executables instead of using a host tool: %s', async (kind) => {
    const { dir, dependencies } = await workspace();
    const foreign = mkdtempSync(join(tmpdir(), 'scoring-foreign-tool-'));
    roots.push(foreign);
    const bin = join(foreign, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'fixture-test-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const alias = join(foreign, 'bin-alias');
    const { symlinkSync } = await import('fs');
    if (kind === 'symlink') symlinkSync(bin, alias);
    const entry = kind === 'symlink' ? alias : bin;
    await expect(scoreRun({ ...task, hiddenTestCommand: ['fixture-test-tool'] }, { workspaceDir: dir, dependencies, env: { ...process.env, PATH: entry + delimiter + process.env['PATH'] } })).rejects.toThrow(/infrastructure/);
  });

  it('does not let npx run an executable from an inherited cache', async () => {
    const { dir, dependencies } = await workspace();
    const cached = mkdtempSync(join(tmpdir(), 'scoring-cached-tool-'));
    roots.push(cached);
    const fixture = join(cached, 'fixture');
    mkdirSync(fixture);
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture-cached-tool', version: '0.0.0', bin: { 'fixture-cached-tool': 'tool.cjs' } }));
    writeFileSync(join(fixture, 'tool.cjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    const { runCommand } = await import('./exec');
    const result = await runCommand(['npm', 'exec', '--offline', '--yes', '--cache', cached, '--package', fixture, '--', 'fixture-cached-tool'], { cwd: dir });
    expect(result.exitCode).toBe(0);
    await expect(scoreRun({ ...task, hiddenTestCommand: ['npx', '--package', fixture, 'fixture-cached-tool'] }, { workspaceDir: dir, dependencies, env: { ...process.env, npm_config_cache: cached } })).rejects.toThrow(/infrastructure/);
  });
});
