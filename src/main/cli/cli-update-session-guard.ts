import type { InstanceStatus } from '../../shared/types/instance.types';

/** Only turns in flight and pending approvals hold an opted-in CLI update. */
const MID_TURN_STATUSES = new Set<InstanceStatus>([
  'busy', 'processing', 'thinking_deeply', 'waiting_for_permission',
  'interrupting', 'cancelling', 'interrupt-escalating',
]);

export function countUpdateBlockingSessions(
  instances: readonly { id: string; status: InstanceStatus }[],
  pendingApprovalIds: ReadonlySet<string> = new Set<string>(),
): number {
  return instances.filter(instance => MID_TURN_STATUSES.has(instance.status) || pendingApprovalIds.has(instance.id)).length;
}
