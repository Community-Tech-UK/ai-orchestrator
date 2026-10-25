import { getWorkAdmission } from '../work-admission/work-admission';
import { isAutomaticStartupCancelled, runAutomaticStartup, type AutomaticStartup } from '../work-admission/automatic-startup';

/** Coalesce delayed network callbacks with explicit Resume for one durable run. */
export class AutomationPauseStartup {
  private readonly paused = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  pause(runId: string): void {
    this.paused.add(runId);
    const admission = getWorkAdmission();
    admission.cancelDeferred(`automation-dispatch:${runId}`);
    admission.cancelDeferred(`automation-retry:${runId}`);
  }

  resume(runId: string): void { this.paused.delete(runId); }

  run(runId: string, operation: (startup: AutomaticStartup) => Promise<void>, paused: () => void): Promise<void> {
    if (this.paused.has(runId)) return Promise.resolve();
    const existing = this.pending.get(runId);
    if (existing) return existing;
    let signal: AbortSignal | undefined;
    const result = runAutomaticStartup(startup => { signal = startup.signal; return operation(startup); }).catch(error => {
      if (!isAutomaticStartupCancelled(error) && !signal?.aborted) throw error;
      paused();
    }).finally(() => { if (this.pending.get(runId) === result) this.pending.delete(runId); });
    this.pending.set(runId, result);
    return result;
  }
}
