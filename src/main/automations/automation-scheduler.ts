import { powerMonitor } from 'electron';
import { getLogger } from '../logging/logger';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { computeNextFireAt } from './automation-schedule';
import { getAutomationEvents } from './automation-events';
import type { Automation } from '../../shared/types/automation.types';

const logger = getLogger('AutomationScheduler');
const MAX_TIMEOUT_MS = 2_147_000_000;

interface ScheduledHandle {
  timeout: NodeJS.Timeout;
  targetAt: number;
}

export class AutomationScheduler {
  private readonly handles = new Map<string, ScheduledHandle>();
  private initialized = false;
  private suspendedAt: number | null = null;

  constructor(
    private readonly store: AutomationStore,
    private readonly runner: AutomationRunner,
    private readonly catchUp: CatchUpCoordinator,
    private readonly events = getAutomationEvents(),
    private readonly now = () => Date.now(),
  ) {}

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    for (const automation of this.store.listSchedulable()) {
      this.schedule(automation);
    }

    this.events.on('automation:changed', (event: { automation: Automation | null; automationId: string }) => {
      if (event.automation?.active && event.automation.enabled && event.automation.nextFireAt !== null) {
        this.schedule(event.automation);
      } else {
        this.deactivate(event.automationId);
      }
    });
    this.events.on('automation:schedule-deactivated', (event: { automationId: string }) => {
      this.deactivate(event.automationId);
    });
    this.events.on('automation:orphaned-fire', (event: { automationId: string }) => {
      this.deactivate(event.automationId);
    });
    this.events.on('automation:run-terminal', (event: { automationId: string; runId: string }) => {
      const run = this.store.getRun(event.runId);
      if (run?.configSnapshot?.schedule.type === 'oneTime') {
        this.deactivate(event.automationId);
      }
    });

    powerMonitor.on('suspend', () => {
      this.suspendedAt = this.now();
    });
    powerMonitor.on('resume', () => {
      const resumedAt = this.now();
      const suspendedAt = this.suspendedAt;
      this.suspendedAt = null;
      this.catchUp.runResumeSweep({ suspendedAt, resumedAt }).catch((error) => {
        logger.warn('Automation resume sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.rescheduleAll();
    });
  }

  schedule(automation: Automation): void {
    this.deactivate(automation.id);
    if (!automation.active || !automation.enabled || automation.nextFireAt === null) {
      return;
    }

    const delay = Math.max(0, automation.nextFireAt - this.now());
    const timeout = setTimeout(() => {
      void this.onTimer(automation.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    timeout.unref?.();
    this.handles.set(automation.id, { timeout, targetAt: automation.nextFireAt });
  }

  deactivate(automationId: string): void {
    const handle = this.handles.get(automationId);
    if (!handle) {
      return;
    }
    clearTimeout(handle.timeout);
    this.handles.delete(automationId);
  }

  private async onTimer(automationId: string): Promise<void> {
    const automation = await this.store.get(automationId);
    if (!automation || !automation.active || !automation.enabled || automation.nextFireAt === null) {
      this.deactivate(automationId);
      return;
    }

    const scheduledAt = automation.nextFireAt;
    if (scheduledAt - this.now() > 1000) {
      this.schedule(automation);
      return;
    }

    const nextFireAt = automation.schedule.type === 'cron'
      ? computeNextFireAt(automation.schedule, scheduledAt + 1000)
      : null;
    this.store.setNextFireAt(automation.id, nextFireAt, this.now());

    const updated = await this.store.get(automation.id);
    if (updated) {
      if (nextFireAt !== null) {
        this.schedule(updated);
      } else {
        this.deactivate(automation.id);
      }
      this.events.emitChanged({ automation: updated, automationId: updated.id, type: 'updated' });
    }

    await this.runner.fire(automation.id, { trigger: 'scheduled', scheduledAt });
  }

  private async rescheduleAll(): Promise<void> {
    for (const automationId of this.handles.keys()) {
      this.deactivate(automationId);
    }
    for (const automation of this.store.listSchedulable()) {
      this.schedule(automation);
    }
  }
}
