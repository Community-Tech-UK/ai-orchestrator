import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import {
  appendParkedNote,
  assertNoOtherUnlandedWork,
  completedDocumentPath,
  documentsAreCommitted,
  prepareClosedDocuments,
  renameDocumentsInPlace,
  removeParkedNote,
  retireActiveDocuments,
} from './plan-queue-doc-close';

let repo: string;

describe('close-small evidence publication', () => {
  it('refuses invalid UTF-8 instead of replacing source bytes while claiming an exact closure identity', async () => {
    const plan = write('docs/plans/encoding_plan.md', 'placeholder');
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe]);
    writeFileSync(plan, bytes);
    await expect(prepareClosedDocuments(plan, repo, null, null)).rejects.toThrow(/UTF-8/);
    expect(readFileSync(plan)).toEqual(bytes);
    expect(existsSync(join(repo, 'docs/plans/encoding_plan_completed.md'))).toBe(false);
  });
  it('treats a dangling completed-file link as an occupied name', async () => {
    const plan = write('docs/plans/link_plan.md', 'active\n');
    symlinkSync('missing.md', join(repo, 'docs/plans/link_plan_completed.md'));
    await expect(prepareClosedDocuments(plan, repo, null, null)).rejects.toThrow(/Refusing to overwrite/);
  });

  it('surfaces a failed ignore query rather than assuming the document is committable', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'aio-non-repository-')));
    try {
      const doc = join(plain, 'x_plan.md'); writeFileSync(doc, '# Plan\n');
      await expect(documentsAreCommitted(doc, plain)).rejects.toThrow();
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
  it('keeps the exact journal in immutable history while closing a small plan', async () => {
    const journal = '### 2026-10-31\nObserved runtime behaviour.\n';
    const plan = write('docs/plans/small_plan.md', '# Plan\n\n## As-built\nImplemented.\n\n' + journal);
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    expect(prepared.mode).toBe('commit');
    if (prepared.mode !== 'commit') throw new Error('Expected landing documents');
    const closed = prepared.documents.find(d => d.relativePath.endsWith('small_plan_completed.md'))!;
    const history = prepared.documents.find(d => /_history_[a-f0-9]{64}_completed.md$/.test(d.relativePath));
    expect(history?.content).toContain(journal);
    expect(closed.content).not.toContain('Observed runtime behaviour.');
    expect(closed.content).toContain(history!.relativePath.split('/').pop());
    expect(readFileSync(plan, 'utf8')).toContain(journal);
  });

  it('refuses a tracked completed file even when deleted from the working tree', async () => {
    const closed = write('docs/plans/locked_plan_completed.md', 'immutable\n');
    git(['add', '--', 'docs/plans/locked_plan_completed.md']);
    git(['commit', '-q', '-m', 'closed evidence']);
    rmSync(closed);
    const plan = write('docs/plans/locked_plan.md', 'replacement\n');
    await expect(prepareClosedDocuments(plan, repo, null, null)).rejects.toThrow(/Refusing to overwrite/);
  });

  it('preserves earlier completed histories and snapshots their exact bytes', async () => {
    const plan = write('docs/plans/shared_plan.md', '# Plan\n## As-built\n### 2026-10-31\nnew journal\n');
    const prior = write('docs/plans/shared_history_completed.md', 'earlier immutable bytes \n\n');
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    expect(prepared.mode === 'commit' && prepared.documents.some(d => d.content.includes('earlier immutable bytes \n\n'))).toBe(true);
    expect(readFileSync(prior, 'utf8')).toBe('earlier immutable bytes \n\n');
  });
});

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

    const prepared = await prepareClosedDocuments(plan, repo, null, null);

    expect(prepared).toMatchObject({
      mode: 'commit',
      documents: expect.arrayContaining([
        { relativePath: 'docs/plans/x_plan_completed.md', content: 'spec: x_spec_completed.md\n' },
        { relativePath: 'docs/plans/x_spec_completed.md', content: 'plan: x_plan_completed.md\n' },
      ]),
    });
    expect(prepared.mode === 'commit' && prepared.documents).toHaveLength(3);
    expect(prepared.mode === 'commit' && prepared.documents[2].relativePath).toBe('docs/plans/x_plan_closure_completed.json');
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe(statusBefore);
    expect(readFileSync(plan, 'utf8')).toBe('spec: x_spec_planned.md\n');
  });

  it('finds a spec kept in a sibling specs directory', async () => {
    const plan = write('docs/superpowers/plans/y_plan.md', '# Plan\n');
    write('docs/superpowers/specs/y_spec_planned.md', 'see y_plan.md\n');

    const prepared = await prepareClosedDocuments(plan, repo, null, null);

    expect(prepared.mode === 'commit' && prepared.documents.slice(0, 2).map((d) => [d.relativePath, d.content])).toEqual([
      ['docs/superpowers/plans/y_plan_completed.md', '# Plan\n'],
      ['docs/superpowers/specs/y_spec_completed.md', 'see y_plan_completed.md\n'],
    ]);
  });

  it('prepares a livetest document that has no spec', async () => {
    const doc = write('docs/plans/z_livetest.md', '# checks\n');
    expect(await prepareClosedDocuments(doc, repo, null, null)).toMatchObject({
      mode: 'commit',
      documents: expect.arrayContaining([{ relativePath: 'docs/plans/z_livetest_completed.md', content: '# checks\n' }]),
    });
  });

  it('refuses, before anything lands, when a completed name is already taken or the document is gone', async () => {
    const plan = write('docs/plans/x_plan.md', 'active\n');
    write('docs/plans/x_plan_completed.md', 'someone else\n');
    await expect(prepareClosedDocuments(plan, repo, null, null)).rejects.toThrow(/Refusing to overwrite/);
    await expect(prepareClosedDocuments(join(repo, 'docs/plans/missing_plan.md'), repo, null, null)).rejects.toThrow(/Document not found/);
  });

  it('renames in place, never commits, documents outside the repository or ignored by it', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-ext-')));
    try {
      const plan = join(outside, 'x_plan.md');
      writeFileSync(plan, '# external\n');
      expect(await prepareClosedDocuments(plan, repo, null, null)).toEqual({ mode: 'rename-in-place' });
      expect(await documentsAreCommitted(plan, repo)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    write('.gitignore', 'private/\n');
    const ignored = write('private/w_plan.md', '# ignored\n');
    expect(await prepareClosedDocuments(ignored, repo, null, null)).toEqual({ mode: 'rename-in-place' });
  });

  it('refuses a plan and spec split across the repository boundary', async () => {
    write('.gitignore', 'docs/specs/\n');
    const plan = write('docs/plans/s_plan.md', '# plan\n');
    write('docs/specs/s_spec_planned.md', '# ignored spec\n');
    await expect(prepareClosedDocuments(plan, repo, null, null)).rejects.toThrow(/split across the repository boundary/);
  });
});

