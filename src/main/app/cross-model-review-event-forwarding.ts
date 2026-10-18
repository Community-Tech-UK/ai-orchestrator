import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { CrossModelReviewService } from '../orchestration/cross-model-review-service';

/** Keep review push wiring separate from instance lifecycle forwarding. */
export function forwardCrossModelReviewEvents(
  review: CrossModelReviewService,
  renderer: { sendToRenderer(channel: string, data: unknown): void },
): void {
  const channels = {
    'review:started': IPC_CHANNELS.CROSS_MODEL_REVIEW_STARTED,
    'review:result': IPC_CHANNELS.CROSS_MODEL_REVIEW_RESULT,
    'review:discarded': IPC_CHANNELS.CROSS_MODEL_REVIEW_DISCARDED,
    'review:all-unavailable': IPC_CHANNELS.CROSS_MODEL_REVIEW_ALL_UNAVAILABLE,
    'review:reviewer-unavailable': IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_UNAVAILABLE,
    'review:reviewer-rate-limited': IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_RATE_LIMITED,
    'review:reviewer-rate-limit-cleared': IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_RATE_LIMIT_CLEARED,
    'review:skipped': IPC_CHANNELS.CROSS_MODEL_REVIEW_SKIPPED,
  };
  for (const [event, channel] of Object.entries(channels)) {
    review.on(event, (data) => renderer.sendToRenderer(channel, data));
  }
}
