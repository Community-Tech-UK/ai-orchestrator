import type { LoopStatePayload } from '@contracts/schemas/loop';
import type {
  LoopActivityPayload,
  LoopFollowUpDrainedPayload,
  LoopSteeringDowngradedPayload,
  ReviewAngleCoverageSummary,
} from '../services/ipc/loop-ipc.service';

/**
 * WS-B9: a short activity-message suffix noting how many REQUIRED reviewer/
 * angles fell short of coverage this attempt (skipped/failed/parse_failed —
 * `used`/`cached` don't count). Mirrors the demoted-finding suffix pattern in
 * `loop.store.ts`. Empty string when `coverage` is absent or nothing fell
 * short.
 */
export function coverageSuffix(coverage: ReviewAngleCoverageSummary[] | undefined): string {
  const shortfall = (coverage ?? []).filter(
    (a) => a.required && a.status !== 'used' && a.status !== 'cached',
  ).length;
  return shortfall > 0
    ? ` (${shortfall} required reviewer angle${shortfall === 1 ? '' : 's'} short of coverage this attempt)`
    : '';
}

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