describe('renameDocumentsInPlace', () => {
  it('renames plan and spec and re-points their links, and is a no-op when run again', async () => {
    const plan = write('docs/plans/x_plan.md', 'spec: x_spec_planned.md\n');
    write('docs/plans/x_spec_planned.md', 'plan: x_plan.md\n');

    await renameDocumentsInPlace(plan, null);
    await renameDocumentsInPlace(plan, null);

    expect(readFileSync(join(repo, 'docs/plans/x_plan_completed.md'), 'utf8')).toBe('spec: x_spec_completed.md\n');
    expect(readFileSync(join(repo, 'docs/plans/x_spec_completed.md'), 'utf8')).toBe('plan: x_plan_completed.md\n');
    expect(existsSync(plan)).toBe(false);
  });

  it('preserves legacy completed documents without source identity after a partial old rename', async () => {
    const plan = write('docs/superpowers/plans/y_plan.md', 'spec: y_spec_planned.md\n');
    write('docs/superpowers/specs/y_spec_planned.md', 'plan: y_plan.md\n');
    renameSync(plan, join(repo, 'docs/superpowers/plans/y_plan_completed.md'));
    renameSync(join(repo, 'docs/superpowers/specs/y_spec_planned.md'), join(repo, 'docs/superpowers/specs/y_spec_completed.md'));

    await expect(renameDocumentsInPlace(plan, null)).rejects.toThrow(/Document not found/);

    expect(readFileSync(join(repo, 'docs/superpowers/plans/y_plan_completed.md'), 'utf8')).toBe('spec: y_spec_planned.md\n');
    expect(readFileSync(join(repo, 'docs/superpowers/specs/y_spec_completed.md'), 'utf8')).toBe('plan: y_plan.md\n');
  });

  it('keeps a legacy partial closure for manual reconciliation rather than rewriting closed evidence', async () => {
    const plan = write('docs/plans/w_plan.md', 'spec: w_spec_planned.md\n');
    write('docs/plans/w_spec_planned.md', 'plan: w_plan.md\n');
    renameSync(plan, join(repo, 'docs/plans/w_plan_completed.md'));

    await expect(renameDocumentsInPlace(plan, null)).rejects.toThrow(/Document not found/);

    expect(readFileSync(join(repo, 'docs/plans/w_plan_completed.md'), 'utf8')).toBe('spec: w_spec_planned.md\n');
    expect(readFileSync(join(repo, 'docs/plans/w_spec_planned.md'), 'utf8')).toBe('plan: w_plan.md\n');
  });

  it('resumes interrupted publication from its receipt without overwriting any completed file', async () => {
    const plan = write('docs/plans/resume_plan.md', '# Plan\n## As-built\n### 2026-10-31\njournal\n');
    write('docs/plans/resume_spec_planned.md', 'see resume_plan.md\n');
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    if (prepared.mode !== 'commit') throw new Error('Expected landing documents');
    const receipt = prepared.documents.find(d => d.relativePath.endsWith('_closure_completed.json'))!;
    const history = prepared.documents.find(d => /_history_[a-f0-9]{64}_completed.md$/.test(d.relativePath))!;
    // Real crash boundary: identity and journal published, source files intact,
    // completed plan/spec not yet published.
    write(receipt.relativePath, receipt.content);
    const published = write(history.relativePath, history.content);
    const inode = statSync(published).ino;
    expect(existsSync(plan)).toBe(true);
    await renameDocumentsInPlace(plan, null);
    await renameDocumentsInPlace(plan, null);
    expect(statSync(published).ino).toBe(inode);
    expect(readFileSync(published, 'utf8')).toBe(history.content);
    expect(existsSync(plan)).toBe(false);
    expect(readFileSync(join(repo, 'docs/plans/resume_spec_completed.md'), 'utf8')).toBe('see resume_plan_completed.md\n');
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
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    if (prepared.mode !== 'commit') throw new Error('Expected landing documents');
    commitCompleted(Object.fromEntries(prepared.documents.map(d => [d.relativePath, d.content])));

    expect(await retireActiveDocuments(plan, repo, 'main', null)).toEqual([]);
    expect(await retireActiveDocuments(plan, repo, 'main', null)).toEqual([]);

    expect(existsSync(plan)).toBe(false);
    expect(existsSync(spec)).toBe(false);
    const retained = readdirSync(join(repo, 'docs/plans')).filter(name => name.includes('.aio-retained-'));
    expect(retained).toHaveLength(2);
    expect(retained.map(name => readFileSync(join(repo, 'docs/plans', name), 'utf8')).sort()).toEqual(['plan: x_plan.md\n', 'spec: x_spec_planned.md\n']);
    expect(git(['status', '--porcelain', '--untracked-files=all']).split('\n').sort())
      .toEqual(retained.map(name => `?? docs/plans/${name}`).sort());
  });

  it('keeps and reports a root copy edited after the landing commit was built', async () => {
    const plan = write('docs/plans/x_plan.md', 'edited after landing\n');
    commitCompleted({ 'docs/plans/x_plan_completed.md': 'as landed\n' });

    const notes = await retireActiveDocuments(plan, repo, 'main', null);

    expect(existsSync(plan)).toBe(true);
    expect(notes).toEqual([expect.stringContaining('Kept x_plan.md')]);
  });

  it('keeps a root copy whose completed version never reached the base branch', async () => {
    const plan = write('docs/plans/x_plan.md', 'active\n');
    expect(await retireActiveDocuments(plan, repo, 'main', null)).toEqual([]);
    expect(existsSync(plan)).toBe(true);
  });
});

