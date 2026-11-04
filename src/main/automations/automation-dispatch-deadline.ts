import { scheduleAutomationDeadline } from './automation-deadline-timer';
import type { AutomationRun } from '../../shared/types/automation.types';
import { withRunLimits } from './automation-run-policy';

/** Cover admission, network and creation waits before an instance/loop owns the run's watchdog. */
export class AutomationDispatchDeadline {
  private readonly timers = new Map<string, () => void>();
  constructor(private readonly now: () => number, private readonly expire: (run: AutomationRun, reason: string) => void) {}
  arm(run: AutomationRun): void {
    this.clear(run.id);
    if (!run.configSnapshot || this.expireIfElapsed(run)) return;
    const action = withRunLimits(run.configSnapshot.action, run.configSnapshot.schedule);
    const minutes = action.maxRunMinutes!;
    const deadline = (run.startedAt ?? this.now()) + minutes * 60_000;
    const timer = scheduleAutomationDeadline(deadline, this.now, () => { this.clear(run.id); this.expire(run, `Stopped after ${minutes} minutes`); });
    this.timers.set(run.id, timer);
  }
  /** A zero-delay timer cannot fence microtasks or a resumed provider admission. */
  expireIfElapsed(run: AutomationRun): boolean {
    if (!run.configSnapshot || run.startedAt == null) return false;
    const minutes = withRunLimits(run.configSnapshot.action, run.configSnapshot.schedule).maxRunMinutes!;
    if (this.now() < run.startedAt + minutes * 60_000) return false;
    this.clear(run.id);
    this.expire(run, `Stopped after ${minutes} minutes`);
    return true;
  }
  clear(runId: string): void {
    const timer = this.timers.get(runId); if (timer) timer();
    this.timers.delete(runId);
  }
}
