import type { AutomationRun, ClaimedAutomationRun } from '../../shared/types/automation.types';
import { getLogger } from '../logging/logger';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getInstanceProviderLimitHandler } from '../instance/instance-provider-limit-handler';
import type { AutomationStore } from './automation-store';

const logger = getLogger('AutomationSystemActionDispatch');

/**
 * Handle an automation whose action is a `systemAction` (a direct in-process
 * side effect rather than a CLI prompt dispatch). Returns the terminalized run
 * when the action was fully handled, or `null` to fall through to normal prompt
 * dispatch (e.g. a loop that could not be resumed directly but has a thread
 * destination to wake instead).
 *
 * Extracted from AutomationRunner to keep that file within its size ceiling.
 */
export function dispatchAutomationSystemAction(
  claimed: ClaimedAutomationRun,
  deps: { store: AutomationStore; now: () => number },
): AutomationRun | null {
  const action = claimed.snapshot.action.systemAction;
  if (!action) return null;

  if (action.type === 'loopProviderLimitResume') {
    const resumed = getLoopCoordinator().resumeLoop(action.loopRunId);
    if (!resumed && claimed.snapshot.destination.kind === 'thread') {
      logger.warn('Loop provider-limit resume system action could not directly resume; falling back to thread wakeup', {
        automationId: claimed.run.automationId,
        runId: claimed.run.id,
        loopRunId: action.loopRunId,
      });
      return null;
    }
    return deps.store.terminalizeRun(
      claimed.run.id,
      resumed ? 'succeeded' : 'failed',
      resumed ? undefined : `Loop ${action.loopRunId} is not paused or active`,
      resumed
        ? `Loop ${action.loopRunId} resumed after provider quota reset.`
        : `Loop ${action.loopRunId} could not be resumed after provider quota reset.`,
      deps.now(),
    );
  }

  if (action.type === 'instanceProviderLimitResume') {
    // Route back through the handler so the in-session timer and this durable
    // trigger de-dupe. When the instance is live it re-sends directly; when it
    // is not (e.g. a fresh process after restart), fall through to the normal
    // thread-revive + prompt dispatch so the paused work still continues.
    const outcome = getInstanceProviderLimitHandler().resumeFromAutomation(
      action.instanceId,
      action.resumePrompt,
    );
    if (outcome === 'fell-through') return null;
    return deps.store.terminalizeRun(
      claimed.run.id,
      'succeeded',
      undefined,
      `Session ${action.instanceId} resumed after provider quota reset.`,
      deps.now(),
    );
  }

  return null;
}
