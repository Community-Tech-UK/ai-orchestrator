import type { OrchestrationEventType } from './event-store/orchestration-events';
import type { OrchestrationCommand, OrchestrationCommandType } from './orchestration-commands';
import { toOrchestrationEventType } from './orchestration-commands';

interface AggregateIdentityHints {
  required?: boolean;
  keys: string[];
}

const AGGREGATE_HINTS_BY_COMMAND: Partial<Record<OrchestrationCommandType, AggregateIdentityHints>> = {
  'verification.request': { required: true, keys: ['id'] },
  'verification.cancel': { required: true, keys: ['verificationId', 'id'] },
  'verification.record-response': { keys: ['verificationId', 'id'] },
  'verification.complete': { keys: ['id', 'verificationId'] },
  'debate.start': { required: true, keys: ['debateId', 'id'] },
  'debate.pause': { required: true, keys: ['debateId', 'id'] },
  'debate.resume': { required: true, keys: ['debateId', 'id'] },
  'debate.record-round': { required: true, keys: ['debateId', 'id'] },
  'debate.record-synthesis': { required: true, keys: ['debateId', 'id'] },
  'debate.complete': { required: true, keys: ['debateId', 'id'] },
  'consensus.start': { keys: ['consensusId', 'id'] },
  'consensus.record-vote': { keys: ['consensusId', 'id'] },
  'consensus.complete': { keys: ['consensusId', 'id'] },
  'lane.create': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.start': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.flag-conflict': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.begin-merge': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.complete': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.fail': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'lane.cancel': { required: true, keys: ['executionId', 'laneId', 'id'] },
  'worktree.create': { required: true, keys: ['executionId', 'worktreeId', 'id'] },
  'worktree.complete': { required: true, keys: ['executionId', 'worktreeId', 'id'] },
  'worktree.detect-conflict': { required: true, keys: ['executionId', 'worktreeId', 'id'] },
  'branch.prepare': { required: true, keys: ['executionId', 'branchName', 'id'] },
  'branch.mark-merge-succeeded': { required: true, keys: ['executionId', 'branchName', 'id'] },
  'branch.mark-merge-failed': { required: true, keys: ['executionId', 'branchName', 'id'] },
  'worktree.cleanup': { required: true, keys: ['executionId', 'worktreeId', 'id'] },
};

export interface OrchestrationDecision {
  eventType: OrchestrationEventType;
}

export interface OrchestrationRejection {
  reason: string;
}

function readAggregateHint(
  commandType: OrchestrationCommandType,
  payload: Record<string, unknown>,
): string | null {
  const hints = AGGREGATE_HINTS_BY_COMMAND[commandType];
  if (!hints) {
    return null;
  }

  for (const key of hints.keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return hints.required ? '' : null;
}

export function decideOrchestrationCommand(
  command: OrchestrationCommand,
): OrchestrationDecision | OrchestrationRejection {
  const aggregateHint = readAggregateHint(command.commandType, command.payload);
  if (aggregateHint === '') {
    return {
      reason: `Payload for ${command.commandType} must include an aggregate identity`,
    };
  }
  if (aggregateHint && aggregateHint !== command.aggregateId) {
    return {
      reason: `Aggregate ID mismatch for ${command.commandType}: expected ${aggregateHint}, received ${command.aggregateId}`,
    };
  }

  return {
    eventType: toOrchestrationEventType(command.commandType),
  };
}
