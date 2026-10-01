/**
 * Holds unattended automation dispatches until the host has working DNS.
 *
 * An overdue timer fires the moment the Mac wakes, before Electron has even
 * delivered `powerMonitor` 'resume' (14:14:05 fire vs 14:14:10 resume on
 * 2026-09-29), so a resume-driven delay cannot cover it. The check runs at
 * dispatch instead, after the run row exists: concurrency and catch-up
 * de-duplication already see the run, so a resume sweep cannot fire the same
 * slot twice while this one waits.
 *
 * When the network is up the probe passes and dispatch continues inline. When
 * it is down the wait moves to the background and the caller returns after at
 * most one bounded probe, because callers await `fire()` in sequence (the
 * startup catch-up sweep runs during app bootstrap).
 */

import type { AutomationRun, AutomationTrigger } from '../../shared/types/automation.types';
import { getLogger } from '../logging/logger';
import {
  getDefaultHostResolver,
  isNetworkReachable,
  waitForNetworkReady,
  type HostResolver,
  type NetworkReadyResult,
} from '../runtime/network-readiness';

const logger = getLogger('AutomationNetworkGate');

/**
 * Triggers that fire with nobody watching. Manual, webhook, channel and
 * orchestration triggers dispatch at once: someone is waiting on the result,
 * and an inbound request already shows the network is up.
 */
const UNATTENDED_TRIGGERS: ReadonlySet<AutomationTrigger> = new Set<AutomationTrigger>([
  'scheduled',
  'catchUp',
  'providerRuntime',
]);

export type AutomationNetworkGate = (
  run: AutomationRun,
  store: { getRun(runId: string): AutomationRun | null },
  dispatch: () => Promise<void>,
) => Promise<void>;

export function needsNetworkGate(run: AutomationRun): boolean {
  // A pinned worker node runs the CLI on its own network. System actions are
  // still gated: both provider-limit resumes re-send a turn to the provider,
  // and they are scheduled for the quota reset, often while the Mac sleeps.
  if (run.configSnapshot?.action.forceNodeId) return false;
  // A retry is unattended whatever started the first attempt.
  return run.attempt > 1 || UNATTENDED_TRIGGERS.has(run.trigger);
}

export interface AutomationNetworkGateDeps {
  resolver?: () => HostResolver | null;
  probe?: (resolver: HostResolver) => Promise<boolean>;
  wait?: (resolver: HostResolver) => Promise<NetworkReadyResult>;
}

export function createAutomationNetworkGate(deps: AutomationNetworkGateDeps = {}): AutomationNetworkGate {
  const resolveResolver = deps.resolver ?? getDefaultHostResolver;
  const probe = deps.probe ?? ((resolver: HostResolver) => isNetworkReachable({ resolver }));
  const wait = deps.wait ?? ((resolver: HostResolver) => waitForNetworkReady({ resolver }));

  // Shared across calls: the startup and resume sweeps fire every missed
  // automation in sequence, so they pay for at most one probe, and once an
  // outage is known later runs join its wait without probing again.
  let inFlightProbe: Promise<boolean> | null = null;
  let outage: Promise<NetworkReadyResult> | null = null;

  return async (run, store, dispatch) => {
    const resolver = needsNetworkGate(run) ? resolveResolver() : null;
    if (!resolver) return dispatch();
    let pendingOutage = outage;
    if (!pendingOutage) {
      inFlightProbe ??= probe(resolver).finally(() => { inFlightProbe = null; });
      if (await inFlightProbe) return dispatch();
      pendingOutage = outage ??= wait(resolver).finally(() => { outage = null; });
    }

    logger.warn('Network unreachable; deferring automation dispatch until it returns', {
      automationId: run.automationId,
      runId: run.id,
      attempt: run.attempt,
    });
    void pendingOutage
      .then(async (result) => {
        const current = store.getRun(run.id);
        if (current?.status !== 'running') {
          logger.info('Deferred automation run ended while waiting for the network; not dispatching', {
            automationId: run.automationId,
            runId: run.id,
            status: current?.status ?? 'deleted',
          });
          return;
        }
        logger.info('Dispatching deferred automation run', {
          automationId: run.automationId,
          runId: run.id,
          networkReady: result.ready,
          waitedMs: result.waitedMs,
        });
        await dispatch();
      })
      .catch((error: unknown) => {
        logger.error(
          'Deferred automation dispatch threw',
          error instanceof Error ? error : new Error(String(error)),
          { automationId: run.automationId, runId: run.id },
        );
      });
  };
}

export const defaultAutomationNetworkGate = createAutomationNetworkGate();
