import type {
  Automation,
  AutomationAction,
  AutomationConfigSnapshot,
  AutomationConfiguredTrigger,
  AutomationDestination,
  AutomationRun,
  AutomationSchedule,
  AutomationTriggerSource,
} from '../../shared/types/automation.types';
import { toWorkspaceId } from '../../shared/utils/workspace-key';
import type { AutomationRow, AutomationRunRow } from './automation-store-records';

type PersistedAutomationConfigSnapshot = Omit<AutomationConfigSnapshot, 'destination'> & {
  destination?: AutomationDestination;
};

export function stripAttachmentData(action: AutomationAction): AutomationAction {
  const { attachments, ...rest } = action;
  void attachments;
  return rest;
}

export function toSnapshot(automation: Automation): AutomationConfigSnapshot {
  return {
    name: automation.name,
    schedule: automation.schedule,
    trigger: automation.trigger,
    missedRunPolicy: automation.missedRunPolicy,
    concurrencyPolicy: automation.concurrencyPolicy,
    destination: automation.destination,
    action: automation.action,
  };
}

export function normalizeDestination(destination?: AutomationDestination | null): AutomationDestination {
  if (!destination || destination.kind === 'newInstance') {
    return { kind: 'newInstance' };
  }

  const normalized: Extract<AutomationDestination, { kind: 'thread' }> = {
    kind: 'thread',
    instanceId: destination.instanceId,
    reviveIfArchived: destination.reviveIfArchived ?? true,
  };
  if (destination.sessionId !== undefined) {
    normalized.sessionId = destination.sessionId;
  }
  if (destination.historyEntryId !== undefined) {
    normalized.historyEntryId = destination.historyEntryId;
  }
  return normalized;
}

export function normalizeSnapshot(snapshot: PersistedAutomationConfigSnapshot): AutomationConfigSnapshot {
  return {
    ...snapshot,
    trigger: normalizeConfiguredTrigger(snapshot.trigger),
    destination: normalizeDestination(snapshot.destination),
  };
}

export function normalizeConfiguredTrigger(
  trigger: AutomationConfiguredTrigger | undefined,
): AutomationConfiguredTrigger {
  if (!trigger || trigger.kind === 'schedule') {
    return { kind: 'schedule' };
  }
  return {
    kind: 'webhook',
    routeId: trigger.routeId,
    filters: trigger.filters ?? [],
  };
}

export function mapAutomationRow(row: AutomationRow, destination: AutomationDestination): Automation {
  const action = JSON.parse(row.action_json) as AutomationAction;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    active: row.active === 1,
    // Fall back to deriving from the action for rows read before migration 034
    // backfilled the column (defensive — backfill makes this rare).
    workspaceId: row.workspace_id ?? toWorkspaceId(action.workingDirectory),
    schedule: JSON.parse(row.schedule_json) as AutomationSchedule,
    trigger: normalizeConfiguredTrigger(JSON.parse(row.trigger_json) as AutomationConfiguredTrigger),
    missedRunPolicy: row.missed_run_policy,
    concurrencyPolicy: row.concurrency_policy,
    destination,
    action,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadRunCount: row.unread_run_count ?? 0,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastFailureAt: row.last_failure_at ?? null,
    lastFailureReason: row.last_failure_reason ?? null,
  };
}

export function mapRunRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status,
    trigger: row.trigger,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    instanceId: row.instance_id,
    error: row.error,
    outputSummary: row.output_summary,
    outputFullRef: row.output_full_ref,
    idempotencyKey: row.idempotency_key,
    triggerSource: row.trigger_source_json
      ? JSON.parse(row.trigger_source_json) as AutomationTriggerSource
      : null,
    deliveryMode: row.delivery_mode ?? 'notify',
    seenAt: row.seen_at,
    configSnapshot: row.config_snapshot_json
      ? normalizeSnapshot(JSON.parse(row.config_snapshot_json) as PersistedAutomationConfigSnapshot)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempt: row.attempt ?? 1,
    maxAttempts: row.max_attempts ?? 1,
  };
}
