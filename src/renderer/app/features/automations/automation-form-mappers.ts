/**
 * Pure form/label mappers for the automations page.
 *
 * Extracted from `automations-page.component.ts` so the page stays inside its
 * LOC ceiling. Behaviour matches the previous methods.
 */

import type {
  Automation,
  AutomationSchedule,
} from '../../../../shared/types/automation.types';
import type { AutomationDraft } from '../../core/state/automation.store';
import { describeSchedule } from './schedule-format';
import {
  emptyForm,
  fromLocalDateInput,
  newAutomationFormModelSelection,
  toLocalDateInput,
  type AutomationFormModel,
} from './automation-form-model';

export function draftScheduleLabel(draft: AutomationDraft): string {
  if (draft.scheduleType === 'oneTime' && draft.runAtIso) {
    const ts = Date.parse(draft.runAtIso);
    if (!Number.isNaN(ts)) {
      return describeSchedule({ type: 'oneTime', runAt: ts, timezone: draft.timezone });
    }
    return 'Once';
  }
  if (draft.cronExpression) {
    return describeSchedule({ type: 'cron', expression: draft.cronExpression, timezone: draft.timezone || 'UTC' });
  }
  return 'Schedule';
}

export function automationByline(automation: Automation): string {
  if (automation.description?.trim()) {
    return automation.description.trim();
  }
  const wd = automation.action.workingDirectory;
  if (wd) {
    return wd.split('/').filter(Boolean).pop() ?? wd;
  }
  return '';
}

export function projectTitle(workingDirectory: string): string {
  const normalized = workingDirectory.trim();
  if (!normalized) {
    return 'No workspace';
  }
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function projectSubtitle(workingDirectory: string): string {
  const normalized = workingDirectory.trim();
  if (!normalized) {
    return 'Automations without a working directory';
  }
  return normalized
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

export function draftToForm(draft: AutomationDraft, workingDirectory: string): AutomationFormModel {
  const base = emptyForm();
  const oneTimeTs = draft.runAtIso ? Date.parse(draft.runAtIso) : NaN;
  return {
    ...base,
    name: draft.name,
    description: draft.description ?? '',
    workingDirectory: workingDirectory.trim(),
    scheduleType: draft.scheduleType,
    cronExpression: draft.scheduleType === 'cron' && draft.cronExpression ? draft.cronExpression : base.cronExpression,
    timezone: draft.timezone || base.timezone,
    runAtLocal: draft.scheduleType === 'oneTime' && !Number.isNaN(oneTimeTs)
      ? toLocalDateInput(oneTimeTs)
      : base.runAtLocal,
    prompt: draft.prompt,
    ...newAutomationFormModelSelection(draft.provider),
  };
}

export function automationToForm(automation: Automation): AutomationFormModel {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description ?? '',
    enabled: automation.enabled,
    scheduleType: automation.schedule.type,
    cronExpression: automation.schedule.type === 'cron' ? automation.schedule.expression : '0 9 * * *',
    timezone: automation.schedule.type === 'cron'
      ? automation.schedule.timezone
      : automation.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    runAtLocal: automation.schedule.type === 'oneTime' ? toLocalDateInput(automation.schedule.runAt) : toLocalDateInput(Date.now() + 60 * 60 * 1000),
    missedRunPolicy: automation.missedRunPolicy,
    concurrencyPolicy: automation.concurrencyPolicy,
    hidden: automation.hidden ?? false,
    prompt: automation.action.prompt,
    workingDirectory: automation.action.workingDirectory,
    provider: automation.action.provider ?? 'auto',
    model: automation.action.model ?? '',
    agentId: automation.action.agentId ?? 'build',
    yoloMode: automation.action.yoloMode ?? false,
    reasoningEffort: automation.action.reasoningEffort ?? '',
    forceNodeId: automation.action.forceNodeId ?? '',
    attachments: automation.action.attachments ?? [],
    triggerKind: automation.trigger?.kind === 'webhook' ? 'webhook' : 'schedule',
    webhookRouteId: automation.trigger?.kind === 'webhook' ? automation.trigger.routeId : '',
    webhookFilters: automation.trigger?.kind === 'webhook' ? [...automation.trigger.filters] : [],
    loopEnabled: Boolean(automation.action.loop),
    loopVerifyCommand: automation.action.loop?.verifyCommand ?? '',
    loopIsolateWorkspace: automation.action.loop?.isolateWorkspace ?? true,
    loopMaxIterations: automation.action.loop?.maxIterations != null ? String(automation.action.loop.maxIterations) : '',
    loopMaxCostCents: automation.action.loop?.maxCostCents != null ? String(automation.action.loop.maxCostCents) : '',
    executionProfile: automation.action.executionProfile ?? 'standard',
  };
}

export function formToSchedule(model: AutomationFormModel): AutomationSchedule {
  if (model.scheduleType === 'oneTime') {
    return {
      type: 'oneTime',
      runAt: fromLocalDateInput(model.runAtLocal),
      timezone: model.timezone || undefined,
    };
  }

  return {
    type: 'cron',
    expression: model.cronExpression,
    timezone: model.timezone || 'UTC',
  };
}
