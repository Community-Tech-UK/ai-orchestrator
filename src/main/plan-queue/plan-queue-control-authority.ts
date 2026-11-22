/**
 * Who may answer or control a Plan Queue run.
 *
 * The panel (no caller) and the session that started the run (the parent) act
 * as James. Every other MCP caller is refused, with these exceptions.
 *
 * Discard: any session the queue did not spawn may discard a parked item or undo
 * a discard, whoever owns the run. Discard keeps the work (plan-queue-discard.ts).
 *
 * Stranded-run rescue: session ids are not kept across restarts, so once the
 * parent is gone no MCP caller could stop the run, which would keep its
 * documents locked indefinitely. Any session that the queue did not spawn may
 * then adopt or cancel the run. The audit trail records the
 * rescuer in each affected item's detail and in the log. A missing or
 * edit-superseded source can be rescued after restored-parent resolution.
 * A sleeping, idle or failed retained owner keeps the run; handover requires
 * that owner's explicit control or the operator panel.
 *
 * Set aside agent: the session James starts from the Set aside tab may also skip,
 * resume, retry the merge of, or merge without checks any job, in any folder.
 * Otherwise it is an ordinary session: it may start runs, adopt a run whose parent
 * session is gone, ask for a handover, and control a run it owns as its owner. It
 * clears empty jobs through plan-queue-set-aside.ts.
 */

import type { PlanQueueControlPayload } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueControlAuthority');

const NOT_PARENT = 'Only the session that started this Plan Queue run may do that';

type PlanQueueControlAction = PlanQueueControlPayload['action'];

/** Control actions another session may take once a run's parent session is gone. */
export const STRANDED_RESCUE_ACTIONS: ReadonlySet<PlanQueueControlAction> = new Set<PlanQueueControlAction>([
  'adopt',
  'cancel',
]);

/** Control actions any session the queue did not spawn may take, whoever owns the run. */
const DISCARD_ACTIONS: ReadonlySet<PlanQueueControlAction> = new Set<PlanQueueControlAction>([
  'discard-item',
  'restore-discarded',
]);

/** Control actions the Set aside agent may take on any run, besides those every session may take. */
const SET_ASIDE_AGENT_ACTIONS: ReadonlySet<PlanQueueControlAction> = new Set<PlanQueueControlAction>([
  ...DISCARD_ACTIONS,
  'skip-item',
  'resume-item',
  'retry-landing',
  'land-anyway',
]);

export interface PlanQueueCallerLookup {
  instanceExists(instanceId: string): boolean;
  isQueueInstance(instanceId: string): boolean;
  /** The folder a Set aside agent was started for; undefined for every other session. */
  setAsideFolder(instanceId: string): string | undefined;
}

/** @param callerInstanceId set for MCP callers, who must be the run's parent session. */
export function assertPlanQueueParent(run: PlanQueueRun, callerInstanceId: string | undefined): void {
  if (callerInstanceId !== undefined && callerInstanceId !== run.parentInstanceId) {
    throw new Error(NOT_PARENT);
  }
}

/**
 * Authorise a control action and return the actor named in the items' audit
 * detail ("James" for the panel and the parent session).
 */
export function authorizePlanQueueControl(
  run: PlanQueueRun,
  action: PlanQueueControlAction,
  callerInstanceId: string | undefined,
  lookup: PlanQueueCallerLookup,
): string {
  if (action === 'request-handover') {
    if (!callerInstanceId || !lookup.instanceExists(callerInstanceId) || lookup.isQueueInstance(callerInstanceId)) {
      throw new Error('A handover request requires a live session that the queue did not spawn');
    }
    return `session ${callerInstanceId}`;
  }
  if (action === 'adopt') {
    if (lookup.instanceExists(run.parentInstanceId)) throw new Error('This run still has a live parent; it cannot be adopted');
    if (!callerInstanceId || !lookup.instanceExists(callerInstanceId) || lookup.isQueueInstance(callerInstanceId)) {
      throw new Error('Adopt requires a live session that the queue did not spawn');
    }
  }
  if (callerInstanceId === undefined) return 'James';
  // Checked before ownership so the audit trail names the agent, not James, on runs it started or adopted too.
  if (SET_ASIDE_AGENT_ACTIONS.has(action) && lookup.setAsideFolder(callerInstanceId) !== undefined) {
    return `the Set aside agent (session ${callerInstanceId})`;
  }
  if (callerInstanceId === run.parentInstanceId) return 'James';
  if (DISCARD_ACTIONS.has(action) && !lookup.isQueueInstance(callerInstanceId)) {
    logger.info('Plan queue: a session other than the owner discarded or restored a job', { runId: run.id, action, callerInstanceId });
    return `session ${callerInstanceId}`;
  }
  const strandedRescuer = !lookup.instanceExists(run.parentInstanceId) && !lookup.isQueueInstance(callerInstanceId);
  if (strandedRescuer && STRANDED_RESCUE_ACTIONS.has(action)) {
    logger.warn('Plan queue: stranded-run rescue authorised for a session other than the parent', {
      runId: run.id,
      action,
      callerInstanceId,
      parentInstanceId: run.parentInstanceId,
    });
    return `session ${callerInstanceId}, because the session that started the run (${run.parentInstanceId}) no longer exists`;
  }
  throw new Error(strandedRescuer
    ? `${NOT_PARENT}. That session no longer exists. Use action "adopt" to take over the run so its items keep going; cancel only if James asked you to stop it.`
    : NOT_PARENT);
}
