import { getLogger } from '../logging/logger';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import type { InstanceManager } from '../instance/instance-manager';
import { getRLMDatabase } from '../persistence/rlm-database';
import { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { AutomationScheduler } from './automation-scheduler';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { getAutomationEvents } from './automation-events';
import { startProviderLimitResumeReconciler } from './provider-limit-resume-reconciler';
import { _resetAutomationCheckStoreForTesting, getAutomationCheckStore } from './automation-check-store';

export { getAutomationCheckStore };

const logger = getLogger('Automations');

let attachmentService: AutomationAttachmentService | null = null;
let store: AutomationStore | null = null;
let runner: AutomationRunner | null = null;
let catchUp: CatchUpCoordinator | null = null;
let scheduler: AutomationScheduler | null = null;
let stopResumeReconciler: (() => void) | null = null;

export function getAutomationAttachmentService(): AutomationAttachmentService {
  if (!attachmentService) {
    attachmentService = new AutomationAttachmentService(getRLMDatabase().getRawDb());
  }
  return attachmentService;
}

export function getAutomationStore(): AutomationStore {
  if (!store) {
    store = new AutomationStore(getRLMDatabase().getRawDb(), getAutomationAttachmentService());
  }
  return store;
}

export function getAutomationRunner(): AutomationRunner {
  if (!runner) {
    runner = new AutomationRunner(getAutomationStore(), getAutomationEvents());
  }
  return runner;
}

export function getCatchUpCoordinator(): CatchUpCoordinator {
  if (!catchUp) {
    catchUp = new CatchUpCoordinator(
      getAutomationStore(),
      getAutomationRunner(),
      getAutomationEvents(),
    );
  }
  return catchUp;
}

export function getAutomationScheduler(): AutomationScheduler {
  if (!scheduler) {
    scheduler = new AutomationScheduler(
      getAutomationStore(),
      getAutomationRunner(),
      getCatchUpCoordinator(),
      getAutomationEvents(),
    );
  }
  return scheduler;
}

export async function initializeAutomations(instanceManager: InstanceManager): Promise<void> {
  const automationRunner = getAutomationRunner();
  automationRunner.initialize(instanceManager);
  // Built here (not after the sweep) so the runner's retry callback is
  // registered before any catch-up fire can fail and ask for a retry.
  const automationScheduler = getAutomationScheduler();
  // Startup steps run before the main window exists. A catch-up fire runs the
  // job's check command inline (up to 30 s per job), so the sweep must not be
  // awaited here. Fire-and-forget; the scheduler is armed when it ends.
  void runCatchUpThenArmScheduler(automationScheduler);

  // Durable counterpart of the in-park early-resume quota probe: fire pending
  // provider-limit resume automations as soon as the limit lifts, instead of
  // waiting out a recorded reset time that went stale across a restart.
  stopResumeReconciler?.();
  stopResumeReconciler = startProviderLimitResumeReconciler({
    listAutomations: () => getAutomationStore().list(),
    fire: (automation, provider) => automationRunner.fire(automation.id, {
      trigger: 'providerRuntime',
      triggerSource: {
        type: 'providerRuntime',
        provider,
        metadata: { reason: 'provider-limit-lifted-early' },
      },
    }),
    probeQuota: (provider) => getProviderQuotaService().refresh(provider),
  });
}

/**
 * Same order as before the sweep moved off the startup path: catch up missed
 * runs first, then arm the scheduler, so the scheduler cannot also fire a
 * run the sweep is catching up. A failed sweep is logged and the scheduler is
 * still armed (previously a sweep error left schedules unarmed all session).
 */
async function runCatchUpThenArmScheduler(automationScheduler: AutomationScheduler): Promise<void> {
  try {
    await getCatchUpCoordinator().runStartupSweep();
  } catch (error) {
    logger.error('Automation startup catch-up sweep failed', error instanceof Error ? error : undefined);
  }
  try {
    automationScheduler.initialize();
  } catch (error) {
    logger.error('Automation scheduler failed to initialize', error instanceof Error ? error : undefined);
  }
}

export function resetAutomationsForTesting(): void {
  stopResumeReconciler?.();
  stopResumeReconciler = null;
  attachmentService = null;
  _resetAutomationCheckStoreForTesting();
  store = null;
  runner = null;
  catchUp = null;
  scheduler = null;
}

export { computeMissedFireTimes, computeNextFireAt, validateCronExpression } from './automation-schedule';
export { AutomationStore } from './automation-store';
export { AutomationRunner } from './automation-runner';
export { ThreadWakeupRunner } from './thread-wakeup-runner';
export { AutomationScheduler } from './automation-scheduler';
export { CatchUpCoordinator } from './catch-up-coordinator';
