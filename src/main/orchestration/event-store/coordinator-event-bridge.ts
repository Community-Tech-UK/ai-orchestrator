/**
 * Coordinator Event Bridge
 *
 * Wires coordinator EventEmitter events into the orchestration command path,
 * so persisted events are appended through OrchestrationEngine rather than
 * bypassing it with direct store writes.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';
import type { OrchestrationEngine } from '../orchestration-engine';
import type { OrchestrationCommandType } from '../orchestration-commands';

const logger = getLogger('CoordinatorEventBridge');

type OrchestrationCommandDispatcher = Pick<OrchestrationEngine, 'dispatch'>;
type DebateCoordinatorSource = EventEmitter & {
  getDebate?: (debateId: string) => unknown;
};

export class CoordinatorEventBridge {
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly dispatcher: OrchestrationCommandDispatcher) {}

  /**
   * Wire a MultiVerifyCoordinator (EventEmitter) to the orchestration command path.
   */
  wireVerifyCoordinator(coordinator: EventEmitter): void {
    this.listen(coordinator, 'verification:started', (payload: Record<string, unknown>) => {
      this.dispatchSafe('verification.request', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    this.listen(coordinator, 'verification:completed', (payload: Record<string, unknown>) => {
      this.dispatchSafe('verification.complete', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    this.listen(coordinator, 'verification:error', (payload: Record<string, unknown>) => {
      const request = (payload['request'] ?? {}) as Record<string, unknown>;
      this.dispatchSafe('verification.complete', String(request['id'] ?? ''), {
        error: String(payload['error'] ?? 'unknown'),
      }, {
        instanceId: String(request['instanceId'] ?? ''),
      });
    });

    this.listen(coordinator, 'verification:cancelled', (payload: Record<string, unknown>) => {
      this.dispatchSafe('verification.cancel', String(payload['verificationId'] ?? ''), payload);
    });

    logger.info('Wired verify coordinator to orchestration engine');
  }

  /**
   * Wire a DebateCoordinator (EventEmitter) to the orchestration command path.
   */
  wireDebateCoordinator(coordinator: EventEmitter): void {
    this.listen(coordinator, 'debate:started', (payload: Record<string, unknown>) => {
      const debatePayload = this.resolveDebatePayload(coordinator, payload);
      this.dispatchSafe('debate.start', String(payload['debateId'] ?? ''), debatePayload, {
        instanceId: typeof debatePayload['instanceId'] === 'string' ? debatePayload['instanceId'] : undefined,
      });
    });

    this.listen(coordinator, 'debate:paused', (payload: Record<string, unknown>) => {
      const debatePayload = this.resolveDebatePayload(coordinator, payload);
      this.dispatchSafe('debate.pause', String(payload['debateId'] ?? ''), debatePayload, {
        instanceId: typeof debatePayload['instanceId'] === 'string' ? debatePayload['instanceId'] : undefined,
      });
    });

    this.listen(coordinator, 'debate:resumed', (payload: Record<string, unknown>) => {
      const debatePayload = this.resolveDebatePayload(coordinator, payload);
      this.dispatchSafe('debate.resume', String(payload['debateId'] ?? ''), debatePayload, {
        instanceId: typeof debatePayload['instanceId'] === 'string' ? debatePayload['instanceId'] : undefined,
      });
    });

    this.listen(coordinator, 'debate:round-complete', (payload: Record<string, unknown>) => {
      const debatePayload = this.resolveDebatePayload(coordinator, payload);
      this.dispatchSafe('debate.record-round', String(payload['debateId'] ?? ''), debatePayload, {
        instanceId: typeof debatePayload['instanceId'] === 'string' ? debatePayload['instanceId'] : undefined,
      });
      const round = (payload['round'] ?? {}) as Record<string, unknown>;
      if (round['type'] === 'synthesis') {
        this.dispatchSafe('debate.record-synthesis', String(payload['debateId'] ?? ''), debatePayload, {
          instanceId: typeof debatePayload['instanceId'] === 'string' ? debatePayload['instanceId'] : undefined,
        });
      }
    });

    this.listen(coordinator, 'debate:completed', (payload: Record<string, unknown>) => {
      this.dispatchSafe('debate.complete', String(payload['debateId'] ?? ''), payload);
    });

    logger.info('Wired debate coordinator to orchestration engine');
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      this.disposers.pop()?.();
    }
  }

  private dispatchSafe(
    commandType: OrchestrationCommandType,
    aggregateId: string,
    payload: Record<string, unknown>,
    metadata?: {
      instanceId?: string;
      source?: string;
      laneId?: string;
      worktreeId?: string;
      branchName?: string;
    },
  ): void {
    try {
      const result = this.dispatcher.dispatch({
        commandType,
        aggregateId,
        payload,
        metadata,
      });

      if (result.receipt.status === 'rejected') {
        logger.warn('Rejected orchestration command', {
          commandType,
          aggregateId,
          reason: result.receipt.reason,
        });
      }
    } catch (err) {
      logger.warn(`Failed to dispatch orchestration command: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private listen<T>(
    emitter: EventEmitter,
    eventName: string,
    handler: (payload: T) => void,
  ): void {
    emitter.on(eventName, handler as (...args: any[]) => void);
    this.disposers.push(() => {
      emitter.off(eventName, handler as (...args: any[]) => void);
    });
  }

  private resolveDebatePayload(
    coordinator: EventEmitter,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const debateId = String(payload['debateId'] ?? payload['id'] ?? '');
    if (!debateId) {
      return payload;
    }

    const getter = (coordinator as DebateCoordinatorSource).getDebate;
    if (typeof getter !== 'function') {
      return payload;
    }

    const currentState = getter.call(coordinator, debateId);
    if (!currentState || typeof currentState !== 'object' || Array.isArray(currentState)) {
      return payload;
    }

    return {
      ...(currentState as Record<string, unknown>),
      ...payload,
    };
  }
}
