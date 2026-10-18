/** Run-status fences before and after asynchronous instance creation. */
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { routeQueueSpawn } from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';

export async function spawnQueueInstance(
  config: InstanceCreateConfig,
  host: {
    ready: Promise<void>; instances: PlanQueueInstancePort;
    getRun(id: string): PlanQueueRun | null;
    isShuttingDown(): boolean; userCloseEpoch(): number;
    isProviderExcluded?: (provider: string) => boolean;
  },
): ReturnType<PlanQueueInstancePort['createInstance']> {
  const epoch = host.userCloseEpoch();
  const runId = config.metadata?.['planQueueRunId'];
  // Capture the run snapshot only when ready to dispatch; routeQueueSpawn reads it once.
  const assertAllowed = (checkRouting = true) => {
    if (host.isShuttingDown()) throw new Error('Plan Queue is shutting down');
    if (epoch !== host.userCloseEpoch()) throw new PlanQueueSpawnStoppedByUser();
    const run = typeof runId === 'string' ? host.getRun(runId) : null;
    if (run?.status === 'paused') throw new PlanQueueSpawnRunPaused();
    if (run && run.status !== 'running') throw new PlanQueueSpawnStoppedByUser();
    const retry = config.metadata?.['planQueueRole'] === 'triage' && config.metadata?.['planQueueTriageRetry'] === true;
    if (checkRouting && run && (config.metadata?.['planQueueRole'] === 'verifier' || retry)
      && config.metadata && Object.hasOwn(config.metadata, 'planQueueRouting')
      && (config.metadata['planQueueRouting'] !== JSON.stringify(run.config.routing)
        || (retry && config.metadata['planQueueTriageWorkerModel'] !== run.workerModel))) throw new PlanQueueSpawnRoutingChanged();
  };
  await host.ready;
  assertAllowed();
  const instance = await host.instances.createInstance(routeQueueSpawn(config, host.getRun, host.isProviderExcluded));
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
