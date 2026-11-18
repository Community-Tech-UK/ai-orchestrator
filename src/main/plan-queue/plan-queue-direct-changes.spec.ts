import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QUEUE_LANDING_MARK,
  diffSides,
  directChangeLines,
  directChangesForItem,
  directChangesForJob,
  filesNamedIn,
  findUndoneDirectChanges,
  planReferenceTime,
  undoneDirectChangeNote,
  type DirectChange,
} from './plan-queue-direct-changes';
import { withStalePlanNotes } from './plan-queue-document-status';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (file: string, content: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
};
/** Commits every change with `subject`; `queue` adds the line every Plan Queue landing carries. */
const commit = (subject: string, when: string, queue = false) => {
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '--no-verify', '-m', queue ? `${subject}\n\n${QUEUE_LANDING_MARK} after 1 verification round(s).` : subject], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  return git('rev-parse', 'HEAD');
};
const lines = (...values: string[]) => `${values.join('\n')}\n`;
const PLAN_DATE = new Date(2026, 9, 10).getTime();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'pq-direct-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  // Before the plan: a queue landing that set up the strip with names and the worst figure.
  write('src/strip.ts', lines('const label = name;', 'const figure = worst;', 'render(label, figure);', 'export {};'));
  write('src/other.ts', lines('a', 'b', 'c'));
  commit('Plan: strip (Step 1)', '2026-10-01T10:00:00Z', true);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** James's direct change after the plan: codes and a figure per account. */
function jamesChangesStrip(): string {
  write('src/strip.ts', lines('const label = code;', 'const figure = perAccount;', 'render(label, figure, accounts);', 'export {};'));
  return commit('Show codes and one figure per account', '2026-11-15T10:00:00Z');
}

/** A job branch from `main` whose work is `change`, committed; returns its head. */
function jobBranch(change: () => void): string {
  git('checkout', '-q', '-b', 'job');
  change();
  const head = commit('Plan queue checkpoint: final', '2026-11-16T10:00:00Z');
  git('checkout', '-q', 'main');
  return head;
}

