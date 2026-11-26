import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRetirement, applyScratchCleanup, checkSummary, inventory, isClosed, destination, parseAsOf, scratchInventory, writeReview } from '../retire-docs';

let root: string;
const now = new Date('2026-10-11T00:00:00Z');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function write(path: string, content = '# Example\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function commit(date = '2026-09-01T00:00:00Z') {
  git('add', '.');
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retire-docs-'));
  git('init', '-q'); git('config', 'core.hooksPath', '/dev/null'); write('.gitignore', '_scratch/\n.aio-review/\n');
  write('docs/plans/old_plan_completed.md'); commit();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('retirement inventory', () => {
  it('recognizes closed names and maps destinations without changing names', () => {
    for (const name of ['x_completed.md', 'x_Completed.md', 'x.COMPLETED.md', 'x_livetest_completed.md', 'x-superseded.md']) expect(isClosed(name)).toBe(true);
    for (const name of ['x_plan.md', 'x_spec.md', 'x_spec_planned.md', 'x_livetest.md', 'x_report.md']) expect(isClosed(name)).toBe(false);
    expect(destination('docs/plans/old_plan_completed.md')).toBe('docs/_archive/plans/old_plan_completed.md');
    expect(destination('old_completed.md')).toBe('docs/_archive/_root/old_completed.md');
    expect(parseAsOf('2026-10-11').getHours()).toBe(0);
    expect(() => parseAsOf('2026-02-30')).toThrow();
  });
  it('uses a strict age boundary', () => {
    write('docs/plans/boundary_completed.md'); commit('2026-09-11T00:00:00Z');
    const report = inventory(root, now, 30);
    expect(report.candidates.map((d) => d.path)).toEqual(['docs/plans/old_plan_completed.md']);
    expect(report.held.find((d) => d.path.includes('boundary'))?.reason).toBe('too recent');
  });
  it('pins relative links, repo paths, AGENTS pointers and code citations, but not bare names or closed citations', () => {
    for (const name of ['relative', 'full', 'agent', 'code', 'bare', 'closed']) write(`docs/plans/${name}_completed.md`);
    write('docs/plans/live_plan.md', '[x](relative_completed.md#heading) `docs/plans/full_completed.md` bare_completed.md');
    write('AGENTS.md', '`docs/plans/agent_completed.md`'); write('src/example.ts', '// docs/plans/code_completed.md');
    write('docs/plans/citer_completed.md', '[x](closed_completed.md)'); commit();
    const report = inventory(root, now, 30);
    expect(report.candidates.map((d) => d.path)).toContain('docs/plans/bare_completed.md');
    expect(report.candidates.map((d) => d.path)).toContain('docs/plans/closed_completed.md');
    for (const name of ['relative', 'full', 'agent', 'code']) expect(report.held.find((d) => d.path.endsWith(`${name}_completed.md`))?.reason).toContain('cited by');
  });
  it('holds working edits, staged changes, untracked docs and excluded scopes', () => {
    write('docs/plans/staged_completed.md');
    for (const dir of ['docs/runbooks', 'docs/llm', 'docs/generated', 'docs/_archive', 'resources', 'src', 'apps', 'packages']) write(`${dir}/x_completed.md`);
    commit(); write('docs/plans/old_plan_completed.md', 'edited');
    write('docs/plans/staged_completed.md', 'staged'); git('add', 'docs/plans/staged_completed.md');
    write('docs/plans/untracked_completed.md', 'mine');
    const report = inventory(root, now, 30);
    expect(report.candidates).toEqual([]);
    expect(report.held.find((d) => d.path.includes('old_plan'))?.reason).toContain('local change');
    expect(report.untracked.map((d) => d.path)).toContain('docs/plans/untracked_completed.md');
  });
  it('writes only the ignored review and preserves status and the index tree', () => {
    const before = git('status', '--porcelain'); const tree = git('write-tree');
    const review = writeReview(root, inventory(root, now, 30));
    expect(readFileSync(review, 'utf8')).toContain('Group 3');
    expect(git('status', '--porcelain')).toBe(before); expect(git('write-tree')).toBe(tree);
  });
  it('lists old reference docs for review and reads the newest batch', () => {
    write('docs/reference.md'); write('docs/README.md'); write('docs/active_plan.md'); commit('2026-01-01T00:00:00Z');
    const report = inventory(root, now, 30);
    expect(report.review.map((d) => d.path)).toEqual(['docs/reference.md']);
    write('docs/_archive/INDEX.md', '## Batch 2026-07-01\n## Batch 2026-10-01\n');
    expect(checkSummary(root, report)).toContain('Last batch: 2026-10-01');
    expect(checkSummary(root, report).split('\n')).toHaveLength(1);
  });
});

describe('retirement apply (temporary repositories only)', () => {
  it('hides retired content from default ripgrep search and permits explicit archive search', () => {
    write('.ignore', readFileSync(join(process.cwd(), '.ignore'), 'utf8'));
    write('docs/plans/old_plan_completed.md', '# Example\nretirement_search_fixture_unique_body\n');
    commit();
    expect(execFileSync('rg', ['retirement_search_fixture_unique_body', '.'], { cwd: root, encoding: 'utf8' })).toContain('docs/plans/old_plan_completed.md');
    applyRetirement(root, { now, cutoffDays: 30, all: true });
    const defaultSearch = spawnSync('rg', ['retirement_search_fixture_unique_body', '.'], { cwd: root, encoding: 'utf8' });
    expect(defaultSearch.status).toBe(1);
    expect(defaultSearch.stdout).toBe('');
    expect(execFileSync('rg', ['--no-ignore', 'retirement_search_fixture_unique_body', 'docs/_archive'], { cwd: root, encoding: 'utf8' })).toContain('old_plan_completed.md');
  });
  it('moves unchanged blobs, stages the index, preserves unrelated staged work and never commits', () => {
    write('unrelated.txt', 'original'); commit(); write('unrelated.txt', 'staged'); git('add', 'unrelated.txt');
    write('docs/plans/untracked_completed.md', 'mine');
    const head = git('rev-parse', 'HEAD'); const staged = git('rev-parse', ':unrelated.txt');
    const blob = git('rev-parse', ':docs/plans/old_plan_completed.md');
    const result = applyRetirement(root, { now, cutoffDays: 30, all: true });
    expect(result.moved).toHaveLength(1); expect(git('status', '--porcelain')).toContain('R ');
    expect(git('rev-parse', ':docs/_archive/plans/old_plan_completed.md')).toBe(blob);
    expect(git('rev-parse', ':unrelated.txt')).toBe(staged); expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(root, 'docs/plans/untracked_completed.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(root, 'docs/_archive/INDEX.md'), 'utf8')).toContain('## Batch 2026-10-11');
    expect(readFileSync(result.pathsFile!, 'utf8')).toContain('docs/_archive/INDEX.md');
    expect(inventory(root, now, 30).candidates).toEqual([]);
  });
  it('requires explicit groups, supports a clean-index requirement and refuses destination overlap', () => {
    expect(() => applyRetirement(root, { now, cutoffDays: 30 })).toThrow(/groups|all/);
    write('other.txt'); git('add', 'other.txt');
    expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true, requireCleanIndex: true })).toThrow(/index/);
    write('docs/_archive/plans/old_plan_completed.md');
    expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true })).toThrow(/destination/i);
    expect(existsSync(join(root, 'docs/plans/old_plan_completed.md'))).toBe(true);
  });
  it('refuses a changed INDEX before any move', () => {
    write('docs/_archive/INDEX.md'); commit(); write('docs/_archive/INDEX.md', 'changed');
    expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true })).toThrow(/INDEX/);
    expect(existsSync(join(root, 'docs/plans/old_plan_completed.md'))).toBe(true);
  });
  it('refuses a symlinked archive parent before moving anything', () => {
    const external = mkdtempSync(join(tmpdir(), 'retirement-external-'));
    try {
      mkdirSync(join(root, 'docs/_archive'), { recursive: true });
      symlinkSync(external, join(root, 'docs/_archive/plans'));
      expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true })).toThrow(/real directory/);
      expect(existsSync(join(root, 'docs/plans/old_plan_completed.md'))).toBe(true);
    } finally { rmSync(external, { recursive: true, force: true }); }
  });
  it('refuses a tracked symlink INDEX before moving or changing the target', () => {
    write('target.txt', 'operator work');
    mkdirSync(join(root, 'docs/_archive'), { recursive: true });
    symlinkSync('../../target.txt', join(root, 'docs/_archive/INDEX.md'));
    commit();
    expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true })).toThrow(/regular file/);
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('operator work');
    expect(existsSync(join(root, 'docs/plans/old_plan_completed.md'))).toBe(true);
  });
  it('keeps the legacy README when an untracked closed sibling must stay', () => {
    write('docs/plans/completed/README.md'); write('docs/plans/completed/tracked_completed.md'); commit();
    write('docs/plans/completed/untracked_completed.md', 'mine');
    expect(inventory(root, now, 30).candidates.map((d) => d.path)).not.toContain('docs/plans/completed/README.md');
    applyRetirement(root, { now, cutoffDays: 30, groups: [5] });
    expect(readFileSync(join(root, 'docs/plans/completed/untracked_completed.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(root, 'docs/plans/completed/README.md'))).toBe(true);
  });
  it('refuses changed generated inventory and leaves a locally changed candidate in place', () => {
    write('docs/generated/architecture-inventory.json', '{}'); commit();
    write('docs/generated/architecture-inventory.json', 'changed');
    expect(() => applyRetirement(root, { now, cutoffDays: 30, all: true })).toThrow(/architecture-inventory/);
    expect(existsSync(join(root, 'docs/plans/old_plan_completed.md'))).toBe(true);
  });
  it('selects only approved groups and takes the legacy README only with every sibling closed doc', () => {
    write('docs/superpowers/plans/x_completed.md'); write('docs/plans/completed/README.md'); write('docs/plans/completed/x_completed.md'); commit();
    const result = applyRetirement(root, { now, cutoffDays: 30, groups: [1] });
    expect(result.moved.map((d) => d.path)).toEqual(['docs/superpowers/plans/x_completed.md']);
    expect(existsSync(join(root, 'docs/plans/completed/README.md'))).toBe(true);
  });
});

describe('disposable-folder sweep (part 1f)', () => {
  const stamp = (path: string, iso: string) => {
    const time = new Date(iso);
    utimesSync(join(root, path), time, time);
  };

  it('lists entries by newest-file age and never the protected folders', () => {
    write('_scratch/old/keep.txt');
    write('_scratch/old/nested/keep.txt');
    write('_scratch/mixed/old.txt');
    write('_scratch/mixed/new.txt');
    write('_scratch/oct-phases/report.md');
    write('_scratch/oct-audit/report.md');
    write('_scratch/named-in-plan/notes.txt');
    write('docs/plans/open_plan.md', 'The research is kept in `_scratch/named-in-plan`.');
    for (const path of ['_scratch/old', '_scratch/old/keep.txt', '_scratch/old/nested', '_scratch/old/nested/keep.txt',
      '_scratch/mixed', '_scratch/mixed/old.txt', '_scratch/oct-phases', '_scratch/oct-phases/report.md',
      '_scratch/oct-audit', '_scratch/oct-audit/report.md', '_scratch/named-in-plan', '_scratch/named-in-plan/notes.txt']) {
      stamp(path, '2026-08-01T00:00:00Z');
    }
    stamp('_scratch/mixed/new.txt', '2026-10-10T00:00:00Z');

    const entries = scratchInventory(root, now);

    expect(entries.map((entry) => entry.path)).toEqual(['_scratch/old']);
    expect(entries[0].files).toBe(2);
    expect(entries[0].bytes).toBeGreaterThan(0);
  });

  it('lists .aio-review pages over 14 days only', () => {
    write('.aio-review/old-page.html');
    write('.aio-review/new-page.html');
    stamp('.aio-review/old-page.html', '2026-09-01T00:00:00Z');
    stamp('.aio-review/new-page.html', '2026-10-08T00:00:00Z');
    const entries = scratchInventory(root, now);
    expect(entries.map((entry) => entry.path)).toEqual(['.aio-review/old-page.html']);
    expect(entries[0].kind).toBe('review');
  });

  it('deletes only the listed entries and refuses anything touched in the last 14 days', () => {
    write('_scratch/old-one/file.txt');
    write('_scratch/old-two/file.txt');
    write('_scratch/keep-me/file.txt');
    for (const path of ['_scratch/old-one', '_scratch/old-one/file.txt', '_scratch/old-two', '_scratch/old-two/file.txt']) {
      stamp(path, '2026-08-01T00:00:00Z');
    }
    for (const path of ['_scratch/keep-me', '_scratch/keep-me/file.txt']) stamp(path, '2026-10-10T00:00:00Z');
    const listed = scratchInventory(root, now);
    expect(listed.map((entry) => entry.path).sort()).toEqual(['_scratch/old-one', '_scratch/old-two']);
    stamp('_scratch/old-two/file.txt', '2026-10-10T00:00:00Z');

    const result = applyScratchCleanup(root, listed, now);

    expect(result.deleted.map((entry) => entry.path)).toEqual(['_scratch/old-one']);
    expect(result.refused.map((entry) => entry.path)).toEqual(['_scratch/old-two']);
    expect(existsSync(join(root, '_scratch/old-one'))).toBe(false);
    expect(existsSync(join(root, '_scratch/old-two/file.txt'))).toBe(true);
    expect(existsSync(join(root, '_scratch/keep-me/file.txt'))).toBe(true);
  });
});
