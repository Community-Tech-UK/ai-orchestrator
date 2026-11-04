import type { AutomationAction, AutomationSchedule } from '../../shared/types/automation.types';

export interface AutomationActionPolicy {
  maxRunMinutes?: number;
  maxProcessedTokens?: number;
  slowWhenUnchanged?: boolean;
}
export type BoundedAutomationAction = AutomationAction & AutomationActionPolicy;

export function withRunLimits(action: BoundedAutomationAction, schedule: AutomationSchedule): BoundedAutomationAction {
  return { ...action, maxRunMinutes: action.maxRunMinutes ?? 90,
    maxProcessedTokens: action.maxProcessedTokens ?? (schedule.type === 'oneTime' ? 100_000_000 : 30_000_000) };
}
