import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreeFingerprint } from './leftover-worktree-archive';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function electronBinary(): string { return createRequire(import.meta.url)('electron') as string; }

/**
 * A repository with one linked work folder holding `node_modules/electron/.../default_app.asar`,
 * as every npm-installed checkout does. Inside Electron, `fs` reads that file as a folder.
 */
function repoWithAsarFolder(): { repo: string; folder: string; asarBytes: number } {
  const binary = electronBinary();
  const asar = [join(dirname(binary), '..', 'Resources', 'default_app.asar'), join(dirname(binary), 'resources', 'default_app.asar')].find(existsSync);
  if (!asar) throw new Error(`No default_app.asar beside ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'aio-leftover-asar-'));
  roots.push(root);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const folder = join(repo, '.worktrees', 'task-asar');
  git(repo, 'worktree', 'add', '-q', folder, '-b', 'asar-branch');
  const resources = join(folder, 'node_modules', 'electron', 'dist', 'Resources');
  mkdirSync(resources, { recursive: true });
  copyFileSync(asar, join(resources, 'default_app.asar'));
  return { repo, folder, asarBytes: statSync(asar).size };
}

describe('work folders holding an .asar file', () => {
  it('fingerprints the same bytes under plain Node and inside Electron', async () => {
    const { folder } = repoWithAsarFolder();
    const underNode = await worktreeFingerprint(folder);
    const script = String.raw`
      require('tsx/cjs');
      const path = require('node:path');
      const { worktreeFingerprint } = require(path.join(process.cwd(), 'src/main/workspace/git/leftover-worktree-archive.ts'));
      worktreeFingerprint(process.argv[1]).then((value) => console.log('fingerprint ' + value), (error) => console.log('failed ' + error.code));
    `;
    const { stdout } = await promisify(execFile)(electronBinary(), ['-e', script, folder],
      { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
    expect(stdout.trim().split('\n').at(-1)).toBe(`fingerprint ${underNode}`);
  }, 40_000);

  it('measures and reports the folder inside Electron instead of failing with ENOTDIR', async () => {
    const { repo, asarBytes } = repoWithAsarFolder();
    const script = String.raw`
      require('tsx/cjs');
      const path = require('node:path');
      const { buildLeftoverWorktreeReport } = require(path.join(process.cwd(), 'src/main/workspace/git/leftover-worktree-report.ts'));
      buildLeftoverWorktreeReport(process.argv[1], {
        owners: () => [], liveSessions: () => [], processCheck: async () => ({ checked: true, live: false }),
      }).then((report) => console.log('report ' + JSON.stringify({ errors: report.errors, bytes: report.rows.map((row) => row.bytes) })),
        (error) => console.log('failed ' + error.message));
    `;
    const { stdout } = await promisify(execFile)(electronBinary(), ['-e', script, repo],
      { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
    const line = stdout.trim().split('\n').at(-1) ?? '';
    expect(line.startsWith('report ')).toBe(true);
    const report = JSON.parse(line.slice('report '.length)) as { errors: unknown[]; bytes: number[] };
    expect(report.errors).toEqual([]);
    expect(report.bytes).toHaveLength(1);
    expect(report.bytes[0]).toBeGreaterThanOrEqual(asarBytes);
  }, 40_000);
});
