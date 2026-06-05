import type {
  Automation,
  AutomationRun,
  ClaimedAutomationRun,
} from '../../shared/types/automation.types';
import type { InstanceStatus } from '../../shared/types/instance.types';
import { toWorkspaceId } from '../../shared/utils/workspace-key';

export const FAILURE_STATUSES = new Set<InstanceStatus>([
  'error',
  'failed',
  'terminated',
  'cancelled',
  'superseded',
]);

export const WAIT_STATUSES = new Set<InstanceStatus>([
  'waiting_for_input',
  'waiting_for_permission',
]);

export function automationFromSnapshot(
  automation: Automation,
  snapshot: ClaimedAutomationRun['snapshot'],
): Automation {
  return {
    ...automation,
    name: snapshot.name,
    schedule: snapshot.schedule,
    missedRunPolicy: snapshot.missedRunPolicy,
    concurrencyPolicy: snapshot.concurrencyPolicy,
    destination: snapshot.destination,
    action: snapshot.action,
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
    missedRunPolicy: snapshot.missedRunPolicy,
    concurrencyPolicy: snapshot.concurrencyPolicy,
    destination: snapshot.destination,
    action: snapshot.action,
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
