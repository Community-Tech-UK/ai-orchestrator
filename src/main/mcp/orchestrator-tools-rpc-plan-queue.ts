import { PLAN_QUEUE_CLI_METHODS, PlanQueueCliMovePayloadSchema, PlanQueueCliMoveResultSchema } from './plan-queue-cli-contracts';
import type { PlanQueueToolOperations } from './plan-queue-tools';

export function isPlanQueueCliRpcMethod(method: string): boolean {
  return Object.values(PLAN_QUEUE_CLI_METHODS).some(value => value === method);
}

/** `callerInstanceId` is the RPC-authenticated session, never a payload field. */
export async function dispatchPlanQueueCliRpc(method: string, callerInstanceId: string, payload: Record<string, unknown>,
  operations: PlanQueueToolOperations | null): Promise<unknown> {
  if (!operations) throw new Error('Plan Queue is unavailable');
  if (method !== PLAN_QUEUE_CLI_METHODS.move) throw new Error('Unknown plan-queue command');
  const { runId, targetInstanceId } = PlanQueueCliMovePayloadSchema.parse(payload);
  const { ownerInstanceId } = await operations.moveRun(callerInstanceId, runId, targetInstanceId ?? callerInstanceId);
  return PlanQueueCliMoveResultSchema.parse({ runId, ownerInstanceId: ownerInstanceId === callerInstanceId ? null : ownerInstanceId });
}
