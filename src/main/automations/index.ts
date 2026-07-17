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
  await getCatchUpCoordinator().runStartupSweep();
  getAutomationScheduler().initialize();

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

export function resetAutomationsForTesting(): void {
  stopResumeReconciler?.();
  stopResumeReconciler = null;
  attachmentService = null;
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
