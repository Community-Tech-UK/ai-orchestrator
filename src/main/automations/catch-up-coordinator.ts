import { getLogger } from '../logging/logger';
import type { Automation } from '../../shared/types/automation.types';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { computeMissedFireTimes } from './automation-schedule';
import { getAutomationEvents } from './automation-events';

const logger = getLogger('CatchUpCoordinator');
const RESUME_FALLBACK_LOOKBACK_MS = 10 * 60 * 1000;

export class CatchUpCoordinator {
  constructor(
    private readonly store: AutomationStore,
    private readonly runner: AutomationRunner,
    private readonly events = getAutomationEvents(),
    private readonly now = () => Date.now(),
  ) {}

  async runStartupSweep(startedAt = this.now()): Promise<void> {
    await this.runSweep({ kind: 'startup', sinceFallback: 0, until: startedAt });
  }

  async runResumeSweep(params: { suspendedAt: number | null; resumedAt: number }): Promise<void> {
    const sinceFallback = params.suspendedAt ?? params.resumedAt - RESUME_FALLBACK_LOOKBACK_MS;
    await this.runSweep({ kind: 'resume', sinceFallback, until: params.resumedAt });
  }

  private async runSweep(params: {
    kind: 'startup' | 'resume';
    sinceFallback: number;
    until: number;
  }): Promise<void> {
    const automations = await this.store.list();
    for (const automation of automations) {
      if (!automation.active || !automation.enabled) {
        continue;
      }

      const since = this.getSweepBaseline(automation, params.sinceFallback);
      const missed = computeMissedFireTimes(automation.schedule, since, params.until);
      if (missed.length === 0) {
        continue;
      }

      logger.info('Automation missed fire times detected', {
        automationId: automation.id,
        count: missed.length,
        policy: automation.missedRunPolicy,
        sweep: params.kind,
      });

      if (automation.missedRunPolicy === 'runOnce') {
        await this.runner.fire(automation.id, {
          trigger: 'catchUp',
          scheduledAt: missed[missed.length - 1],
        });
        continue;
      }

      const reason = automation.missedRunPolicy === 'notify'
        ? 'Automation run was missed while the app was unavailable'
        : 'Automation run was skipped by missed-run policy';

      for (const fireTime of missed) {
        const run = this.store.recordSkipped(automation, 'catchUp', fireTime, reason, this.now());
        this.events.emitRunChanged({ automationId: automation.id, run });
        this.events.emitRunTerminal({ automationId: automation.id, runId: run.id, status: 'skipped' });
      }

      if (automation.schedule.type === 'oneTime') {
        this.store.completeOneTime(automation.id, this.now());
        const completed = await this.store.get(automation.id);
        this.events.emitChanged({ automation: completed, automationId: automation.id, type: 'updated' });
        this.events.emitScheduleDeactivated({ automationId: automation.id });
      }
    }
  }

  private getSweepBaseline(automation: Automation, fallback: number): number {
    if (automation.lastFiredAt !== null) {
      return automation.lastFiredAt;
    }

    if (automation.schedule.type === 'oneTime') {
      return Math.min(automation.createdAt, automation.schedule.runAt - 1);
    }

    return Math.max(automation.createdAt, fallback);
  }
}
