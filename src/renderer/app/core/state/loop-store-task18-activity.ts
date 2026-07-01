import type { LoopStatePayload } from '@contracts/schemas/loop';
import type {
  LoopActivityPayload,
  LoopFollowUpDrainedPayload,
  LoopSteeringDowngradedPayload,
} from '../services/ipc/loop-ipc.service';

export function steeringDowngradedActivity(
  event: LoopSteeringDowngradedPayload,
  state: LoopStatePayload | undefined,
): LoopActivityPayload {
  return {
    loopRunId: event.loopRunId,
    seq: state?.totalIterations ?? 0,
    stage: state?.currentStage ?? '',
    kind: 'status',
    message: 'Live steering unavailable; queued for the next iteration',
    timestamp: Date.now(),
    detail: {
      reason: event.reason,
      requestedKind: event.requestedKind,
      effectiveKind: event.effectiveKind,
    },
  };
}

export function followUpDrainedActivity(
  event: LoopFollowUpDrainedPayload,
  state: LoopStatePayload | undefined,
): LoopActivityPayload {
  return {
    loopRunId: event.loopRunId,
    seq: event.seq,
    stage: state?.currentStage ?? '',
    kind: 'status',
    message: event.remaining > 0
      ? `Queued follow-up drained (${event.count}); ${event.remaining} remaining`
      : `Queued follow-up drained (${event.count})`,
    timestamp: Date.now(),
    detail: { count: event.count, remaining: event.remaining },
  };
}
