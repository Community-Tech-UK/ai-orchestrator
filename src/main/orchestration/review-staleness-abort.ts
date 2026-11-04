import type { EventEmitter } from 'node:events';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ReviewDispatchRequest } from './cross-model-review.types';

export type ReviewSource = Pick<ReviewDispatchRequest, 'instanceId' | 'sourceUserTurnEpoch' | 'sourceUserMessageId' | 'sourceUserMessageTimestamp'>;

function latestUser(messages: readonly OutputMessage[] | undefined): OutputMessage | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === 'user') return messages[index];
  }
  return undefined;
}

/** Attachment-only user input and retained prompts still identify a turn. */
export function reviewSourceUserMessage(instance: Pick<Instance, 'outputBuffer' | 'retainedPrompts'> | undefined): OutputMessage | undefined {
  const buffered = latestUser(instance?.outputBuffer);
  const retained = latestUser(instance?.retainedPrompts);
  return !buffered ? retained : retained && retained.timestamp > buffered.timestamp ? retained : buffered;
}

export function captureReviewSource(instanceId: string, instance: Instance | undefined, epoch: number): ReviewSource {
  const user = reviewSourceUserMessage(instance);
  return { instanceId, sourceUserTurnEpoch: epoch, sourceUserMessageId: user?.id, sourceUserMessageTimestamp: user?.timestamp };
}

export function reviewSourceIsCurrent(source: ReviewSource, instance: Instance | undefined, epoch: number): boolean {
  if (source.sourceUserTurnEpoch !== undefined && (!instance || source.sourceUserTurnEpoch !== epoch)) return false;
  const latest = reviewSourceUserMessage(instance);
  if (source.sourceUserMessageId === undefined && source.sourceUserMessageTimestamp === undefined) {
    return latest?.id === undefined && latest?.timestamp === undefined;
  }
  return source.sourceUserMessageId ? latest?.id === source.sourceUserMessageId : latest?.timestamp === source.sourceUserMessageTimestamp;
}

/** Input admission is lossless; status batches may coalesce busy into processing. */
export function attachReviewStalenessAbort(source: Pick<EventEmitter, 'on' | 'off'>,
  review: { abortSupersededReviews(instanceId: string, userTurnStarted?: boolean): void }): () => void {
  const batch = ({ updates }: { updates: { instanceId: string }[] }) => {
    for (const update of updates) review.abortSupersededReviews(update.instanceId);
  };
  const input = ({ instanceId, autoContinuation }: { instanceId: string; autoContinuation?: boolean }) => {
    if (!autoContinuation) review.abortSupersededReviews(instanceId, true);
  };
  source.on('instance:batch-update', batch); source.on('instance:input-started', input);
  return () => { source.off('instance:batch-update', batch); source.off('instance:input-started', input); };
}
