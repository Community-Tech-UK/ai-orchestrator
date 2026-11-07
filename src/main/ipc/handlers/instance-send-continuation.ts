import type { InstanceSendInputPayload } from '@contracts/schemas/instance';
import type { FileAttachment } from '../../../shared/types/instance.types';
import { buildInterruptedContext, SAFE_CONTINUATION, type ContinuationMessage } from '../../../shared/turn-continuation';
import { getInterruptedContextQueue, type InterruptedContextQueue } from '../../instance/instance-interrupted-context';

interface ContinuationDispatch {
  getInstance(id: string): { lastTurnOutcome?: string; status?: string; activeTurnId?: string; waitReason?: unknown; outputBuffer: ContinuationMessage[]; retainedPrompts?: ContinuationMessage[] } | undefined;
  sendInput(id: string, message: string, attachments?: FileAttachment[], options?: { isRetry?: boolean; userMessageId?: string; automatedInput?: boolean; queuedAdmissionId?: string; origin?: InstanceSendInputPayload['origin'] }): Promise<void>;
}

export async function sendInstanceInput(
  manager: ContinuationDispatch,
  payload: InstanceSendInputPayload,
  interruptedContext: Pick<InterruptedContextQueue, 'queue'> = getInterruptedContextQueue(),
): Promise<void> {
  let discardContext: (() => void) | undefined;
  if (payload.continueInterrupted) {
    const instance = manager.getInstance(payload.instanceId);
    if (!instance || !['interrupted', 'cancelled'].includes(instance.lastTurnOutcome ?? '')) {
      throw new Error('This turn is no longer interrupted. Check the latest reply before continuing.');
    }
    if (instance.activeTurnId || instance.waitReason || (instance.status && ['busy', 'running', 'initializing', 'respawning', 'waking', 'terminated', 'waiting_for_permission'].includes(instance.status))) {
      throw new Error('This session is not ready to continue yet.');
    }
    const retained = instance.retainedPrompts?.filter(message => message.type === 'user' && !message.metadata?.['internalInput']).at(-1)?.content;
    discardContext = interruptedContext.queue(payload.instanceId, buildInterruptedContext(instance.outputBuffer, retained));
  }
  try {
    await manager.sendInput(
      payload.instanceId,
      payload.continueInterrupted ? SAFE_CONTINUATION : payload.message,
      payload.attachments?.map(attachment => ({ ...attachment, data: attachment.data ?? '' })),
      { isRetry: payload.isRetry, userMessageId: payload.userMessageId, automatedInput: payload.automatedInput, queuedAdmissionId: payload.queuedAdmissionId, origin: payload.origin },
    );
  } catch (error) {
    discardContext?.();
    throw error;
  }
}
