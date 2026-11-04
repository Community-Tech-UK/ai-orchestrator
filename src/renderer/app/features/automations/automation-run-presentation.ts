import type { Automation, AutomationRun } from '../../../../shared/types/automation.types';

export function isQuietRun(run: AutomationRun): boolean {
  return run.status === 'succeeded' && run.result?.outcome === 'no_change' && !run.result.notify;
}
export function monitorSuggestion(automation: Automation): boolean {
  const state = automation.monitorState;
  return Boolean(state && state.quietRuns >= 10 && !state.modelHintDismissed
    && !(automation.action.model === 'sonnet' && automation.action.reasoningEffort === 'low'));
}
export function nextCheckExplanation(automation: Automation, now = Date.now()): string {
  if (automation.nextFireAt === null) return 'No check scheduled';
  const minutes = Math.max(0, Math.ceil((automation.nextFireAt - now) / 60_000));
  const state = automation.monitorState;
  return `Next check in ${minutes} min${state && state.intervalMultiplier > 1 ? ` (no change for ${state.unchangedChecks} checks)` : ''}`;
}
