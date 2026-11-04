import type { EventEmitter } from 'node:events';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { isModelCallCancelled, observeModelCallUsage } from '../core/system/observed-model-call-usage';
import { purposeOf } from '../core/system/cost-attribution';
import { recordModelCall } from '../core/system/model-call-recorder';
import type { ModelCallOutcome } from '../../shared/types/cost-attribution.types';
import { deferUntilResponseUsageSettled } from '../cli/adapters/deferred-response-usage';
export { waitForCompletionUsage } from '../instance/communication-completion-cost';

interface CallContext {
  taskType: string;
  provider: string;
  model?: string;
  correlationId: string;
  instanceId?: string;
  outcomeForResponse?: (response: CliResponse) => ModelCallOutcome;
}

/** The caller enters this seam only when it actually calls a send method. */
export async function sendRecordedOrchestrationCall(
  adapter: Partial<Pick<EventEmitter, 'on' | 'off'>>,
  context: CallContext,
  send: () => Promise<CliResponse>,
): Promise<CliResponse> {
  const purpose = context.taskType.startsWith('loop-branch:') ? 'branch-select' : purposeOf(context);
  const { outcomeForResponse, ...recordContext } = context;
  const record = { ...recordContext, purpose: purpose === 'unknown' ? 'workflow' as const : purpose };
  const observed = observeModelCallUsage(adapter);
  try {
    const response = await send();
    const recordSettled = () => {
      const settled = observeModelCallUsage(undefined);
      settled.observe(observed.usage);
      settled.observe(response.usage);
      recordModelCall({ ...record, usage: settled.usage, isEstimated: settled.usage?.isEstimated,
        outcome: outcomeForResponse?.(response) ?? (response.metadata?.['budgetExceeded'] === true ? 'budget-exceeded'
          : response.degradedReason === 'cancelled' ? 'cancelled' : 'success') });
    };
    if (!deferUntilResponseUsageSettled(response, recordSettled)) recordSettled();
    return response;
  } catch (error) {
    observed.observeError(error);
    if (observed.dispatched) recordModelCall({ ...record, usage: observed.usage, isEstimated: observed.usage?.isEstimated,
      outcome: isModelCallCancelled(error) ? 'cancelled' : 'error' });
    throw error;
  } finally {
    observed.dispose();
  }
}
