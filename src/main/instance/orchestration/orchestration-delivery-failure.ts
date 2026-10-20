import type { OutputMessage } from '../../../shared/types/instance.types';
import { OrchestrationResponseHeldError } from '../../orchestration/orchestration-response-delivery';
import { generateId } from '../../../shared/utils/id-generator';

/**
 * Transcript note for an orchestration response the adapter did not accept.
 * `held` means it waits and is delivered once the session can continue (a
 * usage limit a park or account switch now owns, or a switch replaced the
 * session before it was sent), so it reads as a wait rather than an error.
 */
export function orchestrationDeliveryFailureNote(
  action: string,
  childId: string | undefined,
  error: Error,
  held: boolean,
): OutputMessage {
  const subject = `Orchestration ${action} response${childId ? ` for child ${childId}` : ''}`;
  const replaced = error instanceof OrchestrationResponseHeldError && error.reason === 'respawning';
  return held
    ? {
      id: `orch-held-${generateId()}`, // several reports are often held in the same millisecond
      timestamp: Date.now(),
      type: 'system',
      content: `${subject} is waiting: ${replaced ? 'the session was being restarted' : 'this account reached its usage limit'}. It will be delivered once the session can continue.`,
      metadata: { source: 'orchestration', action, deliveryPending: true, ...(replaced ? {} : { providerLimitHeld: true }), childId },
    }
    : {
      id: `orch-error-${Date.now()}`,
      timestamp: Date.now(),
      type: 'error',
      content: `${subject} was not delivered to the agent: ${error.message}`,
      metadata: { source: 'orchestration', action, deliveryFailure: true, childId },
    };
}

/**
 * Pre-send check for a queued orchestration response. Throws a held error
 * (never sent, so safe to redeliver) when the adapter it was queued for was
 * replaced, or when the session went limited, parked or started switching
 * accounts while the response waited behind earlier writes.
 */
export function assertQueuedResponseDeliverable(sameAdapter: boolean, providerLimitHolds: () => boolean): void {
  if (!sameAdapter) {
    throw new OrchestrationResponseHeldError('Instance adapter changed before orchestration response delivery', 'respawning');
  }
  if (providerLimitHolds()) {
    throw new OrchestrationResponseHeldError('Held before sending: the session account is at a usage limit or moving account');
  }
}
