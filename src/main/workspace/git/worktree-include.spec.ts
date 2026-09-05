import { afterEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  applyWorktreeIncludes,
  readWorktreeIncludes,
  WORKTREE_INCLUDE_FILE,
  worktreeHasDependencies,
} from './worktree-include';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readWorktreeIncludes (T37)', () => {
  it('returns an empty list when the file is absent, so callers fall back', async () => {
    expect(await readWorktreeIncludes(tmp('wti-'))).toEqual([]);
  });

  it('ignores comments, blanks and trailing slashes, and de-duplicates', async () => {
    const root = tmp('wti-');
    await fsp.writeFile(
      join(root, WORKTREE_INCLUDE_FILE),
      '# heavy paths\n\nnode_modules/\n.env.local\nnode_modules\n',
    );
    expect(await readWorktreeIncludes(root)).toEqual(['node_modules', '.env.local']);
  });

  it('refuses entries that escape the repository or target .git', async () => {
    const root = tmp('wti-');
    await fsp.writeFile(
      join(root, WORKTREE_INCLUDE_FILE),
      ['/etc/passwd', '../outside', 'a/../../b', '.git', 'ok'].join('\n'),
    );
    expect(await readWorktreeIncludes(root)).toEqual(['ok']);
  });
});

describe('applyWorktreeIncludes (T37)', () => {
  async function repoWithModules(): Promise<{ root: string; worktree: string }> {
    const root = tmp('wti-root-');
    const worktree = tmp('wti-wt-');
    await fsp.mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await fsp.writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    await fsp.mkdir(join(root, 'node_modules', '@ai-orchestrator'), { recursive: true });
    await fsp.mkdir(join(root, 'packages', 'contracts'), { recursive: true });
    await fsp.mkdir(join(worktree, 'packages', 'contracts'), { recursive: true });
    await fsp.symlink('../../packages/contracts', join(root, 'node_modules', '@ai-orchestrator', 'contracts'));
    return { root, worktree };
  }

  it('links node_modules entry by entry rather than the directory itself', async () => {
    const { root, worktree } = await repoWithModules();

    const result = await applyWorktreeIncludes(root, worktree, ['node_modules']);

    expect(result.ok).toBe(true);
    const modules = await fsp.lstat(join(worktree, 'node_modules'));
    expect(modules.isSymbolicLink()).toBe(false);
    const leftPad = await fsp.lstat(join(worktree, 'node_modules', 'left-pad'));
    expect(leftPad.isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(join(worktree, 'node_modules', 'left-pad', 'index.js'), 'utf8'))
      .toBe('module.exports = 1;');
  });

  // The whole reason the directory is not linked wholesale: a workspace link
  // must resolve inside the worktree, or the isolated build silently compiles
  // the root's package sources.
  // The bug an earlier version had: it repaired a hard-coded pair of
  // `@ai-orchestrator/*` names and therefore missed `node_modules/archiver`,
  // an UNSCOPED workspace link to `packages/archiver-compat`, silently
  // building that package from the root's sources.
  it('re-points an unscoped workspace link, not just the scoped ones', async () => {
    const root = tmp('wti-root-');
    const worktree = tmp('wti-wt-');
    await fsp.mkdir(join(root, 'node_modules'), { recursive: true });
    await fsp.mkdir(join(root, 'packages', 'archiver-compat'), { recursive: true });
    await fsp.mkdir(join(worktree, 'packages', 'archiver-compat'), { recursive: true });
    await fsp.symlink('../packages/archiver-compat', join(root, 'node_modules', 'archiver'));

    await applyWorktreeIncludes(root, worktree, ['node_modules']);

    const linkPath = join(worktree, 'node_modules', 'archiver');
    expect((await fsp.lstat(linkPath)).isSymbolicLink()).toBe(true);
    const resolved = await fsp.realpath(linkPath);
    expect(resolved.startsWith(await fsp.realpath(worktree))).toBe(true);
  });

  // `.bin` shims point at package files, so linking the directory wholesale
  // would send a workspace package's bin back to the root tree.
  it('descends into .bin rather than linking it wholesale', async () => {
    const root = tmp('wti-root-');
    const worktree = tmp('wti-wt-');
    await fsp.mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await fsp.writeFile(join(root, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');

    await applyWorktreeIncludes(root, worktree, ['node_modules']);

    const binDir = join(worktree, 'node_modules', '.bin');
    expect((await fsp.lstat(binDir)).isSymbolicLink()).toBe(false);
    expect((await fsp.lstat(join(binDir, 'tool'))).isSymbolicLink()).toBe(true);
  });

  it('re-points the workspace links at the worktree, not the root', async () => {
    const { root, worktree } = await repoWithModules();

    await applyWorktreeIncludes(root, worktree, ['node_modules']);

    const linkPath = join(worktree, 'node_modules', '@ai-orchestrator', 'contracts');
    const stat = await fsp.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    const resolved = await fsp.realpath(linkPath);
    expect(resolved.startsWith(await fsp.realpath(worktree))).toBe(true);
  });

  it('reports a missing entry without failing the batch', async () => {
    const root = tmp('wti-root-');
    const worktree = tmp('wti-wt-');

    const result = await applyWorktreeIncludes(root, worktree, ['node_modules', '.env.local']);

    expect(result.ok).toBe(true);
    expect(result.entries.map((e) => e.status)).toEqual(['missing', 'missing']);
  });

  it('links a plain file entry', async () => {
    const root = tmp('wti-root-');
    const worktree = tmp('wti-wt-');
    await fsp.writeFile(join(root, '.env.local'), 'TOKEN=placeholder');

    const result = await applyWorktreeIncludes(root, worktree, ['.env.local']);

    expect(result.ok).toBe(true);
    expect(await fsp.readFile(join(worktree, '.env.local'), 'utf8')).toBe('TOKEN=placeholder');
  });

  it('leaves an already-populated destination alone', async () => {
    const { root, worktree } = await repoWithModules();
    await fsp.mkdir(join(worktree, 'node_modules'), { recursive: true });
    await fsp.writeFile(join(worktree, 'node_modules', 'marker'), 'kept');

    const result = await applyWorktreeIncludes(root, worktree, ['node_modules']);

    expect(result.entries[0]).toMatchObject({ status: 'linked', reason: 'already present' });
    expect(await fsp.readFile(join(worktree, 'node_modules', 'marker'), 'utf8')).toBe('kept');
  });
});

/**
 * T37 — the question the caller must ask instead of trusting the batch result.
 */
describe('worktreeHasDependencies (T37)', () => {
  it('is false for a worktree with no node_modules', async () => {
    expect(await worktreeHasDependencies(tmp('wti-empty-'))).toBe(false);
  });

  it('is false for an empty node_modules directory', async () => {
    const wt = tmp('wti-empty-nm-');
    await fsp.mkdir(join(wt, 'node_modules'), { recursive: true });
    expect(await worktreeHasDependencies(wt)).toBe(false);
  });

  it('is true once anything was linked into node_modules', async () => {
    const wt = tmp('wti-populated-');
    await fsp.mkdir(join(wt, 'node_modules', 'left-pad'), { recursive: true });
    expect(await worktreeHasDependencies(wt)).toBe(true);
  });
});
