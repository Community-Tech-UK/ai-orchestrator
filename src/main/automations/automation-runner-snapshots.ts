import type {
  Automation,
  AutomationRun,
  ClaimedAutomationRun,
} from '../../shared/types/automation.types';
import {
  AUTOMATION_FAILURE_STATUSES,
  AUTOMATION_WAIT_STATUSES,
} from '../../shared/types/instance-status-policy';
import { toWorkspaceId } from '../../shared/utils/workspace-key';

// Single source of truth, shared with the project rail so the "hidden automation
// failed, show it" escape hatch can never drift from what counts as a failure.
export const FAILURE_STATUSES = AUTOMATION_FAILURE_STATUSES;
export const WAIT_STATUSES = AUTOMATION_WAIT_STATUSES;

export function automationFromSnapshot(
  automation: Automation,
  snapshot: ClaimedAutomationRun['snapshot'],
): Automation {
  return {
    ...automation,
    name: snapshot.name,
    schedule: snapshot.schedule,
    trigger: snapshot.trigger,
    missedRunPolicy: snapshot.missedRunPolicy,
    concurrencyPolicy: snapshot.concurrencyPolicy,
    destination: snapshot.destination,
    action: snapshot.action,
    hidden: snapshot.hidden === true,
  };
}

export function automationShellFromRunSnapshot(run: AutomationRun): Automation {
  const snapshot = run.configSnapshot;
  if (!snapshot) {
    throw new Error('Automation run has no config snapshot');
  }

  return {
    id: run.automationId,
    name: snapshot.name,
    enabled: true,
    active: true,
    workspaceId: toWorkspaceId(snapshot.action.workingDirectory),
    schedule: snapshot.schedule,
    trigger: snapshot.trigger,
    missedRunPolicy: snapshot.missedRunPolicy,
    concurrencyPolicy: snapshot.concurrencyPolicy,
    destination: snapshot.destination,
    action: snapshot.action,
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    hidden: snapshot.hidden === true,
  };
}
