import type { AutomationTemplate } from '../../shared/types/task-preflight.types';

const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'daily-repo-health',
    name: 'Daily Repo Health',
    description: 'Check the current branch, dependency state, lint status, and obvious failing tests.',
    prompt: [
      'Review this repository for daily health signals.',
      'Check git status, dependency health, lint or typecheck status where lightweight, and recent obvious blockers.',
      'Do not make broad changes unless a narrow fix is clearly safe.',
      'Return a concise summary of checks run, findings, changes made, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'UTC',
    },
    tags: ['repo', 'health', 'daily'],
  },
  {
    id: 'dependency-audit',
    name: 'Dependency Audit',
    description: 'Inspect dependency drift and security-relevant package warnings without upgrading automatically.',
    prompt: [
      'Inspect dependency health for this project.',
      'Check package manager metadata and identify outdated or vulnerable dependencies without applying upgrades automatically.',
      'If a safe patch-level update is obvious, describe it but wait for explicit approval before changing dependency files.',
      'Return a concise summary of commands run, dependency risks, recommended next actions, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 10 * * 1',
      timezone: 'UTC',
    },
    tags: ['dependencies', 'security', 'weekly'],
  },
  {
    id: 'open-pr-review-sweep',
    name: 'Open PR Review Sweep',
    description: 'Look for open pull requests that need review attention or follow-up.',
    prompt: [
      'Review open pull request activity for this repository using the available local and GitHub tooling.',
      'Identify PRs that appear stale, blocked, failing checks, or ready for review.',
      'Do not approve, merge, or push changes.',
      'Return a concise summary of PRs checked, review priorities, suggested follow-ups, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 14 * * 1-5',
      timezone: 'UTC',
    },
    tags: ['github', 'pull-requests', 'review'],
  },
  {
    id: 'weekly-project-summary',
    name: 'Weekly Project Summary',
    description: 'Summarize repository activity, unresolved blockers, and suggested priorities.',
    prompt: [
      'Create a weekly project summary for this repository.',
      'Review recent local git activity, open work indicators, failing checks where available, and notable TODO or blocker markers.',
      'Do not modify files.',
      'Return a concise summary of progress, risks, unresolved blockers, and suggested priorities for next week.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 16 * * 5',
      timezone: 'UTC',
    },
    tags: ['summary', 'weekly', 'planning'],
  },
  {
    id: 'log-triage',
    name: 'Log Triage',
    description: 'Inspect recent local logs for repeated errors and actionable failures.',
    prompt: [
      'Triage recent logs for this project.',
      'Look for repeated errors, failed jobs, crash traces, or noisy warnings in known local log locations.',
      'Do not delete logs or change configuration unless explicitly requested.',
      'Return a concise summary of logs inspected, recurring issues, suspected owners or components, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 8 * * 1-5',
      timezone: 'UTC',
    },
    tags: ['logs', 'triage', 'operations'],
  },
];

export function listAutomationTemplates(): AutomationTemplate[] {
  return TEMPLATES.map((template) => ({
    ...template,
    suggestedSchedule: { ...template.suggestedSchedule },
    tags: [...template.tags],
  }));
}
