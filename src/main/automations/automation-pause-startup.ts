import { AutomationStopAttempts } from './automation-stop-attempts';
import { getWorkAdmission } from '../work-admission/work-admission';
import { addAutomaticStartupCheck, AutomaticStartupCancelledError, isAutomaticStartupCancelled, runAutomaticStartup, type AutomaticStartup } from '../work-admission/automatic-startup';

export class AutomationDeadlineCancelledError extends AutomaticStartupCancelledError {
  constructor() { super(); this.message = 'Scheduled job reached its run limit'; this.name = 'AutomationDeadlineCancelledError'; }
}
/** Coalesce delayed network callbacks with explicit Resume for one durable run. */
export class AutomationPauseStartup {
  private readonly cancelActive = new Map<string, () => void>();
  private readonly paused = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly stoppingRuns = new Set<string>();
  private readonly stops: AutomationStopAttempts;
  constructor(reportStopFailure: (runId: string) => void = () => undefined) { this.stops = new AutomationStopAttempts(reportStopFailure); }
  isStoppingAutomation(id: string, automationForRun: (runId: string) => string | undefined): boolean { return [...this.stoppingRuns].some(runId => automationForRun(runId) === id); }

  pause(runId: string): void {
    this.paused.add(runId);
    const admission = getWorkAdmission();
    admission.cancelDeferred(`automation-dispatch:${runId}`);
    admission.cancelDeferred(`automation-retry:${runId}`);
  }

  cancel(runId: string): void { this.pause(runId); this.cancelActive.get(runId)?.(); }

  resume(runId: string): void { this.paused.delete(runId); }

  run(runId: string, operation: (startup: AutomaticStartup) => Promise<void>, paused: () => void, current: () => boolean): Promise<void> {
    if (this.paused.has(runId)) return Promise.resolve();
    const existing = this.pending.get(runId);
    if (existing) return existing;
    let signal: AbortSignal | undefined;
    const abort = new AbortController();
    let stop: (() => Promise<void>) | undefined;
    const requestStop = (): void => {
      if (!stop) return;
      const terminate = stop;
      this.stoppingRuns.add(runId);
      this.stops.request(runId, async () => { await terminate(); this.stoppingRuns.delete(runId); });
    };
    this.cancelActive.set(runId, () => { abort.abort(new AutomationDeadlineCancelledError()); requestStop(); });
    const result = runAutomaticStartup(startup => {
      addAutomaticStartupCheck(current);
      signal = AbortSignal.any([startup.signal, abort.signal]);
      return operation({ ...startup, signal, register: (instance, terminate) => {
        stop = terminate; startup.register(instance, terminate); signal!.throwIfAborted();
      } });
    }).catch(error => {
      if (!isAutomaticStartupCancelled(error) && !signal?.aborted) throw error;
      paused();
    }).finally(async () => {
      if (abort.signal.aborted) requestStop();
      this.cancelActive.delete(runId);
      if (this.pending.get(runId) === result) this.pending.delete(runId);
    });
    this.pending.set(runId, result);
    return result;
  }
}
