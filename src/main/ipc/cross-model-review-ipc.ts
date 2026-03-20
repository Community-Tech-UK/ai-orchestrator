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
        return { action: 'start-debate', reviewId: validated.reviewId };
      default:
        return { success: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS, async () => {
    return getCrossModelReviewService().getStatus();
  });
}
