/**
 * Orchestration Projector
 *
 * Builds read models (summaries) from a stream of OrchestrationEvents.
 * Use this to reconstruct the current state of a verification or debate
 * from its event history.
 */

import { getLogger } from '../../logging/logger';
import type { OrchestrationEvent } from './orchestration-events';

const logger = getLogger('OrchestrationProjector');

export interface VerificationSummary {
  verificationId: string;
  status: 'pending' | 'in_progress' | 'completed';
  agentResponses: number;
  result?: string;
  startedAt: number;
  completedAt?: number;
}

export interface DebateSummary {
  debateId: string;
  status: 'pending' | 'in_progress' | 'completed';
  roundsCompleted: number;
  synthesis?: string;
  startedAt: number;
  completedAt?: number;
}

export class OrchestrationProjector {
  projectVerification(events: OrchestrationEvent[]): VerificationSummary | null {
    if (events.length === 0) return null;

    const first = events[0];
    const summary: VerificationSummary = {
      verificationId: first.aggregateId,
      status: 'pending',
      agentResponses: 0,
      startedAt: first.timestamp,
    };

    for (const event of events) {
      switch (event.type) {
        case 'verification.requested':
          summary.status = 'in_progress';
          break;
        case 'verification.agent_responded':
          summary.agentResponses++;
          break;
        case 'verification.completed':
          summary.status = 'completed';
          summary.result = event.payload['result'] as string | undefined;
          summary.completedAt = event.timestamp;
          break;
        default:
          logger.debug('Skipping non-verification event in projectVerification', {
            type: event.type,
          });
      }
    }

    return summary;
  }

  projectDebate(events: OrchestrationEvent[]): DebateSummary | null {
    if (events.length === 0) return null;

    const first = events[0];
    const summary: DebateSummary = {
      debateId: first.aggregateId,
      status: 'pending',
      roundsCompleted: 0,
      startedAt: first.timestamp,
    };

    for (const event of events) {
      switch (event.type) {
        case 'debate.started':
          summary.status = 'in_progress';
          break;
        case 'debate.round_completed':
          summary.roundsCompleted++;
          break;
        case 'debate.synthesized':
          summary.synthesis = event.payload['synthesis'] as string | undefined;
          break;
        case 'debate.completed':
          summary.status = 'completed';
          summary.completedAt = event.timestamp;
          break;
        default:
          logger.debug('Skipping non-debate event in projectDebate', { type: event.type });
      }
    }

    return summary;
  }
}
