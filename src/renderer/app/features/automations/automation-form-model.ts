import type {
  AutomationAction,
  AutomationConcurrencyPolicy,
  AutomationMissedRunPolicy,
  AutomationWebhookFilter,
} from '../../../../shared/types/automation.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';

export interface AutomationFormModel {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  scheduleType: 'cron' | 'oneTime';
  cronExpression: string;
  timezone: string;
  runAtLocal: string;
  missedRunPolicy: AutomationMissedRunPolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  /** WS5: what starts this automation — the schedule, or a webhook route. */
  triggerKind: 'schedule' | 'webhook';
  webhookRouteId: string;
  webhookFilters: AutomationWebhookFilter[];
  prompt: string;
  workingDirectory: string;
  provider: AutomationAction['provider'];
  model: string;
  agentId: string;
  yoloMode: boolean;
  reasoningEffort: AutomationAction['reasoningEffort'] | '';
  forceNodeId: string;
  attachments: FileAttachment[];
  /** WS5: run the prompt as an autonomous loop instead of a one-shot turn. */
  loopEnabled: boolean;
  loopVerifyCommand: string;
  loopIsolateWorkspace: boolean;
  loopMaxIterations: string;
  loopMaxCostCents: string;
}

export function emptyForm(): AutomationFormModel {
  return {
    name: '',
    description: '',
    enabled: true,
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    runAtLocal: toLocalDateInput(Date.now() + 60 * 60 * 1000),
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    triggerKind: 'schedule',
    webhookRouteId: '',
    webhookFilters: [],
    prompt: '',
    workingDirectory: '',
    provider: 'auto',
    model: '',
    agentId: 'build',
    yoloMode: false,
    reasoningEffort: '',
    forceNodeId: '',
    attachments: [],
    loopEnabled: false,
    loopVerifyCommand: '',
    loopIsolateWorkspace: true,
    loopMaxIterations: '',
    loopMaxCostCents: '',
  };
}

/** Build the persisted trigger from the form (WS5). */
export function formToTrigger(model: AutomationFormModel):
  | { kind: 'schedule' }
  | { kind: 'webhook'; routeId: string; filters: AutomationWebhookFilter[] } {
  if (model.triggerKind === 'webhook' && model.webhookRouteId.trim()) {
    return {
      kind: 'webhook',
      routeId: model.webhookRouteId.trim(),
      filters: model.webhookFilters
        .map((filter) => ({
          path: filter.path.trim(),
          operator: filter.operator,
          value: filter.value,
        }))
        .filter((filter) => filter.path.length > 0),
    };
  }
  return { kind: 'schedule' };
}

/** Build the persisted loop action from the form, or undefined (WS5). */
export function formToLoopAction(model: AutomationFormModel): AutomationAction['loop'] {
  if (!model.loopEnabled || !model.loopVerifyCommand.trim()) {
    return undefined;
  }
  const maxIterations = Number.parseInt(model.loopMaxIterations, 10);
  const maxCostCents = Number.parseInt(model.loopMaxCostCents, 10);
  return {
    verifyCommand: model.loopVerifyCommand.trim(),
    isolateWorkspace: model.loopIsolateWorkspace,
    ...(Number.isFinite(maxIterations) && maxIterations > 0 ? { maxIterations } : {}),
    ...(Number.isFinite(maxCostCents) && maxCostCents > 0 ? { maxCostCents } : {}),
  };
}

export function toLocalDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromLocalDateInput(value: string): number {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}
