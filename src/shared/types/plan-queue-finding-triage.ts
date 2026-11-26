import type { PlanQueueFinding } from '@contracts/schemas/plan-queue';

/** Shared by the queue and its renderer; lower severities remain visible to James. */
export const PLAN_QUEUE_BLOCKING_SEVERITIES: readonly PlanQueueFinding['severity'][] = ['critical', 'high'];

export function splitFindings(findings: readonly PlanQueueFinding[]): {
  blocking: PlanQueueFinding[];
  optional: PlanQueueFinding[];
} {
  const blocking: PlanQueueFinding[] = [];
  const optional: PlanQueueFinding[] = [];
  for (const finding of findings) {
    (PLAN_QUEUE_BLOCKING_SEVERITIES.includes(finding.severity) ? blocking : optional).push(finding);
  }
  return { blocking, optional };
}
