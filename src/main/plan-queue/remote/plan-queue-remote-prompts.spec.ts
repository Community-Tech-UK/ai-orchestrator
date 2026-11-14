import { describe, expect, it } from 'vitest';
import { buildActiveDocumentsPrompt, buildContinuePrompt, buildFixPrompt, buildResumePrompt, buildWorkerPrompt, farPlanningPath, forRemoteJob } from '../plan-queue-prompts';
import { deferredPassProblems } from '../plan-queue-deferred-checks';
import { newPlanQueueItem } from '../plan-queue-state';
import type { RemoteJobPrompt } from '../plan-queue-report-prompts';

const remote: RemoteJobPrompt = {
  computerLabel: 'the Windows PC', repoRoot: '/Users/me/work/repo', jobFolder: 'C:\\Users\\pc\\.orchestrator\\queue-worktrees\\queue\\job',
  planningFolder: 'C:\\Users\\pc\\.orchestrator\\queue-docs\\item-1', reportFile: 'C:\\Users\\pc\\.orchestrator\\queue-reports\\item-1\\turn-7.json',
};
const item = newPlanQueueItem('item-1', 'run', '/Users/me/work/repo/docs/plans/p_plan.md', 1, { branchName: 'queue/p-abc123', worktreePath: '/Users/me/work/repo/.worktrees/queue/p' });
const ctx = (extra: object = {}) => ({ item, kind: 'plans' as const, repoRoot: '/Users/me/work/repo', worktreePath: item.worktreePath!, ...extra });

describe('the worker prompt for a job on another computer', () => {
  const prompt = buildWorkerPrompt(ctx({ remote }));

  it('names the planning folder, the job folder and the report file there, not this Mac\'s paths', () => {
    expect(prompt).toContain('This job runs on the Windows PC');
    expect(prompt).toContain('C:\\Users\\pc\\.orchestrator\\queue-docs\\item-1\\docs\\plans\\p_plan.md');
    expect(prompt).toContain(`Make every code change in your job folder \`${remote.jobFolder}\``);
    expect(prompt).toContain(remote.reportFile);
    expect(prompt).toContain('/Users/me/work/repo/...');
    expect(prompt).not.toContain('ROOT checkout');
    expect(prompt).not.toContain('/Users/me/work/repo/.worktrees/queue/p');
  });

  it('asks for the report as a file with the tool\'s fields, and says the turn ending hands the work over', () => {
    expect(prompt).toContain('write your report as one JSON file');
    for (const field of ['item_id', 'summary', 'as_built', 'checks_run', 'deferred_checks', 'follow_ups']) expect(prompt).toContain(`\`${field}\``);
    expect(prompt).toContain('handed over when your turn ends');
    expect(prompt).not.toContain('Confirm the tool answered accepted: true');
    expect(prompt).not.toContain('handed over when you report, not when your turn ends');
  });

  it('puts the history file in the planning folder', () => {
    expect(prompt).toContain('C:\\Users\\pc\\.orchestrator\\queue-docs\\item-1\\docs\\plans\\p_history.md');
  });

  it('is the ordinary prompt, unchanged, for a job that runs here', () => {
    const here = buildWorkerPrompt(ctx());
    expect(here).toContain('ROOT checkout');
    expect(here).toContain('Confirm the tool answered accepted: true');
    expect(here).not.toContain('This job runs on');
  });

  it('carries into a resume prompt, which embeds the worker prompt', () => {
    expect(buildResumePrompt(ctx({ remote }), 'the app restarted')).toContain(remote.reportFile);
  });
});

describe('the other prompts for a job on another computer', () => {
  it('say the file instead of the tool, and the turn ending hands the work over', () => {
    const fix = forRemoteJob(buildFixPrompt(1, 3, []));
    expect(fix).toContain('write your report file again');
    expect(fix).not.toContain('plan_queue_report_ready');
    expect(fix).toContain('handed over when your turn ends');
    expect(forRemoteJob(buildContinuePrompt(ctx({ remote }), 'a reopen'))).toContain('Continue where you left off');
  });

  it('send planning edits to the planning folder, not this Mac\'s root checkout', () => {
    const prompt = forRemoteJob(buildActiveDocumentsPrompt(['docs/plans/x_plan.md']));
    expect(prompt).not.toContain('root checkout');
    expect(prompt).toContain('your planning folder');
  });

  it('are left alone when the job runs here', () => {
    const fix = buildFixPrompt(1, 3, []);
    expect(fix).toContain('plan_queue_report_ready');
  });

  it('shows a path under this Mac\'s checkout at its place under the planning folder, either kind of separator', () => {
    expect(farPlanningPath('/Users/me/work/repo/docs/specs/s_spec.md', remote)).toBe('C:\\Users\\pc\\.orchestrator\\queue-docs\\item-1\\docs\\specs\\s_spec.md');
    expect(farPlanningPath('/Users/me/work/repo/docs/a.md', { repoRoot: '/Users/me/work/repo', planningFolder: '/home/x/queue-docs/1' })).toBe('/home/x/queue-docs/1/docs/a.md');
    expect(farPlanningPath('/elsewhere/a.md', remote)).toBe('/elsewhere/a.md');
  });
});

describe('the deferred-check finding for a job on another computer', () => {
  const verdict = { verdict: 'PASS' as const, findings: [], deferredChecks: [{ title: 'Live check' }], criteriaTotal: 1 };
  it('names the report file, not the tool', async () => {
    const [file] = await deferredPassProblems(verdict as never, null, '/nowhere/p_plan.md', true);
    expect(file!.evidence).toContain('your report file');
    expect(file!.evidence).not.toContain('plan_queue_report_ready');
    const [tool] = await deferredPassProblems(verdict as never, null, '/nowhere/p_plan.md');
    expect(tool!.evidence).toContain('plan_queue_report_ready');
  });
});
