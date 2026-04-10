/**
 * Orchestration Event Types
 *
 * Defines the event type union and the core OrchestrationEvent interface
 * used by the append-only event store.
 */

export type OrchestrationEventType =
  | 'verification.requested'
  | 'verification.agent_responded'
  | 'verification.completed'
  | 'debate.started'
  | 'debate.round_completed'
  | 'debate.synthesized'
  | 'debate.completed'
  | 'consensus.started'
  | 'consensus.vote_cast'
  | 'consensus.completed';

export interface OrchestrationEvent {
  id: string;
  type: OrchestrationEventType;
  aggregateId: string; // verificationId or debateId
  timestamp: number;
  payload: Record<string, unknown>;
  metadata?: {
    instanceId?: string;
    userId?: string;
    source?: string;
  };
}
