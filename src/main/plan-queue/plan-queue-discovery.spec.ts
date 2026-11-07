import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFilename, discoverPlanQueueDocuments, globToRegExp, previewPlanQueueDocuments } from './plan-queue-discovery';

let root: string;

/** Filename shapes copied from docs/plans and docs/superpowers/plans (names only). */
function write(relative: string, content = '# Doc\n'): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-discovery-')));
  write('docs/plans/2026-08-23-workspace-secret-card_plan.md', '# Plan\n\n**Spec:** [spec](./2026-08-23-workspace-secret-card_spec_planned.md)\n');
  write('docs/plans/2026-08-23-workspace-secret-card_spec_planned.md');
  write('docs/plans/2026-08-23-workspace-secret-card_livetest.md');
  write('docs/plans/2026-08-28-settings-ux-remediation_plan.md', '**Spec:** No separate specification was requested.\n');
  write('docs/plans/2026-09-03-acp-loop-liveness-accounting_plan.md', '**Spec:** [x](./2026-09-03-acp-loop-liveness-accounting_spec_planned.md)\n');
  write('docs/plans/2026-09-05-loop-child-transcript-prune_spec.md');
  write('docs/plans/2026-09-03-enhancements-backlog_plan_completed.md');
  write('docs/plans/2026-08-29-browser-credential-cli_prompt.md');
  write('docs/plans/livetest-remediation-register.md', '# Register\n\n**Type: standing register — deliberately tracked.**\n');
  write('docs/plans/2026-09-01-register-shaped_livetest.md', '# R\nType: standing register\n');
  write('docs/superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest.md');
  write('docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md');
  write('docs/superpowers/plans/2026-03-20-cross-model-review-design_completed.md');
  write('docs/superpowers/plans/archive/2026-01-01-old_plan.md');
  write('node_modules/pkg/docs/x_plan.md');
  write('.worktrees/queue/x-1/docs/plans/y_plan.md');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const rel = (docs: { path: string }[]) => docs.map((d) => d.path.slice(root.length + 1));

describe('classifyFilename', () => {
  it('reads the lifecycle state from the suffix', () => {
    expect(classifyFilename('a_plan.md')).toBe('plan');
    expect(classifyFilename('a_plan_livetest.md')).toBe('livetest');
    expect(classifyFilename('a_livetest.md')).toBe('livetest');
    expect(classifyFilename('a_spec.md')).toBe('spec-unplanned');
    expect(classifyFilename('a_spec_planned.md')).toBe('other');
    expect(classifyFilename('a_plan_completed.md')).toBe('other');
    expect(classifyFilename('a_livetest_completed.md')).toBe('other');
    expect(classifyFilename('a_prompt.md')).toBe('other');
  });

  it('is case-sensitive like the shared active-document pattern: an upper-case suffix is not an active document', () => {
    expect(classifyFilename('a_PLAN.md')).toBe('other');
    expect(classifyFilename('a_Livetest.md')).toBe('other');
    expect(classifyFilename('a_SPEC.md')).toBe('other');
    expect(classifyFilename('a_plan.MD')).toBe('other');
  });
});

describe('globToRegExp', () => {
  it('supports *, ** and ?', () => {
    expect(globToRegExp('docs/**/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/**/*.md').test('docs/plans/x/a.md')).toBe(true);
    expect(globToRegExp('docs/plans/2026-09-*').test('docs/plans/2026-09-03-a_plan.md')).toBe(true);
    expect(globToRegExp('docs/plans/2026-09-*').test('docs/plans/sub/2026-09-03-a_plan.md')).toBe(false);
    expect(globToRegExp('docs/plans/a?.md').test('docs/plans/ab.md')).toBe(true);
    expect(globToRegExp('docs/plans/a.md').test('docs/plans/aXmd')).toBe(false);
  });
});

