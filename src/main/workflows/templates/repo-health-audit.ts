import { WorkflowTemplate } from '../../../shared/types/workflow.types';

export const repoHealthAuditTemplate: WorkflowTemplate = {
  id: 'repo-health-audit',
  name: 'Repo Health Audit',
  description: 'Repository-wide audit focused on quality checks, risky diffs, and actionable findings',
  icon: 'pulse',
  category: 'review',
  triggerPatterns: [
    'repo health audit',
    'repository audit',
    'audit repo',
    'health check',
  ],
  autoTrigger: false,
  estimatedDuration: '15-45 minutes',
  requiredAgents: ['code-reviewer', 'test-coverage-analyzer'],

  phases: [
    {
      id: 'baseline',
      name: 'Baseline',
      description: 'Capture repository status and current risk areas',
      order: 0,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: BASELINE

Build a current snapshot of repository health:

1. Current branch and working tree status.
2. High-risk files or directories.
3. Obvious signs of drift, debt, or broken state.
`,
    },
    {
      id: 'checks',
      name: 'Checks',
      description: 'Run available quality gates',
      order: 1,
      gateType: 'completion',
      requiredActions: ['checks_run'],
      systemPromptAddition: `
## Current Phase: CHECKS

Run the most relevant repository checks available:

1. TypeScript compile checks where applicable.
2. Lint.
3. Tests.

Mark 'checks_run' when complete and note any skipped checks.
`,
    },
    {
      id: 'review',
      name: 'Review',
      description: 'Inspect failures, risky areas, and missing safeguards',
      order: 2,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: REVIEW

Inspect the repository for concrete problems:

1. Bugs or regressions.
2. Missing tests or weak assertions.
3. Build, lint, or type drift.
4. Risky diffs or operational hazards.

Present findings first, ordered by severity.
`,
    },
    {
      id: 'summary',
      name: 'Summary',
      description: 'Summarize repo health and recommended follow-ups',
      order: 3,
      gateType: 'none',
      systemPromptAddition: `
## Current Phase: SUMMARY

Summarize repository health:

1. Overall status.
2. Concrete findings and blockers.
3. Recommended next actions.
4. Verification gaps.
`,
    },
  ],
};
