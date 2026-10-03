/**
 * Who may answer or control a Plan Queue run.
 *
 * The panel (no caller) and the session that started the run (the parent) act
 * as James. Every other MCP caller is refused, with one exception.
 *
 * Stranded-run rescue: session ids are not kept across restarts, so once the
 * parent is gone no MCP caller could stop the run, which would keep its
 * documents locked indefinitely. Any session that the queue did not spawn may
 * then cancel the run or discard a parked item. The audit trail records the
 * rescuer in each affected item's detail and in the log. "Gone" means absent
 * from the instance manager: a parent that still exists, even in a failed
 * state, keeps the run until it is removed.
 */

import type { PlanQueueControlPayload } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueControlAuthority');

const NOT_PARENT = 'Only the session that started this Plan Queue run may do that';

type PlanQueueControlAction = PlanQueueControlPayload['action'];

/** Control actions another session may take once a run's parent session is gone. */
export const STRANDED_RESCUE_ACTIONS: ReadonlySet<PlanQueueControlAction> = new Set<PlanQueueControlAction>([
  'cancel',
  'discard-item',
]);

export interface PlanQueueCallerLookup {
  instanceExists(instanceId: string): boolean;
  isQueueInstance(instanceId: string): boolean;
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
  if (callerInstanceId === undefined || callerInstanceId === run.parentInstanceId) return 'James';
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
    ? `${NOT_PARENT}. That session no longer exists, so another session may only cancel the run or discard a parked item.`
    : NOT_PARENT);
}