describe('discoverPlanQueueDocuments', () => {
  it('skips a folder that is its own repository, whose plans belong to another project', async () => {
    write('vendor/other-project/.git/HEAD', 'ref: refs/heads/main\n');
    write('vendor/other-project/docs/plans/2026-10-01-elsewhere_plan.md');
    const docs = await discoverPlanQueueDocuments(root, 'plans');
    expect(docs.map(doc => doc.path).some(file => file.includes('elsewhere'))).toBe(false);
    expect(docs.length).toBeGreaterThan(0);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'vendor/other-project/docs/plans/*')).toEqual([]);
    expect(await discoverPlanQueueDocuments(root, 'plans', 'vendor/other-project/docs/plans/2026-10-01-elsewhere_plan.md')).toEqual([]);
  });

  it('previews real documents separately from matching copies without reading their content', async () => {
    write('docs/plans/evidence/snapshot/docs/plans/copied_plan.md');
    write('docs/plans/nested/plans/also-copied_plan.md');
    write('docs/plans/observations/unrelated.txt');
    expect(await previewPlanQueueDocuments(root, 'plans')).toEqual({ found: 4, hiddenCopies: 2, hiddenCountComplete: true });
    expect(await previewPlanQueueDocuments(root, 'plans', 'docs/plans/2026-08-28-settings-ux-remediation_plan.md'))
      .toEqual({ found: 1, hiddenCopies: null, hiddenCountComplete: true });
  });
  it('lists plans, reports a missing linked spec and an unplanned spec as not ready', async () => {
    const docs = await discoverPlanQueueDocuments(root, 'plans');
    expect(rel(docs)).toEqual([
      'docs/plans/2026-08-23-workspace-secret-card_plan.md',
      'docs/plans/2026-08-28-settings-ux-remediation_plan.md',
      'docs/plans/2026-09-03-acp-loop-liveness-accounting_plan.md',
      'docs/plans/2026-09-05-loop-child-transcript-prune_spec.md',
    ]);
    expect(docs.map((d) => d.readiness)).toEqual(['candidate', 'candidate', 'not-ready', 'not-ready']);
    expect(docs[2].reason).toContain('2026-09-03-acp-loop-liveness-accounting_spec_planned.md');
    expect(docs[3].reason).toContain('no implementation plan');
  });

  it('lists livetests in both plan directories and skips standing registers, archives and other checkouts', async () => {
    const docs = await discoverPlanQueueDocuments(root, 'livetests');
    expect(rel(docs)).toEqual([
      'docs/plans/2026-08-23-workspace-secret-card_livetest.md',
      'docs/superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest.md',
      'docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md',
    ]);
    expect(docs.every((d) => d.readiness === 'candidate')).toBe(true);
  });

  it('narrows by a repo-relative glob', async () => {
    const docs = await discoverPlanQueueDocuments(root, 'livetests', 'docs/superpowers/**/*local-ai*');
    expect(rel(docs)).toEqual(['docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md']);
  });

  it('skips a programme document marked "Queue: not an item" in its first 8 lines only', async () => {
    write('docs/plans/2026-11-03-programme_plan.md', '# Programme\n\nQueue: not an item\n\n**Status:** Draft\n');
    write('docs/plans/2026-11-03-late-mention_plan.md', `${'line\n'.repeat(8)}Queue: not an item\n`);
    const docs = await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/2026-11-03-*');
    expect(rel(docs)).toEqual(['docs/plans/2026-11-03-late-mention_plan.md']);
  });

  it('reads the standing-register marker and the spec link from the first 8 lines only, and ignores an upper-case _PLAN.md', async () => {
    write('docs/plans/2026-11-05-late-register_plan.md', `${'line\n'.repeat(8)}Type: standing register\n`);
    write('docs/plans/2026-11-05-early-register_plan.md', '# R\nType: standing register\n');
    write('docs/plans/2026-11-05-late-spec-link_plan.md', `${'line\n'.repeat(8)}**Spec:** [spec](./missing_spec.md)\n`);
    write('docs/plans/2026-11-05-shouting_PLAN.md');
    const docs = await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/2026-11-05-*');
    expect(rel(docs)).toEqual([
      'docs/plans/2026-11-05-late-register_plan.md',
      'docs/plans/2026-11-05-late-spec-link_plan.md',
    ]);
    expect(docs.every(d => d.readiness === 'candidate')).toBe(true);
  });

  it('does not treat a spec as unplanned when its plan exists', async () => {
    write('docs/plans/2026-09-05-loop-child-transcript-prune_plan.md');
    const docs = await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/2026-09-05-*');
    expect(rel(docs)).toEqual(['docs/plans/2026-09-05-loop-child-transcript-prune_plan.md']);
  });
});
