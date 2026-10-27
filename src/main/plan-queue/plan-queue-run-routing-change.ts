/** Validate and atomically persist a run's next-session provider/account choice. */
import type { PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import {
  assertRoutingInstalled, defaultPlanQueueRoutingDeps, describeRouting, resolveRunRouting,
  type PlanQueueParentRoute, type PlanQueueRoutingDeps, PlanQueueRoutingError,
} from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRunRoutingChange');

export interface PlanQueueRunRoutingChangeHost {
  getRun(id: string): PlanQueueRun;
  hasParkedWork(run: PlanQueueRun): boolean;
  parentRoute(run: PlanQueueRun): PlanQueueParentRoute;
  upsertRun(run: PlanQueueRun): void;
  /** Caller suspends new spawns while holding; this does not change run status. */
  holdRun(run: PlanQueueRun): Promise<void>;
  requestPump(): void;
  notifyParent(run: PlanQueueRun, message: string): void;
}

export async function changeRunRouting(
  host: PlanQueueRunRoutingChangeHost,
  run: PlanQueueRun,
  choice: PlanQueueRouting,
  actor: 'panel' | 'parent',
  moveInProgress = false,
  deps: PlanQueueRoutingDeps = defaultPlanQueueRoutingDeps(),
): Promise<void> {
  if (!['running', 'paused'].includes(run.status) && !host.hasParkedWork(run)) {
    throw new PlanQueueRoutingError('This run has finished and has no parked documents to resume.');
  }
  // A full edit replaces the saved defaults for this resolution only. In particular, no
  // workers means inherit the starting session, never fall back to today's saved list.
  // Provenance is derived from the authenticated surface, never from the payload: a
  // parent's checkers stay a per-run list, which cannot replace a protected work seat.
  const { routing } = resolveRunRouting(host.parentRoute(run), {
    ...(actor === 'parent' ? { verifiers: choice.verifiers } : {}),
    relaxExclusions: run.config.relaxSettings,
    workspaceCwd: run.workspaceCwd,
  }, { ...deps, readSaved: () => ({
    workers: choice.workers, verifiers: actor === 'parent' ? [] : choice.verifiers, ...(choice.stepUp ? { stepUp: choice.stepUp } : {}),
  }) });
  await assertRoutingInstalled(routing, deps);
  // Detection can yield while the scheduler finishes the run or restores its parent.
  // Keep that newer lifecycle state while changing only routing fields.
  const current = host.getRun(run.id);
  if (!['running', 'paused'].includes(current.status) && !host.hasParkedWork(current)) {
    throw new PlanQueueRoutingError('This run has finished and has no parked documents to resume.');
  }
  const updated: PlanQueueRun = {
    ...current, workerProvider: routing.workers[0]?.provider ?? null, workerModel: routing.workers[0]?.model ?? null,
    config: { ...current.config, routing },
  };
  const before = describeRouting(current.config.routing);
  const after = describeRouting(routing);
  host.upsertRun(updated);
  const message = `James changed this run's workers from ${before.workers} to ${after.workers}; checkers from ${before.checkers} to ${after.checkers}; `
    + `if a worker gets stuck, from ${before.stepUp} to ${after.stepUp}.`
    + (moveInProgress && current.status === 'running' ? ' Documents in progress are moving to the new choice now.' : ' New sessions use this choice.');
  logger.info('Plan queue: routing changed', { runId: run.id, actor, before, after, moveInProgress });
  host.notifyParent(updated, message);
  if (moveInProgress && current.status === 'running') {
    await host.holdRun(updated);
    host.requestPump();
  }
}
