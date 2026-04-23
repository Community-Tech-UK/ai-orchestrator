/**
 * Orchestration Projector
 *
 * Builds read models (summaries) from a stream of OrchestrationEvents.
 * Use this to reconstruct the current state of a verification or debate
 * from its event history.
 */

import { getLogger } from '../../logging/logger';
import type { OrchestrationEvent } from './orchestration-events';
import type { ActiveDebate, DebateResult, DebateSessionRound } from '../../../shared/types/debate.types';
import type { VerificationRequest, VerificationResult } from '../../../shared/types/verification.types';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

  projectActiveVerificationRequest(events: OrchestrationEvent[]): VerificationRequest | null {
    let request: VerificationRequest | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'verification.requested':
          request = this.toVerificationRequest(event.payload);
          break;
        case 'verification.cancelled':
        case 'verification.completed':
          return null;
        default:
          logger.debug('Skipping non-lifecycle event in projectActiveVerificationRequest', {
            type: event.type,
          });
      }
    }

    return request;
  }

  projectActiveDebate(events: OrchestrationEvent[]): ActiveDebate | null {
    let debate: ActiveDebate | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'debate.started':
          debate = this.toActiveDebate(event.payload);
          break;
        case 'debate.round_completed': {
          const snapshot = this.toActiveDebate(event.payload);
          if (snapshot) {
            debate = snapshot;
            break;
          }

          if (!debate) {
            break;
          }

          const round = this.toDebateRound(event.payload['round']);
          if (!round) {
            break;
          }

          const existingIndex = debate.rounds.findIndex(
            currentRound => currentRound.roundNumber === round.roundNumber,
          );
          if (existingIndex >= 0) {
            debate.rounds[existingIndex] = round;
          } else {
            debate.rounds.push(round);
          }
          debate.currentRound = round.roundNumber;
          break;
        }
        case 'debate.paused': {
          const snapshot = this.toActiveDebate(event.payload);
          if (snapshot) {
            debate = snapshot;
          } else if (debate) {
            debate.status = 'paused';
          }
          break;
        }
        case 'debate.resumed': {
          const snapshot = this.toActiveDebate(event.payload);
          if (snapshot) {
            debate = snapshot;
          } else if (debate) {
            debate.status = 'in_progress';
          }
          break;
        }
        case 'debate.completed':
          return null;
        default:
          logger.debug('Skipping non-lifecycle event in projectActiveDebate', {
            type: event.type,
          });
      }
    }

    return debate;
  }

  projectVerificationResult(events: OrchestrationEvent[]): VerificationResult | null {
    let result: VerificationResult | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'verification.completed':
          result = this.toVerificationResult(event.payload);
          break;
        case 'verification.cancelled':
          return null;
        default:
          logger.debug('Skipping non-result event in projectVerificationResult', {
            type: event.type,
          });
      }
    }

    return result;
  }

  projectDebateResult(events: OrchestrationEvent[]): DebateResult | null {
    let result: DebateResult | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'debate.completed':
          result = this.toDebateResult(event.payload);
          break;
        default:
          logger.debug('Skipping non-result event in projectDebateResult', {
            type: event.type,
          });
      }
    }

    return result;
  }

  private toVerificationRequest(payload: Record<string, unknown>): VerificationRequest | null {
    if (
      typeof payload['id'] !== 'string' ||
      typeof payload['instanceId'] !== 'string' ||
      typeof payload['prompt'] !== 'string' ||
      !isRecord(payload['config'])
    ) {
      return null;
    }

    return {
      ...(payload as unknown as VerificationRequest),
      config: { ...(payload['config'] as unknown as VerificationRequest['config']) },
      attachments: Array.isArray(payload['attachments'])
        ? [...(payload['attachments'] as NonNullable<VerificationRequest['attachments']>)]
        : undefined,
    };
  }

  private toActiveDebate(payload: Record<string, unknown>): ActiveDebate | null {
    const id = typeof payload['id'] === 'string'
      ? payload['id']
      : (typeof payload['debateId'] === 'string' ? payload['debateId'] : undefined);

    if (
      !id ||
      typeof payload['query'] !== 'string' ||
      !isRecord(payload['config']) ||
      typeof payload['currentRound'] !== 'number' ||
      !Array.isArray(payload['rounds']) ||
      typeof payload['startTime'] !== 'number' ||
      typeof payload['status'] !== 'string'
    ) {
      return null;
    }

    return {
      ...(payload as unknown as ActiveDebate),
      id,
      config: { ...(payload['config'] as unknown as ActiveDebate['config']) },
      rounds: [...(payload['rounds'] as DebateSessionRound[])],
    };
  }

  private toVerificationResult(payload: Record<string, unknown>): VerificationResult | null {
    if (
      typeof payload['id'] !== 'string' ||
      !isRecord(payload['request']) ||
      !Array.isArray(payload['responses']) ||
      !isRecord(payload['analysis']) ||
      typeof payload['synthesizedResponse'] !== 'string' ||
      typeof payload['synthesisMethod'] !== 'string' ||
      typeof payload['synthesisConfidence'] !== 'number' ||
      typeof payload['totalDuration'] !== 'number' ||
      typeof payload['totalTokens'] !== 'number' ||
      typeof payload['totalCost'] !== 'number' ||
      typeof payload['completedAt'] !== 'number'
    ) {
      return null;
    }

    const request = this.toVerificationRequest(payload['request']);
    if (!request) {
      return null;
    }

    return {
      ...(payload as unknown as VerificationResult),
      request,
      responses: [...(payload['responses'] as VerificationResult['responses'])],
      analysis: { ...(payload['analysis'] as unknown as VerificationResult['analysis']) },
      debateRounds: Array.isArray(payload['debateRounds'])
        ? [...(payload['debateRounds'] as NonNullable<VerificationResult['debateRounds']>)]
        : undefined,
    };
  }

  private toDebateResult(payload: Record<string, unknown>): DebateResult | null {
    if (
      typeof payload['id'] !== 'string' ||
      typeof payload['query'] !== 'string' ||
      !Array.isArray(payload['rounds']) ||
      typeof payload['synthesis'] !== 'string' ||
      typeof payload['consensusReached'] !== 'boolean' ||
      typeof payload['finalConsensusScore'] !== 'number' ||
      !Array.isArray(payload['keyAgreements']) ||
      !Array.isArray(payload['unresolvedDisagreements']) ||
      typeof payload['tokensUsed'] !== 'number' ||
      typeof payload['duration'] !== 'number' ||
      typeof payload['status'] !== 'string'
    ) {
      return null;
    }

    return {
      ...(payload as unknown as DebateResult),
      rounds: [...(payload['rounds'] as DebateResult['rounds'])],
      keyAgreements: [...(payload['keyAgreements'] as DebateResult['keyAgreements'])],
      unresolvedDisagreements: [
        ...(payload['unresolvedDisagreements'] as DebateResult['unresolvedDisagreements']),
      ],
    };
  }

  private toDebateRound(value: unknown): DebateSessionRound | null {
    if (!isRecord(value)) {
      return null;
    }

    if (
      typeof value['roundNumber'] !== 'number' ||
      typeof value['type'] !== 'string' ||
      !Array.isArray(value['contributions']) ||
      typeof value['consensusScore'] !== 'number' ||
      typeof value['timestamp'] !== 'number' ||
      typeof value['durationMs'] !== 'number'
    ) {
      return null;
    }

    return value as unknown as DebateSessionRound;
  }
}
