import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * A Git repository built once per spec file and copied, with its `.git`, into each test's own folder.
 *
 * Specs that start every test from the same first commit spent most of their set-up starting Git
 * (`init`, three `config` calls, `add`, `commit`, and the commit hooks). A copy is a separate
 * repository: nothing in it points back at the template, and each test still writes only its own copy.
 *
 * `build` runs once, before the file's first test, in an empty folder. Call `copyTo` in `beforeEach`
 * with the test's own (empty) folder.
 */
export interface GitRepoTemplate {
  copyTo(target: string): void;
}

export function useGitRepoTemplate(build: (dir: string) => void | Promise<void>): GitRepoTemplate {
  let template: string | null = null;
  beforeAll(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-repo-template-')));
    template = dir;
    await build(dir);
  });
  afterAll(() => {
    if (template) rmSync(template, { recursive: true, force: true });
  });
  return {
    copyTo(target: string): void {
      if (!template) throw new Error('useGitRepoTemplate: copyTo ran before the template was built');
      cpSync(template, target, { recursive: true });
      // The copied index still holds the template files' inode and times, so plumbing such as
      // `git diff-files` would report every file as changed. Refresh it, as a fresh commit leaves it.
      if (existsSync(join(target, '.git', 'index'))) {
        execFileSync('git', ['update-index', '-q', '--refresh'], { cwd: target, stdio: 'ignore' });
      }
    },
  };
}
