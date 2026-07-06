import type {
  AutomationAction,
  AutomationConcurrencyPolicy,
  AutomationMissedRunPolicy,
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
  prompt: string;
  workingDirectory: string;
  provider: AutomationAction['provider'];
  model: string;
  agentId: string;
  yoloMode: boolean;
  reasoningEffort: AutomationAction['reasoningEffort'] | '';
  forceNodeId: string;
  attachments: FileAttachment[];
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
    prompt: '',
    workingDirectory: '',
    provider: 'auto',
    model: '',
    agentId: 'build',
    yoloMode: false,
    reasoningEffort: '',
    forceNodeId: '',
    attachments: [],
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
