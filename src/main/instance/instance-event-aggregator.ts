import { randomUUID } from 'node:crypto';
import type {
  InstanceEventEnvelope,
  InstanceFailureClass,
  InstanceStatus,
} from '@contracts/types/instance-events';
import type { Instance } from '../../shared/types/instance.types';

interface InstanceStateUpdateLike {
  instanceId: string;
  status: Instance['status'];
  previousStatus: Instance['status'];
  timestamp: number;
}

/** Options for querying the retained per-instance event log. */
export interface InstanceEventLogQuery {
  /**
   * Only return events whose `seq` is strictly greater than this value. Use the
   * last `seq` a consumer has already processed to resume a stream ("attached
   * from seq N" replay). Omit to return the whole retained window.
   */
  afterSeq?: number;
  /** Cap the number of returned events to the most recent `limit`. */
  limit?: number;
}

/**
 * Default retention caps. These bound memory deterministically so terminated
 * instances cannot leak their event history (the log is retained past
 * `removed` so the terminal state stays queryable, then aged out by LRU):
 *  - per instance: a rolling window of the most recent events.
 *  - globally: the least-recently-updated instances are evicted first.
 */
export const MAX_EVENTS_PER_INSTANCE = 500;
export const MAX_TRACKED_INSTANCES = 128;

/**
 * Builds canonical, per-instance-sequenced `InstanceEventEnvelope`s for the
 * lifecycle stream AND retains them as a bounded, queryable per-instance event
 * log (A8: "canonical per-instance event log").
 *
 * The envelope it returns is emitted live as `instance:event`; the retained log
 * lets other main-process subsystems (recovery, durable-session replay, the
 * mobile gateway's "attached from seq N" resume) read recent history without
 * subscribing from process start. Sequences are per-instance and monotonic, and
 * reset when an instance id is removed and later recreated.
 */
export class InstanceEventAggregator {
  private seqByInstance = new Map<string, number>();
  private statusByInstance = new Map<string, InstanceStatus>();
  /**
   * Retained event log keyed by instanceId. Map iteration order is the
   * least-recently-updated → most-recently-updated order used for LRU eviction:
   * appending re-inserts the key so the freshest instance moves to the end.
   */
  private logByInstance = new Map<string, InstanceEventEnvelope[]>();

  constructor(
    private readonly maxEventsPerInstance = MAX_EVENTS_PER_INSTANCE,
    private readonly maxTrackedInstances = MAX_TRACKED_INSTANCES,
  ) {}

  recordCreated(instance: Pick<Instance, 'id' | 'status' | 'provider' | 'parentId' | 'workingDirectory'>): InstanceEventEnvelope {
    this.statusByInstance.set(instance.id, instance.status as InstanceStatus);
    return this.makeEnvelope(instance.id, {
      kind: 'created',
      status: instance.status as InstanceStatus,
      provider: instance.provider,
      parentId: instance.parentId,
      workingDirectory: instance.workingDirectory,
    });
  }

  recordStateUpdate(payload: InstanceStateUpdateLike): InstanceEventEnvelope {
    this.statusByInstance.set(payload.instanceId, payload.status as InstanceStatus);

    const failureClass = this.classifyFailure(payload);
    return this.makeEnvelope(
      payload.instanceId,
      {
        kind: 'status_changed',
        previousStatus: payload.previousStatus as InstanceStatus,
        status: payload.status as InstanceStatus,
        ...(failureClass ? { failureClass } : {}),
      },
      payload.timestamp,
    );
  }

  recordRemoved(instanceId: string, status?: Instance['status']): InstanceEventEnvelope {
    const resolvedStatus = (status ?? this.statusByInstance.get(instanceId)) as InstanceStatus | undefined;
    const envelope = this.makeEnvelope(instanceId, {
      kind: 'removed',
      ...(resolvedStatus ? { status: resolvedStatus } : {}),
    });

    // Reset sequence/status tracking so a recreated id restarts at seq 0. The
    // retained log buffer is intentionally kept (including this `removed` event)
    // so the terminal state stays queryable; it is cleared on the next
    // `recordCreated` for the same id and otherwise aged out by LRU.
    this.seqByInstance.delete(instanceId);
    this.statusByInstance.delete(instanceId);
    return envelope;
  }

