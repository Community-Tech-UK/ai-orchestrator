import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverPlanQueueDocuments } from './plan-queue-discovery';

let root: string;
const selected = 'docs/plans/z-target_plan.md';

function write(relative: string, content = '# Plan\n'): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function unrelated(count: number, suffix = '.md'): void {
  for (let i = 0; i < count; i++) write(`docs/plans/a-${String(i).padStart(5, '0')}${suffix}`);
}

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-selection-'))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('selected document discovery', () => {
  it.each([4_999, 5_000])('finds an exact selection after %i unrelated Markdown files', async (count) => {
    unrelated(count);
    const file = write(selected);
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([{ path: file, readiness: 'candidate' }]);
  });

  it('finds an exact selection after 5,000 ignored Markdown files', async () => {
    unrelated(5_000, '_plan.md');
    write('.planqueueignore', 'docs/plans/a-*\n');
    const file = write(selected);
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([{ path: file, readiness: 'candidate' }]);
  });

  it.each(['.md', '_plan.md'])('does not spend a wildcard candidate limit on irrelevant or ignored %s files', async (suffix) => {
    unrelated(5_000, suffix);
    if (suffix === '_plan.md') write('.planqueueignore', 'docs/plans/a-*\n');
    const file = write(selected);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/*_plan.md')).toEqual([{ path: file, readiness: 'candidate' }]);
  });

  it('filters nonmatching plans before spending the wildcard candidate limit', async () => {
    unrelated(5_000, '_plan.md');
    const file = write(selected);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/z-*_plan.md')).toEqual([{ path: file, readiness: 'candidate' }]);
  });

  it('refuses incomplete wildcard results instead of returning a truncated list', async () => {
    unrelated(5_001, '_plan.md');
    await expect(discoverPlanQueueDocuments(root, 'plans')).rejects.toThrow(/incomplete.*5,000/i);
  });

  it.each([
    'docs/evidence-run/docs/plans/copy_plan.md',
    'docs/snapshot-run/copy_plan.md',
    'docs/observation-run/copy_plan.md',
    'docs/receipts-run/copy_plan.md',
    'docs/plans/nested/plans/copy_plan.md',
    'node_modules/pkg/copy_plan.md',
    '.worktrees/item/docs/plans/copy_plan.md',
  ])('excludes %s for exact and wildcard selections', async (relative) => {
    write(relative);
    expect(await discoverPlanQueueDocuments(root, 'plans', relative)).toEqual([]);
    expect(await discoverPlanQueueDocuments(root, 'plans', '**/*_plan.md')).toEqual([]);
  });

  it('honours ignore negation and ignores selected files too', async () => {
    write('.planqueueignore', 'docs/plans/*_plan.md\n!docs/plans/z-target_plan.md\n');
    write('docs/plans/hidden_plan.md');
    const file = write(selected);
    expect(await discoverPlanQueueDocuments(root, 'plans', '**/*_plan.md')).toEqual([{ path: file, readiness: 'candidate' }]);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/hidden_plan.md')).toEqual([]);
  });

  it('does not follow a selected file or directory symlink', async () => {
    const file = write('real/source_plan.md');
    mkdirSync(join(root, 'docs'));
    symlinkSync(file, join(root, 'docs/link_plan.md'));
    symlinkSync(join(root, 'real'), join(root, 'docs/plans'));
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/link_plan.md')).toEqual([]);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/source_plan.md')).toEqual([]);
  });

  it('does not allow an exact selection to escape the repository', async () => {
    expect(await discoverPlanQueueDocuments(root, 'plans', '../outside_plan.md')).toEqual([]);
  });

  it('keeps lifecycle, standing-register and missing-spec checks on exact selections', async () => {
    write(selected, '**Spec:** [spec](missing_spec.md)\n');
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([
      { path: join(root, selected), readiness: 'not-ready', reason: expect.stringContaining('does not exist') },
    ]);
    write(selected, 'Type: standing register\n');
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([]);
    write('docs/plans/closed_plan_completed.md');
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/closed_plan_completed.md')).toEqual([]);
    write('docs/plans/pending_livetest.md');
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/pending_livetest.md')).toEqual([]);
  });

  it.each(['bad%zz_spec.md', '../../../outside_spec.md'])('reports an invalid local spec link as not ready: %s', async (target) => {
    write(selected, `**Spec:** [spec](${target})\n`);
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([
      { path: join(root, selected), readiness: 'not-ready', reason: expect.any(String) },
    ]);
  });
});
