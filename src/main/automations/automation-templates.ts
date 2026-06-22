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
  {
    id: 'test-stabilizer',
    name: 'Test Stabilizer',
    description: 'Find flaky tests, fix their root cause, and prove stability with repeated runs.',
    prompt: [
      'OBJECTIVE: identify one flaky test and eliminate its root cause this run.',
      'CHECKS: re-run the affected test file multiple times; it must pass on every run before you consider it fixed.',
      'STOP: done when the flaky test has a root-cause fix and repeat-run evidence; stalled when no reproducible flaky test or root cause is found; needs-permission when the fix requires destructive changes, external credentials, or approval.',
      'GUARDRAILS: Do not delete tests, weaken assertions, add blanket retry wrappers, or hide instability behind longer timeouts.',
      'Investigate the underlying cause (timing, shared state, ordering, mocks) rather than masking it with retries or longer timeouts.',
      'Return a concise summary of the flaky test found, the root cause, the fix, the repeat-run evidence, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 7 * * 1-5',
      timezone: 'UTC',
    },
    tags: ['tests', 'flaky', 'stability'],
  },
  {
    id: 'contract-alias-sync-audit',
    name: 'Contract Alias Sync Audit',
    description: 'Verify @contracts subpaths stay in sync across the three alias sites that the packaged DMG depends on.',
    prompt: [
      'OBJECTIVE: confirm every @contracts/schemas/* and @contracts/types/* subpath resolves at runtime, not just at typecheck.',
      'CHECKS: for each subpath alias, verify it is declared in all of tsconfig.json, tsconfig.electron.json, and the exactAliases map in src/main/register-aliases.ts (and vitest.config.ts if imported from tests). Report any subpath missing from one or more sites.',
      'STOP: done when all contract subpaths are checked and any drift is reported; stalled when aliases cannot be enumerated from the repo; needs-permission when verifying a path requires unavailable packaging credentials or external access.',
      'GUARDRAILS: Do not edit alias files automatically; only report drift and the exact missing entries.',
      'This guards a packaging trap that has silently broken the DMG: tsc path aliases are type-check-only and do not rewrite emitted JS.',
      'Return a concise summary of subpaths checked, any out-of-sync sites, the exact entries needed, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 11 * * 1',
      timezone: 'UTC',
    },
    tags: ['contracts', 'packaging', 'propagation'],
  },
  {
    id: 'fresh-clone-onboarding',
    name: 'Fresh-Clone Onboarding Check',
    description: 'Act as a first-time user following the README, surface the first hidden setup assumption.',
    prompt: [
      'OBJECTIVE: find the first place a brand-new contributor would get stuck following the README/setup docs from scratch.',
      'CHECKS: read the documented setup steps in order and verify each is actually runnable and correct against the current repo (scripts exist, commands match package.json, native/ABI steps are documented).',
      'STOP: done when the first blocking setup assumption is identified or all setup steps are verified; stalled when setup docs are absent or contradictory; needs-permission when verification requires credentials, external accounts, or destructive machine changes.',
      'GUARDRAILS: Do not change source code or configuration; documentation-gap reporting only.',
      'Assume no prior knowledge and no pre-existing local state; flag any step that relies on undocumented context.',
      'Return a concise summary of the steps walked, the first blocking assumption found, a suggested doc fix, and any other gaps.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 12 * * 3',
      timezone: 'UTC',
    },
    tags: ['onboarding', 'docs', 'developer-experience'],
  },
  {
    id: 'docs-sweep',
    name: 'Docs Sweep',
    description: 'Keep documentation aligned with the current codebase; flag drift between docs and reality.',
    prompt: [
      'OBJECTIVE: find one concrete place where documentation no longer matches the code and propose the correction.',
      'CHECKS: cross-check claims in docs/ and the root markdown files against the actual code (commands, file paths, type names, architecture statements). A claim counts as drift only when the code contradicts it.',
      'STOP: done when one verified documentation drift and its minimal correction are reported; stalled when no code-backed drift is found; needs-permission when checking the claim requires unavailable credentials or external systems.',
      'GUARDRAILS: Do not rewrite docs wholesale or change code; identify the specific drift and the minimal correction.',
      'Prioritise load-bearing docs (architecture, setup, packaging gotchas) over cosmetic wording.',
      'Return a concise summary of docs checked, the drift found, the suggested fix, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 13 * * 4',
      timezone: 'UTC',
    },
    tags: ['docs', 'maintenance', 'sweep'],
  },
  {
    id: 'production-error-sweep',
    name: 'Production Error Sweep',
    description: 'Find the highest-signal recurring error in local logs, trace it, and propose a verified fix.',
    prompt: [
      'OBJECTIVE: pick the single most actionable recurring error from recent logs and trace it to a root cause.',
      'CHECKS: confirm the error is real and recurring (multiple occurrences, a clear trace), and identify the originating code path before proposing a fix.',
      'STOP: done when one recurring error is traced to a root cause with a narrow proposed or applied fix; stalled when recent logs contain no actionable recurring error; needs-permission when the fix requires credentials, production access, or approval.',
      'GUARDRAILS: Do not apply broad changes or delete logs; propose a narrow fix and only apply it if it is clearly safe and verifiable.',
      'Distinguish actionable errors from expected noise; ignore one-off or already-handled cases.',
      'Return a concise summary of errors triaged, the chosen error and its root cause, the proposed/applied fix, verification, and any blockers.',
    ].join('\n'),
    suggestedSchedule: {
      type: 'cron',
      expression: '0 15 * * 1-5',
      timezone: 'UTC',
    },
    tags: ['errors', 'operations', 'triage'],
  },
];

export function listAutomationTemplates(): AutomationTemplate[] {
  return TEMPLATES.map((template) => ({
    ...template,
    suggestedSchedule: { ...template.suggestedSchedule },
    tags: [...template.tags],
  }));
}
