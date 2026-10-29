/** Run-status fences before and after asynchronous instance creation. */
import type { PlanQueueAccountRules, PlanQueueRouteChoice } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { chooseQueueWorker, queueWorkerChoices, routeQueueSpawn } from './plan-queue-routing';
import { defaultPlanQueueRouteUsage, type PlanQueueRouteUsage, type PlanQueueRouteUsageCheck } from './plan-queue-route-usage';
import { getLogger } from '../logging/logger';
import type { PlanQueueItem, PlanQueueWorkerSession, PlanQueueRun } from './plan-queue.types';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';

/** How long work that found no usage left waits before the queue looks again. */
export const USAGE_RECHECK_MS = 5 * 60_000;

/**
 * No queue session starts on a route with no usage left: it would only hit the
 * limit and fail. The work waits instead and is tried again later.
 */
export class PlanQueueSpawnOutOfUsage extends Error {
  constructor(readonly resumeAt: number | null, route: string) {
    super(`${route} has no usage left${resumeAt ? ` until ${new Date(resumeAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`);
  }
}

export async function spawnQueueInstance(
  config: InstanceCreateConfig,
  host: {
    ready: Promise<void>; instances: PlanQueueInstancePort;
    getRun(id: string): PlanQueueRun | null;
    getItem(id: string): PlanQueueItem | null;
    clearWorkerSession(id: string): void;
    isShuttingDown(): boolean; userCloseEpoch(): number;
    isProviderExcluded?: (provider: string) => boolean;
    readAccountRules: () => PlanQueueAccountRules;
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
  const usage = host.routeUsage ?? defaultPlanQueueRouteUsage();
  const isExcluded = host.isProviderExcluded ?? isProviderExcludedFromAutomation;
  let worker: PlanQueueRouteChoice | null;
  // Choosing and checking usage yield; repeat them if James changes the run's
  // routing meanwhile, so the spawn never uses a stale list.
  for (;;) {
    const routing = JSON.stringify(runOf()?.config.routing);
    worker = await chooseQueueWorker(queueWorkerChoices(config, runOf(), host.isProviderExcluded), usage, String(runId), runOf()?.workspaceCwd);
    assertAllowed();
    const route = routeQueueSpawn(config, host.getRun, worker, isExcluded, host.readAccountRules());
    const left = await usageLeft(route, usage);
    assertAllowed();
    if (JSON.stringify(runOf()?.config.routing) !== routing) continue;
    if (!left.usable) throw new PlanQueueSpawnOutOfUsage(left.resumeAt, route.modelOverride ? `${route.provider} (${route.modelOverride})` : String(route.provider));
    break;
  }
  const route = routeQueueSpawn(config, host.getRun, worker, isExcluded, host.readAccountRules());
  const itemId = config.metadata?.['planQueueItemId'];
  const item = typeof itemId === 'string' ? host.getItem(itemId) : null;
  const session = config.metadata?.['planQueueRole'] === 'worker' ? continuableWorkerSession(item, route) : null;
  let instance: Awaited<ReturnType<PlanQueueInstancePort['createInstance']>>;
  try {
    instance = await host.instances.createInstance(session ? {
      ...route, sessionId: session.providerSessionId, resume: true,
      ...(session.accountProfileId ? { allowedAccountProfileIds: [session.accountProfileId] } : {}),
      ...(typeof config.metadata?.['planQueueContinuePrompt'] === 'string'
        ? { initialPrompt: config.metadata['planQueueContinuePrompt'] } : {}),
    } : route);
    if (session) instance = { ...instance, queueResumed: true };
  } catch (error) {
    if (!session) throw error;
    getLogger('PlanQueueSpawn').info('Plan queue: could not reopen the worker conversation; starting fresh', { itemId, provider: route.provider });
    host.clearWorkerSession(String(itemId));
    assertAllowed();
    instance = await host.instances.createInstance(route);
  }
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

/** Usage left on the route a session would start on. A session with no named provider yet is not checked. */
function usageLeft(config: InstanceCreateConfig, usage: PlanQueueRouteUsageCheck): Promise<PlanQueueRouteUsage> {
  if (!config.provider || config.provider === 'auto') return Promise.resolve({ usable: true, resumeAt: null });
  return usage({
    provider: config.provider,
    ...(config.modelOverride ? { model: config.modelOverride } : {}),
    ...(config.allowedAccountProfileIds?.length ? { accountProfileIds: [...config.allowedAccountProfileIds] } : {}),
    ...(config.copilotAccountProfileId ? { copilotProfileId: config.copilotAccountProfileId } : {}),
  }, config.accountRouteOrigin === 'verification' ? 'verification' : 'automation', {
    allowLast: true, ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {}),
  });
}

/** Only reopen a conversation on its original provider, model, account and checkout. */
export function continuableWorkerSession(item: PlanQueueItem | null | undefined, route: InstanceCreateConfig): PlanQueueWorkerSession | null {
  const session = item?.workerSession;
  if (!session || !session.providerSessionId || session.provider !== route.provider
    || session.model !== (route.modelOverride ?? null) || session.workingDirectory !== route.workingDirectory) return null;
  const accounts = route.allowedAccountProfileIds;
  if (session.accountProfileId
    ? !(accounts?.includes(session.accountProfileId) || route.copilotAccountProfileId === session.accountProfileId)
    : Boolean(accounts?.length || route.copilotAccountProfileId)) return null;
  return session;
}
