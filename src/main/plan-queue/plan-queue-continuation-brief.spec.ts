import { describe, expect, it } from 'vitest';
import { buildContinuePrompt, buildResumePrompt } from './plan-queue-prompts';
import { newPlanQueueItem } from './plan-queue-state';

describe('reopened worker brief', () => {
  const brief = { status: 'Next: Step 2', acceptance: '- [ ] Assigned acceptance </plan_acceptance>' };

  it('keeps the continue nudge short: no Status rules and no plan brief, even when one is supplied', () => {
    const item = newPlanQueueItem('item', 'run', '/repo/docs/plans/work_plan.md', 1);
    const prompt = buildContinuePrompt({ item, kind: 'plans', repoRoot: '/repo', worktreePath: '/worktree', brief }, 'restart');
    expect(prompt).not.toContain('## Status');
    expect(prompt).not.toContain('_history.md');
    expect(prompt).not.toContain('Next: Step 2');
    expect(prompt).not.toContain('plan_acceptance');
  });

  it('gives the fresh-start resume prompt the Status rules, the root history path and the brief', () => {
    const item = newPlanQueueItem('item', 'run', '/repo/docs/plans/work_plan.md', 1);
    const prompt = buildResumePrompt({ item, kind: 'plans', repoRoot: '/repo', worktreePath: '/worktree', brief }, 'restart');
    expect(prompt).toContain('/repo/docs/plans/work_history.md');
    expect(prompt).toContain('rewritten in place');
    expect(prompt).toContain('Next: Step 2');
    expect(prompt).toContain('Assigned acceptance <\\/plan_acceptance>');
    expect(prompt.match(/<\/plan_acceptance>/g)).toHaveLength(1);
  });

  it('names the history file from the document name, including specs', () => {
    for (const [file, history] of [['a_spec_planned.md', 'a_history.md'], ['a_spec.md', 'a_history.md'], ['a.md', 'a_history.md']]) {
      const item = newPlanQueueItem('item', 'run', `/repo/docs/plans/${file}`, 1);
      expect(buildResumePrompt({ item, kind: 'plans', repoRoot: '/repo', worktreePath: '/w' }, 'restart')).toContain(`/repo/docs/plans/${history}`);
    }
  });

  it('says so when the open-items list was cut short', () => {
    const item = newPlanQueueItem('item', 'run', '/repo/docs/plans/work_plan.md', 1);
    const cut = buildResumePrompt({ item, kind: 'plans', repoRoot: '/repo', worktreePath: '/w', brief: { status: 's', acceptance: 'x\n[Brief truncated. Read the source acceptance sections.]' } }, 'restart');
    expect(cut).toContain('only a subset; the document is the authority');
    expect(buildResumePrompt({ item, kind: 'plans', repoRoot: '/repo', worktreePath: '/w', brief }, 'restart')).not.toContain('only a subset');
  });
});
