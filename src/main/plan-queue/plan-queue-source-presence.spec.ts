import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectFiles } from './plan-queue-source-presence';

describe('findProjectFiles', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plan-queue-presence-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('finds nothing in a parent folder that holds only plans and evidence', async () => {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'package.json'), '{}');
    writeFileSync(join(root, 'README.md'), '# parent\n');
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'package.json'), '{}');
    expect(await findProjectFiles(root)).toEqual([]);
  });

  it('finds a project file at the top and one folder down, but not deeper', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'apps', 'desk', 'inner'), { recursive: true });
    writeFileSync(join(root, 'apps', 'pyproject.toml'), '');
    writeFileSync(join(root, 'apps', 'desk', 'package.json'), '{}');
    expect((await findProjectFiles(root)).sort()).toEqual(['apps/pyproject.toml', 'package.json']);
  });

  it('treats a missing folder as holding nothing', async () => {
    expect(await findProjectFiles(join(root, 'absent'))).toEqual([]);
  });
});
