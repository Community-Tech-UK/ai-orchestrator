import type { InstanceStatus } from '@contracts/types/instance-events';
import { attentionLevelForInstanceStatus } from '../../shared/attention/attention-level';
import type { KeepAwakeWorkReason } from './keep-awake-service';

interface WorkInstance {
  status: InstanceStatus;
  lastActivity: number;
  metadata?: Record<string, unknown>;
  waitReason?: { kind: string };
}

/** Includes remote work relayed by this computer; excludes parked or stale turns. */
export function sessionKeepAwakeReasons(instances: readonly WorkInstance[], now: number): KeepAwakeWorkReason[] {
  return instances.filter(instance =>
    attentionLevelForInstanceStatus(instance.status) === 'working'
    && instance.waitReason?.kind !== 'quota-park'
    && now - instance.lastActivity < 2 * 60 * 60 * 1_000,
  ).map(instance => instance.metadata?.['planQueueRunId'] ? 'plan-queue'
    : instance.metadata?.['automationRunId'] ? 'automation' : 'session');
}
