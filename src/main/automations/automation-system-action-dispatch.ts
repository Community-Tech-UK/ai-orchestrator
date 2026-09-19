import type { AutomationRun, ClaimedAutomationRun } from '../../shared/types/automation.types';
import { getLogger } from '../logging/logger';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getLoopStore } from '../orchestration/loop-store';
import { resumeLoopRun } from '../orchestration/loop-resume';
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
export async function dispatchAutomationSystemAction(
  claimed: ClaimedAutomationRun,
  deps: { store: AutomationStore; now: () => number },
): Promise<AutomationRun | null> {
  const action = claimed.snapshot.action.systemAction;
  if (!action) return null;

  if (action.type === 'loopProviderLimitResume') {
    // This automation exists precisely because the loop parked for hours. The
    // app is very likely to have restarted in the meantime, which drops the
    // coordinator's in-memory state and makes a bare `resumeLoop` a silent
    // no-op — so go through the shared restore-then-resume sequence instead.
    const { resumed, reason } = await resumeParkedLoop(action.loopRunId);
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
      resumed ? undefined : (reason ?? `Loop ${action.loopRunId} is not paused or active`),
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

/**
 * Resume a parked loop for an automation, re-hydrating it from its checkpoint
 * when the coordinator no longer holds it. A restore fault (for example an
 * isolated loop whose managed worktree is gone) is reported as a failed
 * resume with its message rather than thrown: the automation runner must
 * still terminalize the run or fall through to its thread wakeup.
 */
async function resumeParkedLoop(
  loopRunId: string,
): Promise<{ resumed: boolean; reason?: string }> {
  try {
    const outcome = await resumeLoopRun(getLoopCoordinator(), getLoopStore(), loopRunId);
    return { resumed: outcome.ok, reason: outcome.reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Loop provider-limit resume failed while restoring the loop', {
      loopRunId,
      error: reason,
    });
    return { resumed: false, reason };
  }
}
