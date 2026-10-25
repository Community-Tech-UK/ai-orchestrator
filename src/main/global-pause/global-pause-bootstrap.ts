import { app } from 'electron';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { EventEmitter } from 'node:events';
import type { InstanceManager } from '../instance/instance-manager';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getWorkAdmission } from '../work-admission/work-admission';
import { ownedByEngine } from '../work-admission/engine-ownership';
import { registerCleanup } from '../util/cleanup-registry';
import { getAutomationEvents } from '../automations/automation-events';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getCampaignCoordinator } from '../orchestration/campaign-coordinator';
import { getPlanQueueCoordinator } from '../plan-queue/plan-queue-coordinator';
import { GlobalPauseStore } from './global-pause-store';
import { GlobalPauseService } from './global-pause-service';
import { createGlobalPauseRuntime } from './global-pause-runtime';
import { getSessionAdmissionService } from '../session/session-admission-service';

/** Restore admission before any unattended engine is initialized. */
export function initializeGlobalPauseRuntime(manager: InstanceManager): GlobalPauseService {
  const admission = getWorkAdmission(); admission.bootstrap();
  const service = GlobalPauseService.getInstance({ store: new GlobalPauseStore(getRLMDatabase().getRawDb()),
    runtime: createGlobalPauseRuntime(manager) });
  service.bootstrap();
  const refire = (): void => getSessionAdmissionService().refireHeldWrites();
  service.on('state-changed', refire);
  const refresh = (): void => service.refreshState();
  admission.on('admission-changed', refresh);
  const unregisterCounter = admission.registerCounter('helper-agent', () => manager.getAllInstances()
    .filter((instance) => instance.parentId && instance.executionLocation?.type !== 'remote' && !ownedByEngine(instance)
      && ['busy', 'processing', 'thinking_deeply', 'initializing', 'waiting_for_input', 'waiting_for_permission'].includes(instance.status)).length);
  const sentinel = join(app.getPath('userData'), 'hold-new-work');
  const engageSentinel = (): void => { if (existsSync(sentinel)) service.hold('Held by a file in the data folder'); };
  engageSentinel();
  const watcher = watch(app.getPath('userData'), (_event, filename) => { if (filename?.toString() === 'hold-new-work') engageSentinel(); });
  watcher.unref();
  const listeners: (() => void)[] = [];
  const wire = <T>(emitter: EventEmitter, event: string, callback: (payload: T) => void): void => {
    emitter.on(event, callback); listeners.push(() => emitter.off(event, callback));
  };
  wire(getAutomationEvents(), 'automation:run-terminal', (event: { runId: string }) => service.voidTarget(event.runId, 'scheduled-job-ended'));
  const loops = getLoopCoordinator();
  const unregisterLoopCounter = admission.registerCounter('loop-round', () => loops.getActiveLoops()
    .filter((loop) => Boolean(loop.inFlightIteration)).length);
  for (const event of ['loop:completed', 'loop:cancelled', 'loop:failed', 'loop:error']) {
    wire(loops, event, (payload: { loopRunId: string }) => service.voidTarget(payload.loopRunId, 'loop-ended'));
  }
  const campaigns = getCampaignCoordinator();
  for (const event of ['campaign:completed', 'campaign:failed', 'campaign:halted']) {
    wire(campaigns, event, (payload: { campaignId: string }) => service.voidTarget(payload.campaignId, 'campaign-ended'));
  }
  wire(getPlanQueueCoordinator(), 'state-changed', (() => {
    const queue = getPlanQueueCoordinator(); if (!queue.isInitialized()) return;
    for (const entry of service.getState().entries.filter((entry) => entry.kind === 'queue-run')) {
      try { if (['completed', 'cancelled'].includes(queue.getRun(entry.targetId).status)) service.voidTarget(entry.targetId, 'queue-run-ended'); }
      catch { service.voidTarget(entry.targetId, 'queue-run-removed'); }
    }
  }));
  registerCleanup(() => { watcher.close(); service.shutdown(); service.off('state-changed', refire); unregisterCounter(); unregisterLoopCounter(); for (const cleanup of listeners) cleanup(); admission.off('admission-changed', refresh); admission.dispose(); });
  return service;
}
