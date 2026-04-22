/**
 * Coordinator Event Bridge
 *
 * Wires MultiVerifyCoordinator and DebateCoordinator EventEmitter events
 * into the OrchestrationEventStore for audit trail and replay.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getLogger } from '../../logging/logger';
import type { OrchestrationEventStore } from './orchestration-event-store';
import type { OrchestrationEventType } from './orchestration-events';
import type { LaneEventMetadata } from '../../../shared/types/lane-events';

const logger = getLogger('CoordinatorEventBridge');

export class CoordinatorEventBridge {
  private store: OrchestrationEventStore;
  private readonly disposers: Array<() => void> = [];

  constructor(store: OrchestrationEventStore) {
    this.store = store;
  }

  /**
   * Wire a MultiVerifyCoordinator (EventEmitter) to the event store.
   */
  wireVerifyCoordinator(coordinator: EventEmitter): void {
    this.listen(coordinator, 'verification:started', (payload: Record<string, unknown>) => {
      this.appendSafe('verification.requested', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    this.listen(coordinator, 'verification:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('verification.completed', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    this.listen(coordinator, 'verification:error', (payload: Record<string, unknown>) => {
      const request = (payload['request'] ?? {}) as Record<string, unknown>;
      this.appendSafe('verification.completed', String(request['id'] ?? ''), {
        error: String(payload['error'] ?? 'unknown'),
      }, {
        instanceId: String(request['instanceId'] ?? ''),
      });
    });

    logger.info('Wired verify coordinator to event store');
  }

  /**
   * Wire a DebateCoordinator (EventEmitter) to the event store.
   */
  wireDebateCoordinator(coordinator: EventEmitter): void {
    this.listen(coordinator, 'debate:started', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.started', String(payload['debateId'] ?? ''), payload);
    });

    this.listen(coordinator, 'debate:round-complete', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.round_completed', String(payload['debateId'] ?? ''), payload);
      const round = (payload['round'] ?? {}) as Record<string, unknown>;
      if (round['type'] === 'synthesis') {
        this.appendSafe('debate.synthesized', String(payload['debateId'] ?? ''), payload);
      }
    });

    this.listen(coordinator, 'debate:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.completed', String(payload['debateId'] ?? ''), payload);
    });

    logger.info('Wired debate coordinator to event store');
  }

  wireParallelWorktreeCoordinator(coordinator: EventEmitter): void {
    this.listen(coordinator, 'execution:created', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.created', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:started', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.started', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:conflict-warning', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.conflict_warning', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:merging', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.merging', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.completed', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:partial-failure', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.failed', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'execution:cancelled', (payload: Record<string, unknown>) => {
      this.appendSafe('lane.cancelled', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'worktree:created', (payload: Record<string, unknown>) => {
      const aggregateId = String(payload['executionId'] ?? '');
      const metadata = this.toLaneMetadata(payload);
      this.appendSafe('worktree.created', aggregateId, payload, metadata);
      this.appendSafe('branch.prepared', aggregateId, payload, metadata);
    });

    this.listen(coordinator, 'task:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('worktree.completed', String(payload['executionId'] ?? ''), payload, this.toLaneMetadata(payload));
    });

    this.listen(coordinator, 'execution:conflicts-detected', (payload: Record<string, unknown>) => {
      this.appendSafe('worktree.conflict_detected', String(payload['executionId'] ?? ''), payload, {
        laneId: String(payload['executionId'] ?? ''),
        source: 'parallel-worktree',
      });
    });

    this.listen(coordinator, 'task:merged', (payload: Record<string, unknown>) => {
      this.appendSafe('branch.merge_succeeded', String(payload['executionId'] ?? ''), payload, this.toLaneMetadata(payload));
    });

    this.listen(coordinator, 'task:merge-failed', (payload: Record<string, unknown>) => {
      this.appendSafe('branch.merge_failed', String(payload['executionId'] ?? ''), payload, this.toLaneMetadata(payload));
    });

    this.listen(coordinator, 'worktree:cleaned', (payload: Record<string, unknown>) => {
      this.appendSafe('worktree.cleaned', String(payload['executionId'] ?? ''), payload, this.toLaneMetadata(payload));
    });

    logger.info('Wired parallel worktree coordinator to event store');
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      this.disposers.pop()?.();
    }
  }

  private appendSafe(
    type: OrchestrationEventType,
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
      this.store.append({
        id: randomUUID(),
        type,
        aggregateId,
        timestamp: Date.now(),
        payload,
        metadata,
      });
    } catch (err) {
      logger.warn(`Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
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

  private toLaneMetadata(payload: Record<string, unknown>): LaneEventMetadata & {
    source: string;
    laneId: string;
    worktreeId?: string;
  } {
    const session = (payload['session'] ?? {}) as Record<string, unknown>;
    return {
      executionId: String(payload['executionId'] ?? ''),
      taskId: typeof payload['taskId'] === 'string' ? payload['taskId'] : undefined,
      sessionId: typeof session['id'] === 'string' ? session['id'] : undefined,
      branchName: typeof session['branchName'] === 'string' ? session['branchName'] : undefined,
      worktreePath: typeof session['worktreePath'] === 'string' ? session['worktreePath'] : undefined,
      laneId: String(payload['executionId'] ?? ''),
      worktreeId: typeof session['id'] === 'string' ? session['id'] : undefined,
      source: 'parallel-worktree',
    };
  }
}
