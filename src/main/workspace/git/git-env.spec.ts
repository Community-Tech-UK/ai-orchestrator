import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermeticGitEnv } from './git-env';
describe('queue Git discovery ceiling', () => {
  it('bounds discovery at the nearest worktree container when queues are nested', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nested-git-ceiling-')));
    try {
      const outer = join(repo, '.worktrees', 'queue', 'outer');
      const cwd = join(outer, '.worktrees', 'queue', 'plain');
      mkdirSync(cwd, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: outer });
      const env = hermeticGitEnv({}, cwd);
      expect(env['GIT_CEILING_DIRECTORIES']).toBe(join(outer, '.worktrees'));
      expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, stdio: 'pipe' })).toThrow();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('prevents plain worktree directories from resolving to the enclosing repository', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'git-ceiling-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const cwd = join(repo, '.worktrees', 'queue', 'plain');
      mkdirSync(cwd, { recursive: true });
      const original = { ...process.env, GIT_DIR: '/invalid-placeholder' };
      const env = hermeticGitEnv(original, cwd);
      expect(env['GIT_DIR']).toBeUndefined();
      expect(original.GIT_DIR).toBe('/invalid-placeholder');
      expect(env['GIT_CEILING_DIRECTORIES']).toBe(join(repo, '.worktrees'));
      expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, stdio: 'pipe' })).toThrow();
      expect(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: hermeticGitEnv(), encoding: 'utf8' }).trim()).toBe(repo);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
