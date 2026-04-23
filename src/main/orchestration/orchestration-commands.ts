import type { OrchestrationEvent, OrchestrationEventType } from './event-store/orchestration-events';

export const ORCHESTRATION_COMMAND_TO_EVENT_TYPE = {
  'verification.request': 'verification.requested',
  'verification.cancel': 'verification.cancelled',
  'verification.record-response': 'verification.agent_responded',
  'verification.complete': 'verification.completed',
  'debate.start': 'debate.started',
  'debate.pause': 'debate.paused',
  'debate.resume': 'debate.resumed',
  'debate.record-round': 'debate.round_completed',
  'debate.record-synthesis': 'debate.synthesized',
  'debate.complete': 'debate.completed',
  'consensus.start': 'consensus.started',
  'consensus.record-vote': 'consensus.vote_cast',
  'consensus.complete': 'consensus.completed',
  'lane.create': 'lane.created',
  'lane.start': 'lane.started',
  'lane.flag-conflict': 'lane.conflict_warning',
  'lane.begin-merge': 'lane.merging',
  'lane.complete': 'lane.completed',
  'lane.fail': 'lane.failed',
  'lane.cancel': 'lane.cancelled',
  'worktree.create': 'worktree.created',
  'worktree.complete': 'worktree.completed',
  'worktree.detect-conflict': 'worktree.conflict_detected',
  'branch.prepare': 'branch.prepared',
  'branch.mark-merge-succeeded': 'branch.merge_succeeded',
  'branch.mark-merge-failed': 'branch.merge_failed',
  'worktree.cleanup': 'worktree.cleaned',
} as const satisfies Record<string, OrchestrationEventType>;

export type OrchestrationCommandType = keyof typeof ORCHESTRATION_COMMAND_TO_EVENT_TYPE;

export interface OrchestrationCommand {
  commandId?: string;
  commandType: OrchestrationCommandType;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata?: OrchestrationEvent['metadata'];
}

const EVENT_TO_COMMAND_TYPE = Object.entries(ORCHESTRATION_COMMAND_TO_EVENT_TYPE).reduce(
  (map, [commandType, eventType]) => {
    map.set(eventType, commandType as OrchestrationCommandType);
    return map;
  },
  new Map<OrchestrationEventType, OrchestrationCommandType>(),
);

export function isOrchestrationCommandType(value: string): value is OrchestrationCommandType {
  return value in ORCHESTRATION_COMMAND_TO_EVENT_TYPE;
}

export function toOrchestrationEventType(commandType: OrchestrationCommandType): OrchestrationEventType {
  return ORCHESTRATION_COMMAND_TO_EVENT_TYPE[commandType];
}

export function toOrchestrationCommandTypeFromEventType(
  eventType: OrchestrationEventType,
): OrchestrationCommandType | null {
  return EVENT_TO_COMMAND_TYPE.get(eventType) ?? null;
}

export function normalizeOrchestrationCommandType(value: string): OrchestrationCommandType | null {
  if (isOrchestrationCommandType(value)) {
    return value;
  }

  return toOrchestrationCommandTypeFromEventType(value as OrchestrationEventType);
}
