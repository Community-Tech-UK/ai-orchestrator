import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];

function prepareFixture(electronLoader: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-native-preparation-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true });
  copyFileSync(join(process.cwd(), 'scripts', 'rebuild-native-modules.js'), join(root, 'scripts', 'rebuild-native-modules.js'));
  writeFileSync(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '42.11.15', main: 'index.js' }));
  writeFileSync(join(root, 'node_modules', 'electron', 'index.js'), electronLoader);
  return root;
}

function runPreparation(root: string) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-native-modules.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native preparation Electron executable', () => {
  it('materializes a lazy executable before succeeding, even without native modules', () => {
    const root = prepareFixture(`
      const fs = require('node:fs');
      const path = require('node:path');
      const executable = path.join(__dirname, 'fixture-executable');
      fs.writeFileSync(executable, 'fixture');
      module.exports = executable;
    `);

    const result = runPreparation(root);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'node_modules', 'electron', 'fixture-executable'))).toBe(true);
  });

  it('fails when the executable installer fails', () => {
    const root = prepareFixture("throw new Error('fixture download failed');");

    const result = runPreparation(root);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture download failed');
  });

  it('fails when the loader returns a missing executable', () => {
    const root = prepareFixture("module.exports = require('node:path').join(__dirname, 'missing-executable');");

    const result = runPreparation(root);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Electron executable');
  });
});