describe('findUndoneDirectChanges', () => {
  it('finds a job that puts back what a direct change removed and removes what it added', async () => {
    const direct = jamesChangesStrip();
    const head = jobBranch(() => write('src/strip.ts', lines('const label = name;', 'const figure = worst;', 'render(label, figure);', 'export {};')));
    const found = await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ commit: direct, subject: 'Show codes and one figure per account', file: 'src/strip.ts' });
    expect(found[0]!.removedLines).toHaveLength(3);
    expect(found[0]!.restoredLines).toHaveLength(3);
    expect(found[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives the same fingerprint for the same lines, whatever the job branch head is', async () => {
    jamesChangesStrip();
    const revert = () => write('src/strip.ts', lines('const label = name;', 'const figure = worst;', 'render(label, figure);', 'export {};'));
    const first = await findUndoneDirectChanges(repo, git('rev-parse', 'main'), jobBranch(revert), PLAN_DATE);
    git('branch', '-q', '-D', 'job');
    const second = await findUndoneDirectChanges(repo, git('rev-parse', 'main'), jobBranch(() => { revert(); write('src/new.ts', 'x\n'); }), PLAN_DATE);
    expect(second[0]!.fingerprint).toBe(first[0]!.fingerprint);
  });

  it('lets through a job that only edits its own lines', async () => {
    jamesChangesStrip();
    const head = jobBranch(() => write('src/other.ts', lines('a', 'B', 'c', 'd')));
    expect(await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).toEqual([]);
  });

  it('lets through a job that rewrites a direct change\'s lines without putting the old ones back', async () => {
    jamesChangesStrip();
    const head = jobBranch(() => write('src/strip.ts', lines('const label = code.toUpperCase();', 'const figure = perAccount.slice(0, 3);', 'render(label, figure, accounts, true);', 'export {};')));
    expect(await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).toEqual([]);
  });

  it('ignores direct commits older than the plan and commits the queue landed', async () => {
    write('src/strip.ts', lines('const label = code;', 'const figure = perAccount;', 'render(label, figure, accounts);', 'export {};'));
    commit('Older direct change', '2026-10-05T10:00:00Z');
    write('src/other.ts', lines('x', 'y', 'z'));
    commit('Plan: other (Step 2)', '2026-11-15T10:00:00Z', true);
    const head = jobBranch(() => {
      write('src/strip.ts', lines('const label = name;', 'const figure = worst;', 'render(label, figure);', 'export {};'));
      write('src/other.ts', lines('a', 'b', 'c'));
    });
    expect(await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).toEqual([]);
  });

  it('never compares planning documents or lockfiles', async () => {
    write('docs/plans/x_plan.md', lines('old one', 'old two', 'old three'));
    write('package-lock.json', lines('"a": 1,', '"b": 2,', '"c": 3,'));
    commit('Plan: x (Step 1)', '2026-10-01T11:00:00Z', true);
    write('docs/plans/x_plan.md', lines('new one', 'new two', 'new three'));
    write('package-lock.json', lines('"a": 4,', '"b": 5,', '"c": 6,'));
    commit('Direct edits', '2026-11-15T10:00:00Z');
    const head = jobBranch(() => {
      write('docs/plans/x_plan.md', lines('old one', 'old two', 'old three'));
      write('package-lock.json', lines('"a": 1,', '"b": 2,', '"c": 3,'));
    });
    expect(await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).toEqual([]);
  });

  it('finds a job that puts back three lines a direct change only deleted, but not one that removes lines a change only added', async () => {
    write('src/del.ts', lines('keep', 'old one', 'old two', 'old three', 'end'));
    write('src/add.ts', lines('keep', 'end'));
    commit('Plan: del (Step 1)', '2026-10-01T12:00:00Z', true);
    write('src/del.ts', lines('keep', 'end'));
    write('src/add.ts', lines('keep', 'new one', 'new two', 'new three', 'end'));
    const deleted = commit('Remove the old block and add a new one elsewhere', '2026-11-15T10:00:00Z');
    const head = jobBranch(() => {
      write('src/del.ts', lines('keep', 'old one', 'old two', 'old three', 'end'));
      write('src/add.ts', lines('keep', 'end'));
    });
    const found = await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE);
    expect(found.map(entry => [entry.commit, entry.file, entry.restoredLines.length])).toEqual([[deleted, 'src/del.ts', 3]]);
  });

  it('treats a queue checkpoint that reached main through a hand merge as the queue\'s own work', async () => {
    write('src/strip.ts', lines('const label = code;', 'const figure = perAccount;', 'render(label, figure, accounts);', 'export {};'));
    commit('Plan queue checkpoint: parked: worktree-error', '2026-11-15T10:00:00Z');
    const head = jobBranch(() => write('src/strip.ts', lines('const label = name;', 'const figure = worst;', 'render(label, figure);', 'export {};')));
    expect(await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).toEqual([]);
  });

  it('compares a file whose name has non-ASCII letters or pattern characters', async () => {
    write('src/café[1].ts', lines('a1', 'a2', 'a3'));
    commit('Plan: odd (Step 1)', '2026-10-01T12:00:00Z', true);
    write('src/café[1].ts', lines('b1', 'b2', 'b3'));
    commit('Direct rename of the letters', '2026-11-15T10:00:00Z');
    const head = jobBranch(() => write('src/café[1].ts', lines('a1', 'a2', 'a3')));
    expect((await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).map(entry => entry.file)).toEqual(['src/café[1].ts']);
  });

  it('protects a direct commit that only quotes the landing phrase, and a path containing " b/"', async () => {
    write('x b/strip.ts', lines('one', 'two', 'three'));
    commit('Plan: x (Step 1)', '2026-10-01T12:00:00Z', true);
    write('x b/strip.ts', lines('uno', 'dos', 'tres'));
    commit(`Explain the queue\n\nJobs say "${QUEUE_LANDING_MARK}" when they land; this is a direct change.`, '2026-11-15T10:00:00Z');
    const head = jobBranch(() => write('x b/strip.ts', lines('one', 'two', 'three')));
    expect((await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE)).map(entry => entry.file)).toEqual(['x b/strip.ts']);
  });

  it('needs every line when the direct change touched fewer than three', async () => {
    write('src/one.ts', lines('keep', 'flag = false;', 'end'));
    commit('Plan: one (Step 1)', '2026-10-01T12:00:00Z', true);
    write('src/one.ts', lines('keep', 'flag = true;', 'end'));
    commit('Turn the flag on', '2026-11-15T10:00:00Z');
    const head = jobBranch(() => write('src/one.ts', lines('keep', 'flag = false;', 'end')));
    const found = await findUndoneDirectChanges(repo, git('rev-parse', 'main'), head, PLAN_DATE);
    expect(found.map(entry => [entry.file, entry.removedLines, entry.restoredLines])).toEqual([['src/one.ts', ['flag = true;'], ['flag = false;']]]);
  });
});

describe('directChangesForJob', () => {
  it('lists direct changes to files the branch changed or the plan names, newest first', async () => {
    const strip = jamesChangesStrip();
    write('src/other.ts', lines('x', 'y', 'z'));
    const other = commit('Rename the letters', '2026-11-16T09:00:00Z');
    const worktree = join(repo, '.wt');
    git('worktree', 'add', '-q', '-b', 'job', worktree, 'main');
    writeFileSync(join(worktree, 'src', 'other.ts'), lines('x', 'y', 'z', 'w'));
    execFileSync('git', ['commit', '-q', '--no-verify', '-am', 'checkpoint'], { cwd: worktree });
    const named = await directChangesForJob({ repoRoot: repo, baseBranch: 'main', sinceMs: PLAN_DATE, planText: 'Change `strip.ts` only.' });
    expect(named.map(change => change.commit)).toEqual([strip]);
    const both = await directChangesForJob({ repoRoot: repo, baseBranch: 'main', sinceMs: PLAN_DATE, planText: 'Change `strip.ts` only.', worktreePath: worktree });
    expect(both.map(change => [change.commit, change.files])).toEqual([[other, ['src/other.ts']], [strip, ['src/strip.ts']]]);
  });
});

