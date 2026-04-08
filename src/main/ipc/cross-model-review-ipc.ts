/**
 * Cross-Model Review IPC Handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  ReviewDismissPayloadSchema,
  ReviewActionPayloadSchema,
} from '../../shared/validation/cross-model-review-schemas';
import { validateIpcPayload } from '../../shared/validation/ipc-schemas';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getLogger } from '../logging/logger';

const logger = getLogger('CrossModelReviewIPC');

export function registerCrossModelReviewIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_DISMISS, async (_event, payload) => {
    const validated = validateIpcPayload(ReviewDismissPayloadSchema, payload, 'CROSS_MODEL_REVIEW_DISMISS');
    logger.debug('Review dismissed', { reviewId: validated.reviewId });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_ACTION, async (_event, payload) => {
    const validated = validateIpcPayload(ReviewActionPayloadSchema, payload, 'CROSS_MODEL_REVIEW_ACTION');
    const service = getCrossModelReviewService();

    switch (validated.action) {
      case 'ask-primary': {
        const history = service.getReviewHistory(validated.instanceId);
        const review = history.find(r => r.id === validated.reviewId);
        if (review) {
          const concerns = review.reviews
            .flatMap(r => Object.values(r.scores).flatMap(s => s?.issues ?? []))
            .filter(Boolean);
          return { action: 'ask-primary', concerns };
        }
        return { action: 'ask-primary', concerns: [] };
      }
      case 'start-debate':
      {
        const review = service.getReviewHistory(validated.instanceId)
          .find(entry => entry.id === validated.reviewId);
        const reviewContext = service.getReviewContext(validated.reviewId);

        if (!review || !reviewContext) {
          return { action: 'start-debate', started: false };
        }

        const issues = review.reviews
          .flatMap(result => Object.values(result.scores).flatMap(score => score?.issues ?? []))
          .filter(Boolean);

        const summaries = review.reviews.map(result => `${result.reviewerId}: ${result.summary}`);
        const debateContext = [
          `Task context:\n${reviewContext.taskDescription}`,
          `Primary output under review:\n${reviewContext.content}`,
          issues.length > 0
            ? `Reviewer concerns:\n${issues.map(issue => `- ${issue}`).join('\n')}`
            : `Reviewer summaries:\n${summaries.map(summary => `- ${summary}`).join('\n')}`,
        ].join('\n\n');

        const debateId = await getDebateCoordinator().startDebate(
          `Should the primary ${review.outputType} response be revised based on the cross-model review findings?`,
          debateContext,
          undefined,
          { instanceId: validated.instanceId, provider: reviewContext.primaryProvider },
        );

        return { action: 'start-debate', debateId };
      }
      default:
        return { success: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS, async () => {
    return getCrossModelReviewService().getStatus();
  });
}
