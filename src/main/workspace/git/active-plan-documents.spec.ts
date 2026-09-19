import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from './git-env';
import { listActivePlanDocuments } from './active-plan-documents';

vi.setConfig({ testTimeout: 30_000 });

let repo: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: hermeticGitEnv(), stdio: 'ignore' });
}

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commitOnSession(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) write(path, content);
  git(['add', '-A']);
  git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'session work']);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'active-plan-docs-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  write('README.md', 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'base']);
  git(['checkout', '-q', '-b', 'task-session']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('listActivePlanDocuments', () => {
  it('lists each active plan/spec/livetest document the session adds', async () => {
    commitOnSession({
      'docs/plans/a_plan.md': '# plan\n',
      'docs/plans/b_spec.md': '# spec\n',
      'docs/plans/c_spec_planned.md': '# spec planned\n',
      'docs/plans/d_livetest.md': '# livetest\n',
    });

    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([
      'docs/plans/a_plan.md',
      'docs/plans/b_spec.md',
      'docs/plans/c_spec_planned.md',
      'docs/plans/d_livetest.md',
    ]);
  });

  it('ignores closed-state documents and ordinary files', async () => {
    commitOnSession({
      'docs/plans/a_plan_completed.md': '# done\n',
      'docs/plans/b_spec_completed.md': '# done\n',
      'docs/plans/c_livetest_completed.md': '# done\n',
      'docs/notes.md': '# notes\n',
      'src/code.ts': 'export {};\n',
    });

    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([]);
  });

  it('exempts a document that declares itself a standing register near the top', async () => {
    commitOnSession({
      'docs/plans/register_plan.md': '# Register\n\nType: standing register\n',
      'docs/plans/late-marker_plan.md': `# Plan\n${'\n'.repeat(12)}Type: standing register\n`,
    });

    // The marker only counts within the first eight lines, as in the hook.
    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([
      'docs/plans/late-marker_plan.md',
    ]);
  });

  it('flags an edit to an existing active document but not a deletion', async () => {
    write('docs/plans/existing_plan.md', '# v1\n');
    write('docs/plans/doomed_plan.md', '# doomed\n');
    git(['checkout', '-q', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'docs on main']);
    git(['checkout', '-q', 'task-session']);
    git(['merge', '-q', '--no-edit', 'main']);
    write('docs/plans/existing_plan.md', '# v2\n');
    rmSync(join(repo, 'docs/plans/doomed_plan.md'));
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'edit and delete']);

    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([
      'docs/plans/existing_plan.md',
    ]);
  });

  it('ignores an active document the base edited after the session branched', async () => {
    // Merge-base (three-dot) semantics: only the session's own changes count.
    // An endpoint (two-dot) diff would report this file, because the session
    // still carries the pre-edit version the base has since changed.
    git(['checkout', '-q', 'main']);
    write('docs/plans/shared_plan.md', '# v1\n');
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'plan on main']);
    git(['branch', '-q', '-f', 'task-session', 'main']);
    write('docs/plans/shared_plan.md', '# v2 edited on main\n');
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'main edits the plan']);
    git(['checkout', '-q', 'task-session']);
    commitOnSession({ 'src/code.ts': 'export {};\n' });

    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([]);
  });

  it('ignores documents that only exist on the base branch', async () => {
    git(['checkout', '-q', 'main']);
    write('docs/plans/main-only_plan.md', '# main\n');
    git(['add', '-A']);
    git(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'main moved on']);
    git(['checkout', '-q', 'task-session']);
    commitOnSession({ 'src/code.ts': 'export {};\n' });

    await expect(listActivePlanDocuments(repo, 'main', 'task-session')).resolves.toEqual([]);
  });
});
