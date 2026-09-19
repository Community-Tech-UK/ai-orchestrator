import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFilename, discoverPlanQueueDocuments, globToRegExp } from './plan-queue-discovery';

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
  write('docs/plans/2026-09-01-register-shaped_livetest.md', '# R\n**Type:** standing register\n');
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

  it('does not treat a spec as unplanned when its plan exists', async () => {
    write('docs/plans/2026-09-05-loop-child-transcript-prune_plan.md');
    const docs = await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/2026-09-05-*');
    expect(rel(docs)).toEqual(['docs/plans/2026-09-05-loop-child-transcript-prune_plan.md']);
  });
});
