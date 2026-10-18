import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { CrossModelReviewSkippedEventSchema, CrossModelReviewResultEventSchema } from '@contracts/schemas/instance';
import { validateRendererEventPayload } from '../event-bus/renderer-event-validation';
import { createOrchestrationDomain } from '../../preload/domains/orchestration.preload';
import { forwardCrossModelReviewEvents } from './cross-model-review-event-forwarding';
import type { CrossModelReviewService } from '../orchestration/cross-model-review-service';
import type { IpcRenderer } from 'electron';

describe('second-opinion event transport', () => {
  const payload = { instanceId: 'session', reason: 'daily-limit', dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } };
  it('forwards the skipped event and validates its exact shape including zero limits', () => {
    const review = new EventEmitter(); const sendToRenderer = vi.fn();
    forwardCrossModelReviewEvents(review as CrossModelReviewService, { sendToRenderer });
    review.emit('review:skipped', payload);
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.CROSS_MODEL_REVIEW_SKIPPED, payload);
    expect(CrossModelReviewSkippedEventSchema.safeParse(payload).success).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_SKIPPED, payload)).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_SKIPPED, { ...payload, dailyUsage: { ...payload.dailyUsage, used: -1 } })).toBe(false);
    expect(CrossModelReviewSkippedEventSchema.safeParse({ ...payload, dailyUsage: { ...payload.dailyUsage, limit: 0 } }).success).toBe(true);
  });
  it('accepts turnSeq on the strict aggregated result', () => {
    expect(CrossModelReviewResultEventSchema.safeParse({ id: 'r', instanceId: 's', outputType: 'code', reviewDepth: 'structured', reviews: [], hasDisagreement: false, timestamp: 1, turnSeq: 2 }).success).toBe(true);
  });
  it('preload exposes the request and skipped listener on canonical channels', () => {
    const invoke = vi.fn(); const on = vi.fn();
    const api = createOrchestrationDomain({ invoke, on } as unknown as IpcRenderer, IPC_CHANNELS);
    api.crossModelReviewRequest({ instanceId: 'session' });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CROSS_MODEL_REVIEW_REQUEST, { instanceId: 'session' });
    const callback = vi.fn(); api.crossModelReviewOnSkipped(callback);
    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.CROSS_MODEL_REVIEW_SKIPPED, expect.any(Function));
    on.mock.calls[0][1]({}, payload); expect(callback).toHaveBeenCalledWith(payload);
  });
});