describe('appendParkedNote', () => {
  it('removes this branch parked note before rebuilding the completed copy', async () => {
    const plan = write('docs/plans/retry_plan.md', '# Plan\n\nbody\n');
    await appendParkedNote(plan, { branchName: 'queue/retry', reason: 'land-blocked', commitCount: 2 });
    await removeParkedNote(plan, 'queue/retry');
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    expect(prepared.mode === 'commit' && prepared.documents[0].content).toBe('# Plan\n\nbody\n');
    expect(readFileSync(plan, 'utf8')).not.toContain('Plan Queue parked work');
  });
  it.each(['# Plan\n', '# Plan', '# Plan\n\n', '# Plan  \n\n\n'])('puts the document back byte for byte, so a built commit still matches it: %j', async (original) => {
    const plan = write('docs/plans/exact_plan.md', original);
    await appendParkedNote(plan, { branchName: 'queue/exact', reason: 'land-blocked', commitCount: 1 });
    await removeParkedNote(plan, 'queue/exact');
    expect(readFileSync(plan, 'utf8')).toBe(original);
  });

  it('still removes the note when someone added text below it', async () => {
    const plan = write('docs/plans/below_plan.md', '# Plan\n');
    await appendParkedNote(plan, { branchName: 'queue/below', reason: 'land-blocked', commitCount: 1 });
    writeFileSync(plan, `${readFileSync(plan, 'utf8')}\nAdded later.\n`);
    await removeParkedNote(plan, 'queue/below');
    expect(readFileSync(plan, 'utf8')).not.toContain('Plan Queue parked work');
    expect(readFileSync(plan, 'utf8')).toContain('Added later.');
  });

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

describe('saying whether closed work is on main', () => {
  it('refuses to close a plan or its spec whose Status names work on another branch, and allows its own branch', async () => {
    const plan = write('docs/plans/other_plan.md', '# Plan\n\n## Status\n\nOn main: no (`queue/other-branch`)\n');
    await expect(assertNoOtherUnlandedWork(plan, 'queue/this-branch')).rejects.toThrow(/Status names other unlanded work \(queue\/other-branch\)/);
    await expect(assertNoOtherUnlandedWork(plan, 'queue/other-branch')).resolves.toBeUndefined();

    const clean = write('docs/plans/clean_plan.md', '# Plan\n\n## Status\n\nOn main: yes (abc1234)\n');
    write('docs/plans/clean_spec_planned.md', '# Spec\n\n## Status\n\nOn main: no (queue/spec-branch)\n');
    await expect(assertNoOtherUnlandedWork(clean, 'queue/this-branch')).rejects.toThrow(/clean_spec_planned\.md/);
  });

  it('does not refuse a close because the On main line mentions a file path or hyphenated words', async () => {
    const plan = write('docs/plans/prose_plan.md', '# Plan\n\n## Status\n\nOn main: no, waiting on docs/plan.md review of the feature-flag work\n');
    await expect(assertNoOtherUnlandedWork(plan, 'queue/this-branch')).resolves.toBeUndefined();
  });

  it('writes "On main: yes" into the closed copies that land with the code, and leaves a plan without Status alone', async () => {
    const plan = write('docs/plans/status_plan.md', '# Plan\n\n## Status\n\nOn main: no (queue/this-branch)\nNext: nothing.\n');
    write('docs/plans/status_spec_planned.md', '# Spec\n\n## Status\n\nOn main: no\n');
    const prepared = await prepareClosedDocuments(plan, repo, null, null);
    if (prepared.mode !== 'commit') throw new Error('Expected landing documents');
    const closed = prepared.documents.find(d => d.relativePath.endsWith('status_plan_completed.md'))!;
    expect(closed.content).toContain('On main: yes (this landing commit)');
    expect(closed.content).not.toContain('On main: no');
    expect(closed.content).toContain('Next: nothing.');
    expect(prepared.documents.find(d => d.relativePath.endsWith('status_spec_completed.md'))!.content).toContain('On main: yes (this landing commit)');
    expect(readFileSync(plan, 'utf8')).toContain('On main: no (queue/this-branch)');

    const bare = write('docs/plans/bare_plan.md', '# Plan\n\nNo status block.\n');
    const bareClosed = await prepareClosedDocuments(bare, repo, null, null);
    if (bareClosed.mode !== 'commit') throw new Error('Expected landing documents');
    expect(bareClosed.documents.find(d => d.relativePath.endsWith('bare_plan_completed.md'))!.content).toBe('# Plan\n\nNo status block.\n');
  });

  it('writes the landed commit into documents closed in place, and keeps that on a repeat', async () => {
    const plan = write('docs/plans/place_plan.md', '# Plan\n\n## Status\n\nOn main: no (queue/this-branch)\n');
    await renameDocumentsInPlace(plan, null, 'abc1234');
    await renameDocumentsInPlace(plan, null, 'abc1234');
    expect(readFileSync(join(repo, 'docs/plans/place_plan_completed.md'), 'utf8')).toContain('On main: yes (abc1234)');
    expect(existsSync(plan)).toBe(false);
  });
});
