/**
 * Routing saved before workers became a ranked list (2026-10-25) held one
 * `worker` choice, or null for "the session that starts the run". The saved
 * setting is rewritten once by a settings migration; stored runs, imported
 * settings files and every read of the saved setting (an older build sharing
 * the settings file can write the old shape back) go through this.
 */
import type { PlanQueueRouteChoice, PlanQueueRouting } from '@contracts/schemas/plan-queue';

export type StoredPlanQueueRouting = PlanQueueRouting | (Omit<PlanQueueRouting, 'workers'> & { worker: PlanQueueRouteChoice | null });

export function isLegacyPlanQueueRouting(value: unknown): value is Exclude<StoredPlanQueueRouting, PlanQueueRouting> {
  return typeof value === 'object' && value !== null && 'worker' in value && !('workers' in value);
}

export function upgradePlanQueueRouting(routing: StoredPlanQueueRouting): PlanQueueRouting {
  if (!isLegacyPlanQueueRouting(routing)) return routing;
  const { worker, ...rest } = routing;
  return { ...rest, workers: worker ? [worker] : [] };
}