describe('directChangesForItem', () => {
  it('reads only its own step\'s file names for a step job, and the whole plan otherwise', async () => {
    const strip = jamesChangesStrip();
    write('src/other.ts', lines('x', 'y', 'z'));
    const other = commit('Rename the letters', '2026-11-16T09:00:00Z');
    const plan = join(repo, '2026-10-10-x_plan.md');
    writeFileSync(plan, '# Plan\n\n## Step 1. Letters\n\nEdit `other.ts`.\n\n## Step 2. Strip\n\nEdit `strip.ts`.\n');
    const run = { workspaceCwd: repo, config: { baseBranch: 'main' } } as never;
    const item = { id: 'i', sourceRef: plan, createdAt: Date.now(), worktreePath: null } as never as Parameters<typeof directChangesForItem>[1];
    expect((await directChangesForItem(run, { ...item, section: 2 })).map(change => change.commit)).toEqual([strip]);
    expect((await directChangesForItem(run, { ...item, section: null })).map(change => change.commit)).toEqual([other, strip]);
  });
});

describe('helpers', () => {
  it('reads the plan date from its file name', () => {
    expect(planReferenceTime('/x/docs/plans/2026-10-10-oct-phase3_plan.md')).toBe(new Date(2026, 9, 10).getTime());
  });

  it('resolves backticked names by path, base name and prefix', () => {
    const tracked = ['src/a/control-surface-shell.component.ts', 'src/a/control-surface-shell.component.html', 'src/b/settings.ts', 'docs/x.md'];
    expect(filesNamedIn('Edit `control-surface-shell.component.*` and `src/b/settings.ts:12-40`, not `nothing.ts`.', tracked))
      .toEqual(['src/a/control-surface-shell.component.ts', 'src/a/control-surface-shell.component.html', 'src/b/settings.ts']);
  });

  it('reads both sides of a diff, distinct and without blank lines', () => {
    const sides = diffSides('diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n-old\n+new\n+\n');
    expect(sides.get('f.ts')).toEqual({ added: new Set(['new']), removed: new Set(['old']) });
  });

  it('reads content lines that look like file headers inside a hunk', () => {
    const sides = diffSides('diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new counter\n');
    expect(sides.get('q.sql')).toEqual({ added: new Set(['++ new counter']), removed: new Set(['-- old comment']) });
  });

  it('says what each answer does in the park note', () => {
    const note = undoneDirectChangeNote([{ commit: '2924bfbab0', date: '2026-11-10T20:00:25Z', subject: 'October updates', file: 'src/a/shell.html', removedLines: [], restoredLines: [], fingerprint: '0' }], 'main');
    expect(note).toContain('made directly on main on 10 Nov 2026 ("October updates") in shell.html');
    expect(note).not.toContain('2924bfbab');
    expect(note).toContain('Keep that change (Resume): the worker puts back what that commit did');
    expect(note).toContain('take the job\'s version (Merge without checks), on the Plan Queue page or the phone; no session can choose that.');
  });

  it('caps the prompt list and says how many are left out', () => {
    const changes: DirectChange[] = Array.from({ length: 22 }, (_, i) => ({ commit: `${i}`.padStart(9, 'a'), date: '2026-11-10T10:00:00Z', subject: `s${i}`, files: ['f.ts'] }));
    const shown = directChangeLines(changes);
    expect(shown).toHaveLength(21);
    expect(shown.at(-1)).toBe('(2 older ones not shown; `git log` lists them.)');
  });

  it('writes a stale-text note under its step once, leaving other steps alone', () => {
    const plan = '# Plan\n\n## Step 9. Menus\n\nText.\n\n## Step 10. Settings\n\nHide the menu.\n';
    const note = { commit: '2924bfbab0123', date: '10 Nov 2026', step: 10, sentence: 'Hide the menu.' };
    const once = withStalePlanNotes(plan, [note], 9);
    expect(once).toBe('# Plan\n\n## Step 9. Menus\n\nText.\n\n## Step 10. Settings\n\n> Overridden by 2924bfbab, 10 Nov 2026: "Hide the menu." no longer applies; keep that change.\n\nHide the menu.\n');
    expect(withStalePlanNotes(once, [note], 9)).toBe(once);
    expect(withStalePlanNotes(plan, [{ ...note, step: null }], 9)).toContain('## Step 9. Menus\n\n> Overridden by');
  });
});
