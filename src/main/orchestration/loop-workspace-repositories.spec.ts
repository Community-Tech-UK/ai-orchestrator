import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceRepositories } from './loop-workspace-repositories';

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function marker(relPath: string): void {
  const markerPath = join(workspace!, relPath, '.git', 'HEAD');
  mkdirSync(join(markerPath, '..'), { recursive: true });
  writeFileSync(markerPath, 'ref: refs/heads/main\n');
}

describe('discoverWorkspaceRepositories', () => {
  it('does not let canonical worktree, virtualenv, or cache trees consume the traversal bound', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-repositories-'));
    marker('.worktrees/linked');
    marker('.venv/package');
    marker('cache/generated');
    marker('real-repo');

    const result = discoverWorkspaceRepositories(workspace, { maxDirectories: 2 });

    expect(result.coverage).toBe('complete');
    expect(result.roots).toEqual([join(workspace, 'real-repo')]);
  });
});
