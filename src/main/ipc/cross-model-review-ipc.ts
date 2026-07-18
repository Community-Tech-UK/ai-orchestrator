/**
 * Cross-Model Review IPC Handlers
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  ReviewDismissPayloadSchema,
  ReviewActionPayloadSchema,
} from '../../shared/validation/cross-model-review-schemas';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getLogger } from '../logging/logger';
import { getReviewResultConcernItems } from '../../shared/utils/cross-model-review-concerns';
import { validatedHandler, type IpcResponse } from './validated-handler';

const logger = getLogger('CrossModelReviewIPC');

interface CrossModelReviewHandlerDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerCrossModelReviewIpcHandlers(
  deps: CrossModelReviewHandlerDeps = {},
): void {
  registerReviewHandler(
    IPC_CHANNELS.CROSS_MODEL_REVIEW_DISMISS,
    ReviewDismissPayloadSchema,
    (payload) => {
      logger.debug('Review dismissed', { reviewId: payload.reviewId });
    },
    deps,
  );

  registerReviewHandler(
    IPC_CHANNELS.CROSS_MODEL_REVIEW_ACTION,
    ReviewActionPayloadSchema,
    async (payload) => {
      const service = getCrossModelReviewService();

      switch (payload.action) {
        case 'ask-primary': {
          const history = service.getReviewHistory(payload.instanceId);
          const review = history.find(r => r.id === payload.reviewId);
          if (review) {
            const concerns = review.reviews
              .flatMap(getReviewResultConcernItems)
              .filter(Boolean);
            return { action: 'ask-primary', concerns };
          }
          return { action: 'ask-primary', concerns: [] };
        }
        case 'start-debate': {
          const review = service.getReviewHistory(payload.instanceId)
            .find(entry => entry.id === payload.reviewId);
          const reviewContext = service.getReviewContext(payload.reviewId);

          if (!review || !reviewContext) {
            return { action: 'start-debate', started: false };
          }

          const issues = review.reviews
            .flatMap(getReviewResultConcernItems)
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
            { instanceId: payload.instanceId, provider: reviewContext.primaryProvider },
          );

          return { action: 'start-debate', debateId };
        }
        default:
          return { action: payload.action };
      }
    },
    deps,
  );

  registerReviewHandler(
    IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS,
    z.undefined().optional(),
    () => getCrossModelReviewService().getStatus(),
    deps,
  );
}

function registerReviewHandler<TPayload, TResult>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (payload: TPayload) => TResult | Promise<TResult>,
  deps: CrossModelReviewHandlerDeps,
): void {
  ipcMain.handle(
    channel,
    validatedHandler(
      channel,
      schema,
      async (payload) => {
        const data = await call(payload);
        return data === undefined
          ? { success: true }
          : { success: true, data };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: `${channel.replace(/[:-]/g, '_').toUpperCase()}_FAILED`,
      },
    ),
  );
}
