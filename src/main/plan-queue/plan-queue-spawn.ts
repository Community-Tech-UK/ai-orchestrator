/** Run-status fences before and after asynchronous instance creation. */
import type { PlanQueueRouteChoice } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { chooseQueueWorker, queueWorkerChoices, routeQueueSpawn } from './plan-queue-routing';
import { defaultPlanQueueRouteUsage, type PlanQueueRouteUsageCheck } from './plan-queue-route-usage';
import type { PlanQueueRun } from './plan-queue.types';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';

export async function spawnQueueInstance(
  config: InstanceCreateConfig,
  host: {
    ready: Promise<void>; instances: PlanQueueInstancePort;
    getRun(id: string): PlanQueueRun | null;
    isShuttingDown(): boolean; userCloseEpoch(): number;
    isProviderExcluded?: (provider: string) => boolean;
    routeUsage?: PlanQueueRouteUsageCheck;
  },
): ReturnType<PlanQueueInstancePort['createInstance']> {
  const epoch = host.userCloseEpoch();
  const runId = config.metadata?.['planQueueRunId'];
  const runOf = () => (typeof runId === 'string' ? host.getRun(runId) : null);
  // Capture the run snapshot only when ready to dispatch; routeQueueSpawn reads it once.
  const assertAllowed = (checkRouting = true) => {
    if (host.isShuttingDown()) throw new Error('Plan Queue is shutting down');
    if (epoch !== host.userCloseEpoch()) throw new PlanQueueSpawnStoppedByUser();
    const run = runOf();
    if (run?.status === 'paused') throw new PlanQueueSpawnRunPaused();
    if (run && run.status !== 'running') throw new PlanQueueSpawnStoppedByUser();
    const retry = config.metadata?.['planQueueRole'] === 'triage' && config.metadata?.['planQueueTriageRetry'] === true;
    if (checkRouting && run && (config.metadata?.['planQueueRole'] === 'verifier' || retry)
      && config.metadata && Object.hasOwn(config.metadata, 'planQueueRouting')
      && config.metadata['planQueueRouting'] !== JSON.stringify(run.config.routing)) throw new PlanQueueSpawnRoutingChanged();
  };
  await host.ready;
  assertAllowed();
  let choices = queueWorkerChoices(config, runOf(), host.isProviderExcluded);
  let worker: PlanQueueRouteChoice | null = choices[0] ?? null;
  // Choosing among several worker choices reads usage and yields; repeat it if
  // James changes the run's routing meanwhile, so the spawn never uses a stale list.
  while (choices.length > 1) {
    const routing = JSON.stringify(runOf()?.config.routing);
    worker = await chooseQueueWorker(choices, host.routeUsage ?? defaultPlanQueueRouteUsage(), String(runId));
    assertAllowed();
    if (JSON.stringify(runOf()?.config.routing) === routing) break;
    choices = queueWorkerChoices(config, runOf(), host.isProviderExcluded);
    worker = choices[0] ?? null;
  }
  const instance = await host.instances.createInstance(routeQueueSpawn(config, host.getRun, worker, host.isProviderExcluded));
  try { assertAllowed(false); }
  catch (error) {
    // A pause can land while createInstance is awaiting its adapter. Never leak its session.
    instance.readyPromise?.catch(() => undefined);
    try { await host.instances.terminateInstance(instance.id, true); }
    catch (stopError) {
      // Preserve ownership until cleanup succeeds, including when Pause races Close all.
      if (error instanceof PlanQueueSpawnRunPaused) throw new PlanQueueSpawnRunPaused(instance.id, { cause: stopError });
      if (error instanceof PlanQueueSpawnStoppedByUser) throw new PlanQueueSpawnStoppedByUser(instance.id, { cause: stopError });
      throw stopError;
    }
    throw error;
  }
  return instance;
}