  // ============================================================
  // Retained log queries
  // ============================================================

  /**
   * Return the retained events for an instance in chronological (seq-ascending)
   * order, optionally resuming after a seq and/or capped to the most recent
   * `limit`. Events older than the retained window may have been dropped.
   */
  getEvents(instanceId: string, query: InstanceEventLogQuery = {}): InstanceEventEnvelope[] {
    const buffer = this.logByInstance.get(instanceId);
    if (!buffer || buffer.length === 0) return [];

    let events =
      query.afterSeq === undefined
        ? buffer
        : buffer.filter((e) => e.seq > query.afterSeq!);

    if (query.limit !== undefined && query.limit >= 0 && events.length > query.limit) {
      events = events.slice(events.length - query.limit);
    }
    // Copy so callers can't mutate the retained buffer.
    return events.slice();
  }

  /** Most recent retained event for an instance, or undefined if none retained. */
  getLatestEvent(instanceId: string): InstanceEventEnvelope | undefined {
    const buffer = this.logByInstance.get(instanceId);
    return buffer && buffer.length > 0 ? buffer[buffer.length - 1] : undefined;
  }

  /** Number of retained events for an instance. */
  getEventCount(instanceId: string): number {
    return this.logByInstance.get(instanceId)?.length ?? 0;
  }

  /** Instance ids with a retained log, least- to most-recently-updated. */
  getTrackedInstances(): string[] {
    return [...this.logByInstance.keys()];
  }

  /** Explicitly drop an instance's retained log (e.g. on hard cleanup). */
  pruneInstance(instanceId: string): void {
    this.logByInstance.delete(instanceId);
  }

  private classifyFailure(payload: InstanceStateUpdateLike): InstanceFailureClass | undefined {
    if (payload.status === 'error') {
      return 'runtime';
    }

    if (payload.status === 'failed') {
      if (payload.previousStatus === 'initializing') {
        return 'startup';
      }
      if (payload.previousStatus === 'respawning') {
        return 'recovery';
      }
      return 'runtime';
    }

    if (payload.status === 'terminated' && payload.previousStatus !== 'terminated') {
      return 'termination';
    }

    return undefined;
  }

  private makeEnvelope(
    instanceId: string,
    event: InstanceEventEnvelope['event'],
    timestamp = Date.now(),
  ): InstanceEventEnvelope {
    const envelope: InstanceEventEnvelope = {
      eventId: randomUUID(),
      seq: this.nextSeq(instanceId),
      timestamp,
      instanceId,
      event,
    };
    this.appendToLog(envelope);
    return envelope;
  }

  /**
   * Append to the retained log, enforcing per-instance and global LRU caps. A
   * `created` event for an id that still has a stale buffer (a prior, removed
   * lifecycle) starts a fresh window — consistent with the seq reset.
   */
  private appendToLog(envelope: InstanceEventEnvelope): void {
    const { instanceId } = envelope;
    const existing = this.logByInstance.get(instanceId);

    let buffer: InstanceEventEnvelope[];
    if (existing && envelope.event.kind === 'created') {
      // Fresh lifecycle for a recreated id — reset the window in place.
      existing.length = 0;
      buffer = existing;
      // Re-insert to mark most-recently-used.
      this.logByInstance.delete(instanceId);
      this.logByInstance.set(instanceId, buffer);
    } else if (existing) {
      buffer = existing;
      // Re-insert to mark most-recently-used.
      this.logByInstance.delete(instanceId);
      this.logByInstance.set(instanceId, buffer);
    } else {
      buffer = [];
      this.logByInstance.set(instanceId, buffer);
    }

    buffer.push(envelope);
    if (buffer.length > this.maxEventsPerInstance) {
      buffer.splice(0, buffer.length - this.maxEventsPerInstance);
    }

    // Global LRU eviction: drop the least-recently-updated instances.
    while (this.logByInstance.size > this.maxTrackedInstances) {
      const lru = this.logByInstance.keys().next().value;
      if (lru === undefined || lru === instanceId) break;
      this.logByInstance.delete(lru);
    }
  }

  private nextSeq(instanceId: string): number {
    const next = this.seqByInstance.get(instanceId) ?? 0;
    this.seqByInstance.set(instanceId, next + 1);
    return next;
  }
}
