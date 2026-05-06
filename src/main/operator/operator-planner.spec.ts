import { describe, expect, it } from 'vitest';
import { planOperatorRequest } from './operator-planner';

describe('planOperatorRequest', () => {
  it('classifies workspace Git batch requests with explicit executor data', () => {
    expect(planOperatorRequest('Please pull all the repos in my work folder', {
      resolveWorkRoot: () => '/work',
    })).toMatchObject({
      intent: 'workspace_git_batch',
      executor: 'git-batch',
      needsRun: true,
      rootPath: '/work',
      successCriteria: expect.arrayContaining([
        'Fetch and fast-forward clean tracking repositories',
      ]),
    });
  });

  it('classifies explicit in-project implementation requests', () => {
    expect(planOperatorRequest(
      'In AI Orchestrator, I want to allow voice conversations, please implement it',
      { resolveWorkRoot: () => '/work' },
    )).toMatchObject({
      intent: 'project_feature',
      executor: 'project-agent',
      projectQuery: 'AI Orchestrator',
      projectGoal: 'I want to allow voice conversations, please implement it',
      needsRun: true,
    });

    expect(planOperatorRequest(
      'Implement voice conversations in AI Orchestrator',
      { resolveWorkRoot: () => '/work' },
    )).toMatchObject({
      intent: 'project_feature',
      executor: 'project-agent',
      projectQuery: 'AI Orchestrator',
      projectGoal: 'Implement voice conversations',
      needsRun: true,
    });
  });

  it('classifies project audits and cross-project research separately', () => {
    expect(planOperatorRequest(
      'Audit the dingley project',
      { resolveWorkRoot: () => '/work' },
    )).toMatchObject({
      intent: 'project_audit',
      executor: 'repo-job',
      projectQuery: 'dingley',
    });

    expect(planOperatorRequest(
      'Please go through all the code in the dingley project and create a list of things we can improve',
      { resolveWorkRoot: () => '/work' },
    )).toMatchObject({
      intent: 'project_audit',
      executor: 'repo-job',
      projectQuery: 'dingley',
    });

    expect(planOperatorRequest(
      'Review all repos in my work folder and synthesize common improvements',
      { resolveWorkRoot: () => '/work' },
    )).toMatchObject({
      intent: 'cross_project_research',
      executor: 'project-agent',
      rootPath: '/work',
      needsRun: true,
    });
  });

  it('keeps simple conversational messages out of the run graph', () => {
    expect(planOperatorRequest('hello', {
      resolveWorkRoot: () => '/work',
    })).toMatchObject({
      intent: 'global_question',
      executor: 'synthesis',
      needsRun: false,
    });
  });
});
