import type { InstanceManager } from '../instance/instance-manager';
import { getRLMDatabase } from '../persistence/rlm-database';
import { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { AutomationScheduler } from './automation-scheduler';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { getAutomationEvents } from './automation-events';

let attachmentService: AutomationAttachmentService | null = null;
let store: AutomationStore | null = null;
let runner: AutomationRunner | null = null;
let catchUp: CatchUpCoordinator | null = null;
let scheduler: AutomationScheduler | null = null;

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
}

export function resetAutomationsForTesting(): void {
  attachmentService = null;
  store = null;
  runner = null;
  catchUp = null;
  scheduler = null;
}

export { computeMissedFireTimes, computeNextFireAt, validateCronExpression } from './automation-schedule';
export { AutomationStore } from './automation-store';
export { AutomationRunner } from './automation-runner';
export { AutomationScheduler } from './automation-scheduler';
export { CatchUpCoordinator } from './catch-up-coordinator';
