import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import {
  appendParkedNote,
  completedDocumentPath,
  documentsAreCommitted,
  prepareClosedDocuments,
  renameDocumentsInPlace,
  retireActiveDocuments,
} from './plan-queue-doc-close';

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(relative: string, content: string): string {
  const full = join(repo, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-docs-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  write('a.txt', 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('completedDocumentPath', () => {
  it('adds _completed before the extension, once, and closes a planned spec to _spec_completed', () => {
    expect(completedDocumentPath('/r/docs/x_plan.md')).toBe('/r/docs/x_plan_completed.md');
    expect(completedDocumentPath('/r/docs/x_plan_completed.md')).toBe('/r/docs/x_plan_completed.md');
    expect(completedDocumentPath('/r/docs/x_livetest.md')).toBe('/r/docs/x_livetest_completed.md');
    expect(completedDocumentPath('/r/docs/x_spec_planned.md')).toBe('/r/docs/x_spec_completed.md');
  });
});

describe('prepareClosedDocuments', () => {
  it('prepares both closed copies with their links re-pointed, touching nothing in the root', async () => {
    const plan = write('docs/plans/x_plan.md', 'spec: x_spec_planned.md\n');
    write('docs/plans/x_spec_planned.md', 'plan: x_plan.md\n');
    const statusBefore = git(['status', '--porcelain', '--untracked-files=all']);

    const prepared = await prepareClosedDocuments(plan, repo);

    expect(prepared).toEqual({
      mode: 'commit',
      documents: [
        { relativePath: 'docs/plans/x_plan_completed.md', content: 'spec: x_spec_completed.md\n' },
        { relativePath: 'docs/plans/x_spec_completed.md', content: 'plan: x_plan_completed.md\n' },
      ],
    });
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe(statusBefore);
    expect(readFileSync(plan, 'utf8')).toBe('spec: x_spec_planned.md\n');
  });

  it('finds a spec kept in a sibling specs directory', async () => {
    const plan = write('docs/superpowers/plans/y_plan.md', '# Plan\n');
    write('docs/superpowers/specs/y_spec_planned.md', 'see y_plan.md\n');

    const prepared = await prepareClosedDocuments(plan, repo);

    expect(prepared.mode === 'commit' && prepared.documents.map((d) => [d.relativePath, d.content])).toEqual([
      ['docs/superpowers/plans/y_plan_completed.md', '# Plan\n'],
      ['docs/superpowers/specs/y_spec_completed.md', 'see y_plan_completed.md\n'],
    ]);
  });

  it('prepares a livetest document that has no spec', async () => {
    const doc = write('docs/plans/z_livetest.md', '# checks\n');
    expect(await prepareClosedDocuments(doc, repo)).toEqual({
      mode: 'commit',
      documents: [{ relativePath: 'docs/plans/z_livetest_completed.md', content: '# checks\n' }],
    });
  });

  it('refuses, before anything lands, when a completed name is already taken or the document is gone', async () => {
    const plan = write('docs/plans/x_plan.md', 'active\n');
    write('docs/plans/x_plan_completed.md', 'someone else\n');
    await expect(prepareClosedDocuments(plan, repo)).rejects.toThrow(/Refusing to overwrite/);
    await expect(prepareClosedDocuments(join(repo, 'docs/plans/missing_plan.md'), repo)).rejects.toThrow(/Document not found/);
  });

  it('renames in place, never commits, documents outside the repository or ignored by it', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-ext-')));
    try {
      const plan = join(outside, 'x_plan.md');
      writeFileSync(plan, '# external\n');
      expect(await prepareClosedDocuments(plan, repo)).toEqual({ mode: 'rename-in-place' });
      expect(await documentsAreCommitted(plan, repo)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    write('.gitignore', 'private/\n');
    const ignored = write('private/w_plan.md', '# ignored\n');
    expect(await prepareClosedDocuments(ignored, repo)).toEqual({ mode: 'rename-in-place' });
  });

  it('refuses a plan and spec split across the repository boundary', async () => {
    write('.gitignore', 'docs/specs/\n');
    const plan = write('docs/plans/s_plan.md', '# plan\n');
    write('docs/specs/s_spec_planned.md', '# ignored spec\n');
    await expect(prepareClosedDocuments(plan, repo)).rejects.toThrow(/split across the repository boundary/);
  });
});

describe('renameDocumentsInPlace', () => {
  it('renames plan and spec and re-points their links, and is a no-op when run again', async () => {
    const plan = write('docs/plans/x_plan.md', 'spec: x_spec_planned.md\n');
    write('docs/plans/x_spec_planned.md', 'plan: x_plan.md\n');

    await renameDocumentsInPlace(plan);
    await renameDocumentsInPlace(plan);

    expect(readFileSync(join(repo, 'docs/plans/x_plan_completed.md'), 'utf8')).toBe('spec: x_spec_completed.md\n');
    expect(readFileSync(join(repo, 'docs/plans/x_spec_completed.md'), 'utf8')).toBe('plan: x_plan_completed.md\n');
    expect(existsSync(plan)).toBe(false);
  });

  it('repairs the links after a crash between the renames and the link rewrite', async () => {
    const plan = write('docs/superpowers/plans/y_plan.md', 'spec: y_spec_planned.md\n');
    write('docs/superpowers/specs/y_spec_planned.md', 'plan: y_plan.md\n');
    renameSync(plan, join(repo, 'docs/superpowers/plans/y_plan_completed.md'));
    renameSync(join(repo, 'docs/superpowers/specs/y_spec_planned.md'), join(repo, 'docs/superpowers/specs/y_spec_completed.md'));

    await renameDocumentsInPlace(plan);

    expect(readFileSync(join(repo, 'docs/superpowers/plans/y_plan_completed.md'), 'utf8')).toBe('spec: y_spec_completed.md\n');
    expect(readFileSync(join(repo, 'docs/superpowers/specs/y_spec_completed.md'), 'utf8')).toBe('plan: y_plan_completed.md\n');
  });

  it('finishes a re-run after a crash between the plan rename and the spec rename', async () => {
    const plan = write('docs/plans/w_plan.md', 'spec: w_spec_planned.md\n');
    write('docs/plans/w_spec_planned.md', 'plan: w_plan.md\n');
    renameSync(plan, join(repo, 'docs/plans/w_plan_completed.md'));

    await renameDocumentsInPlace(plan);

    expect(readFileSync(join(repo, 'docs/plans/w_plan_completed.md'), 'utf8')).toBe('spec: w_spec_completed.md\n');
    expect(readFileSync(join(repo, 'docs/plans/w_spec_completed.md'), 'utf8')).toBe('plan: w_plan_completed.md\n');
  });
});

describe('retireActiveDocuments', () => {
  function commitCompleted(files: Record<string, string>): void {
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '-q', '-m', 'landing']);
  }

  it('removes root copies identical to what landed, and is a no-op when run again', async () => {
    const plan = write('docs/plans/x_plan.md', 'spec: x_spec_planned.md\n');
    const spec = write('docs/plans/x_spec_planned.md', 'plan: x_plan.md\n');
    commitCompleted({
      'docs/plans/x_plan_completed.md': 'spec: x_spec_completed.md\n',
      'docs/plans/x_spec_completed.md': 'plan: x_plan_completed.md\n',
    });

    expect(await retireActiveDocuments(plan, repo, 'main')).toEqual([]);
    expect(await retireActiveDocuments(plan, repo, 'main')).toEqual([]);

    expect(existsSync(plan)).toBe(false);
    expect(existsSync(spec)).toBe(false);
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('keeps and reports a root copy edited after the landing commit was built', async () => {
    const plan = write('docs/plans/x_plan.md', 'edited after landing\n');
    commitCompleted({ 'docs/plans/x_plan_completed.md': 'as landed\n' });

    const notes = await retireActiveDocuments(plan, repo, 'main');

    expect(existsSync(plan)).toBe(true);
    expect(notes).toEqual([expect.stringContaining('Kept x_plan.md')]);
  });

  it('keeps a root copy whose completed version never reached the base branch', async () => {
    const plan = write('docs/plans/x_plan.md', 'active\n');
    expect(await retireActiveDocuments(plan, repo, 'main')).toEqual([]);
    expect(existsSync(plan)).toBe(true);
  });
});

describe('appendParkedNote', () => {
  it('adds one findable line and never duplicates it', async () => {
    const plan = write('docs/plans/x_plan.md', '# Plan\n\nbody\n');
    const note = { branchName: 'queue/x-abc123', reason: 'round-limit', commitCount: 4 };

    await appendParkedNote(plan, note);
    await appendParkedNote(plan, note);

    const content = readFileSync(plan, 'utf8');
    expect(content.match(/Plan Queue parked work/g)).toHaveLength(1);
    expect(content).toContain('`queue/x-abc123` — 4 commit(s), reason: round-limit.');
    expect(content.startsWith('# Plan\n\nbody')).toBe(true);
  });
});
