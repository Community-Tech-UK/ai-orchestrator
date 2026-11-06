import type { AutomationRun, AutomationSchedule } from '../../../../shared/types/automation.types';
import { estimateDailyRuns } from '../../../../shared/automations/automation-cadence';
import { isQuietRun } from './automation-run-presentation';

export interface AutomationRunDisplay {
  label: string;
  detail: string | null;
  quiet: boolean;
}

/** Keep the raw result available below each plain-language run label. */
export function describeRun(run: AutomationRun): AutomationRunDisplay {
  const detail = run.error || run.outputSummary || null;
  // The agent itself reported nothing needed action (automation_result), independent of any pre-check.
  if (isQuietRun(run)) return { label: 'Nothing needed action', detail, quiet: true };
  switch (run.outcome) {
    case 'no-change': return { label: 'Nothing changed', detail, quiet: true };
    case 'quiet': return { label: 'Quiet', detail, quiet: true };
    case 'check-failed': return { label: 'Check failed', detail, quiet: false };
    default: return { label: run.status, detail, quiet: false };
  }
}

export function runRowClass(run: AutomationRun): string {
  return `run-row run-row--${run.status}${describeRun(run).quiet ? ' run-row--quiet' : ''}`;
}

/** The backend records outcome only when a pre-check or quiet rule ran. */
export function describeCheckStatsLine(runs: AutomationRun[]): string {
  const counted = runs.slice(0, 50);
  let checked = 0;
  let started = 0;
  let unknown = 0;
  for (const run of counted) {
    // Outcome records a check result, not whether creation returned an AI.
    // The durable attachment survives terminal failures and session removal.
    if (run.configSnapshot?.destination.kind === 'thread') {
      if (run.threadPromptDelivered === true) started += 1;
      else if (run.instanceId && run.threadPromptDelivered == null) unknown += 1;
    } else if (run.instanceId || run.loopRunId) started += 1;
    const quietAfterCheck = run.outcome === 'quiet'
      && (run.trigger === 'scheduled' || run.trigger === 'catchUp')
      && (run.attempt ?? 1) === 1 && Boolean(run.configSnapshot?.action.preCheck);
    if ((run.outcome && run.outcome !== 'quiet') || quietAfterCheck) checked += 1;
  }
  const coverage = unknown ? ` (${unknown} ${unknown === 1 ? 'run' : 'runs'} could not be confirmed)` : '';
  return `Last ${counted.length} ${counted.length === 1 ? 'run' : 'runs'}: checked ${checked} ${checked === 1 ? 'time' : 'times'}, started the AI ${unknown ? 'at least ' : ''}${started} ${started === 1 ? 'time' : 'times'}${coverage}`;
}

export function describeDailyRunsLine(schedule: AutomationSchedule): string {
  try {
    const estimate = estimateDailyRuns(schedule);
    return `Starts the AI about ${estimate} ${estimate === 1 ? 'time' : 'times'} a day`;
  } catch {
    return 'Enter a valid schedule to estimate how often the AI starts.';
  }
}
