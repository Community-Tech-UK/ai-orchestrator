import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { PendingApprovalLike } from './pending-approval-digest';

export type LiveWaitingInstance = Pick<Instance, 'id' | 'status' | 'yoloMode'>
  & Partial<Pick<Instance, 'parentId' | 'metadata' | 'waitReason'>>
  & { waitingSince?: number };

const waitingSince = new WeakMap<object, number>();

function isWaiting(status: InstanceStatus): boolean {
  return status === 'waiting_for_permission' || status === 'waiting_for_input';
}

/** Runtime-only clock, captured at the shared state-update seam, not output activity. */
export function observeLiveWaitingStatus(instance: object, status: InstanceStatus, now: number): void {
  if (!isWaiting(status)) {
    waitingSince.delete(instance);
  } else if (!waitingSince.has(instance)) {
    waitingSince.set(instance, now);
  }
}

function isMachineStarted(instance: LiveWaitingInstance): boolean {
  const metadata = instance.metadata;
  // These are the existing create-time provenance markers used by the queue,
  // automations, reviewer spawner and run_on_node. Channel sessions are human.
  return Boolean(instance.parentId
    || metadata?.['pingPongReviewer']
    || metadata?.['planQueueRunId']
    || metadata?.['planQueueRole']
    || metadata?.['automationId']
    || metadata?.['spawnParentInstanceId']
    || ['plan-queue', 'automation', 'repo-job', 'remote-node'].includes(String(metadata?.['spendPurpose'])));
}

/** Pure projection: an absent or invalid clock never fabricates an old wait. */
export function liveWaitingAsApprovals(
  instances: readonly LiveWaitingInstance[],
  now: number,
): PendingApprovalLike[] {
  return instances.flatMap((instance) => {
    if (!isWaiting(instance.status) || instance.yoloMode || instance.waitReason || isMachineStarted(instance)) return [];
    const since = instance.waitingSince;
    if (since === undefined || !Number.isFinite(since) || since > now) return [];
    return [{
      approvalId: `live:${instance.id}`,
      instanceId: instance.id,
      createdAt: since,
      expiresAt: now + 24 * 60 * 60_000,
    }];
  });
}

/** Shared reminder/banner input. Durable approvals remain independently actionable. */
export function mergePendingAndLiveApprovals(
  pending: readonly PendingApprovalLike[],
  instances: readonly LiveWaitingInstance[],
  now: number,
  isMachineSession: (instanceId: string) => boolean = () => false,
): PendingApprovalLike[] {
  const snapshots = instances.flatMap((instance) => {
    // Already-waiting instances with no clock start at first observation. Never
    // use lastActivity: provider output/context traffic keeps changing it.
    observeLiveWaitingStatus(instance, instance.status, now);
    if (!isWaiting(instance.status) || isMachineStarted(instance) || instance.yoloMode
      || instance.waitReason || isMachineSession(instance.id)) return [];
    return [{ ...instance, waitingSince: waitingSince.get(instance) }];
  });
  const byInstance = new Map<string, PendingApprovalLike>();
  for (const row of [...pending, ...liveWaitingAsApprovals(snapshots, now)]) {
    if (row.expiresAt <= now) continue;
    const existing = byInstance.get(row.instanceId);
    if (!existing || row.createdAt < existing.createdAt) byInstance.set(row.instanceId, row);
  }
  return [...byInstance.values()];
}
