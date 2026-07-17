/**
 * WS15 — coordinator side of worker stream durability (cursors + ack + resume).
 *
 * Tracks the highest `durableSeq` processed per (node, instance), acks them
 * back to the worker on a debounced cadence (so its ring can trim), dedupes
 * replayed frames (seq ≤ cursor), and — when a durable worker re-registers —
 * asks it to replay everything after our cursors (`node.streamResume`).
 *
 * Worker-process restarts reset the worker's seq counter, so each worker
 * process advertises a `streamEpoch`; an epoch change invalidates all cursors
 * for that node (fresh counters must never be deduped against stale cursors).
 *
 * Cursors are in-memory by design: the worker's ring lives only as long as
 * the worker process, so cursors that outlive either process have nothing to
 * resume against (recorded WS15 deviation from "persist lastAckedSeq").
 */

import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';

const logger = getLogger('StreamDurability');

const ACK_DEBOUNCE_MS = 2_000;
const MAX_TRACKED_NODES = 50;

export interface StreamResumeSummary {
  cursors?: Array<{ instanceId: string; replayed: number; gapThroughSeq?: number }>;
}

export interface StreamDurabilityCoordinatorDeps {
  sendAck(nodeId: string, cursors: Array<{ instanceId: string; seq: number }>): void;
  sendResume(
    nodeId: string,
    cursors: Array<{ instanceId: string; afterSeq: number }>,
  ): Promise<StreamResumeSummary>;
  /** Surface a replay gap to the instance transcript (events were evicted). */
  emitGapMarker(nodeId: string, instanceId: string, gapThroughSeq: number): void;
}

interface NodeCursorState {
  epoch?: number;
  cursors: Map<string, number>;
  dirty: Set<string>;
  ackTimer: ReturnType<typeof setTimeout> | null;
}

export class StreamDurabilityCoordinator {
  private readonly nodes = new Map<string, NodeCursorState>();

  constructor(private readonly deps: StreamDurabilityCoordinatorDeps) {}

  /**
   * Gate a durable notification. Returns false when the frame is a replay
   * duplicate (seq ≤ cursor). Frames without a durableSeq (legacy workers)
   * are always accepted.
   */
  accept(nodeId: string, instanceId: unknown, durableSeq: unknown): boolean {
    if (typeof durableSeq !== 'number' || typeof instanceId !== 'string') return true;
    const state = this.stateFor(nodeId);
    const cursor = state.cursors.get(instanceId) ?? 0;
    if (durableSeq <= cursor) {
      logger.debug('Dropping duplicate durable frame', { nodeId, instanceId, durableSeq, cursor });
      return false;
    }
    state.cursors.set(instanceId, durableSeq);
    state.dirty.add(instanceId);
    this.scheduleAck(nodeId, state);
    return true;
  }

  /**
   * Record the worker process epoch from registration/heartbeat capabilities.
   * An epoch change means a fresh worker process (seq counters restarted) —
   * all cursors for the node are invalid.
   */
  noteNodeEpoch(nodeId: string, epoch: unknown): void {
    if (typeof epoch !== 'number') return;
    const state = this.stateFor(nodeId);
    if (state.epoch !== undefined && state.epoch !== epoch) {
      logger.info('Worker stream epoch changed — resetting durable cursors', {
        nodeId,
        previousEpoch: state.epoch,
        epoch,
      });
      state.cursors.clear();
      state.dirty.clear();
    }
    state.epoch = epoch;
  }

  /**
   * A durable worker (re-)registered: ask it to replay everything after our
   * cursors. Fire-and-forget — a failed resume just means the gap stays lost,
   * exactly today's behavior.
   */
  resumeNode(nodeId: string, streamDurability: unknown): void {
    if (typeof streamDurability !== 'number' || streamDurability < 1) return;
    const state = this.nodes.get(nodeId);
    if (!state || state.cursors.size === 0) return;
    const cursors = [...state.cursors.entries()].map(([instanceId, afterSeq]) => ({
      instanceId,
      afterSeq,
    }));
    void this.deps
      .sendResume(nodeId, cursors)
      .then((summary) => {
        const replayed = summary.cursors?.reduce((n, c) => n + c.replayed, 0) ?? 0;
        logger.info('Durable stream resume completed', { nodeId, instances: cursors.length, replayed });
        for (const cursor of summary.cursors ?? []) {
          if (cursor.gapThroughSeq !== undefined) {
            this.deps.emitGapMarker(nodeId, cursor.instanceId, cursor.gapThroughSeq);
          }
        }
      })
      .catch((error: unknown) => {
        logger.warn('Durable stream resume failed — offline-window output stays lost', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Flush any pending ack immediately (used on dispose and in tests). */
  flushAcks(nodeId?: string): void {
    for (const [id, state] of this.nodes) {
      if (nodeId !== undefined && id !== nodeId) continue;
      if (state.ackTimer) {
        clearTimeout(state.ackTimer);
        state.ackTimer = null;
      }
      this.sendDirtyAcks(id, state);
    }
  }

  dispose(): void {
    for (const state of this.nodes.values()) {
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.ackTimer = null;
    }
    this.nodes.clear();
  }

  /** Build the synthetic transcript marker for a replay gap. */
  static buildGapMarkerMessage(gapThroughSeq: number): Record<string, unknown> {
    return {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content:
        '⚠️ Some output from this remote session was lost while the worker connection was down ' +
        `(events up to #${gapThroughSeq} were dropped from the worker's replay buffer).`,
      metadata: { source: 'stream-durability-gap' },
    };
  }

  private stateFor(nodeId: string): NodeCursorState {
    let state = this.nodes.get(nodeId);
    if (!state) {
      if (this.nodes.size >= MAX_TRACKED_NODES) {
        const oldest = this.nodes.keys().next().value;
        if (oldest !== undefined) {
          const evicted = this.nodes.get(oldest);
          if (evicted?.ackTimer) clearTimeout(evicted.ackTimer);
          this.nodes.delete(oldest);
        }
      }
      state = { cursors: new Map<string, number>(), dirty: new Set<string>(), ackTimer: null };
      this.nodes.set(nodeId, state);
    }
    return state;
  }

  private scheduleAck(nodeId: string, state: NodeCursorState): void {
    if (state.ackTimer) return;
    state.ackTimer = setTimeout(() => {
      state.ackTimer = null;
      this.sendDirtyAcks(nodeId, state);
    }, ACK_DEBOUNCE_MS);
    if (typeof state.ackTimer.unref === 'function') state.ackTimer.unref();
  }

  private sendDirtyAcks(nodeId: string, state: NodeCursorState): void {
    if (state.dirty.size === 0) return;
    const cursors = [...state.dirty]
      .map((instanceId) => ({ instanceId, seq: state.cursors.get(instanceId) ?? 0 }))
      .filter((cursor) => cursor.seq > 0);
    state.dirty.clear();
    if (cursors.length === 0) return;
    try {
      this.deps.sendAck(nodeId, cursors);
    } catch (error) {
      logger.debug('Durable ack send failed (node likely offline)', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
