/**
 * ProviderRuntimeEventBus
 *
 * Routes provider runtime events with backpressure, coalescing, and stable sequences.
 *
 * Critical kinds (output, tool_use, tool_result, error, exit, spawned, complete):
 *   - Emitted synchronously/immediately; never dropped.
 *   - Always consume a sequence number.
 *
 * Context events:
 *   - Coalesced per instanceId: within a 100 ms flush window only the latest
 *     event is emitted. Source events replaced before the flush do not consume
 *     a sequence number.
 *
 * Status events:
 *   - Deduplicated per instanceId: if the status string has not changed within
 *     a minimum interval, the event is suppressed. Suppressed events do not
 *     consume sequence numbers.
 *
 * Sequence numbers:
 *   - Assigned only when an envelope is actually emitted, ensuring contiguous
 *     per-instance sequences with no gaps from coalesced/dropped events.
 */

import { randomUUID } from 'node:crypto';
import type {
  ProviderName,
  ProviderEventKind,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

/** Kinds that are always emitted without coalescing. */
const CRITICAL_KINDS = new Set<ProviderEventKind>([
  'output',
  'tool_use',
  'tool_result',
  'error',
  'exit',
  'spawned',
  'complete',
]);

export interface ProviderRuntimeEventBusOptions {
  /** Flush interval for context event coalescing in ms (default: 100). */
  contextFlushIntervalMs?: number;
  /** Minimum interval between same-status events per instance in ms (default: 200). */
  statusDedupeIntervalMs?: number;
}

export interface ProviderRuntimeEventBusMetrics {
  emitted: number;
  coalescedContext: number;
  droppedStatus: number;
  pendingContext: number;
}

/** Partial envelope before seq and eventId are assigned. */
export interface PendingEnvelope {
  timestamp: number;
  provider: ProviderName;
  instanceId: string;
  sessionId?: string;
  adapterGeneration?: number;
  turnId?: string;
  event: ProviderRuntimeEvent;
}

interface PendingContextEntry {
  pending: PendingEnvelope;
  timer: ReturnType<typeof setTimeout>;
}

interface LastStatusEntry {
  status: string;
  emittedAt: number;
}

export class ProviderRuntimeEventBus {
  private readonly contextFlushIntervalMs: number;
  private readonly statusDedupeIntervalMs: number;
  private readonly emitFn: (envelope: ProviderRuntimeEventEnvelope) => void;

  private seqByInstance = new Map<string, number>();
  private pendingContext = new Map<string, PendingContextEntry>();
  private lastStatusByInstance = new Map<string, LastStatusEntry>();

  private emitted = 0;
  private coalescedContext = 0;
  private droppedStatus = 0;

  constructor(
    emitFn: (envelope: ProviderRuntimeEventEnvelope) => void,
    options: ProviderRuntimeEventBusOptions = {},
  ) {
    this.emitFn = emitFn;
    this.contextFlushIntervalMs = options.contextFlushIntervalMs ?? 100;
    this.statusDedupeIntervalMs = options.statusDedupeIntervalMs ?? 200;
  }

  /**
   * Enqueue an event. Critical events are emitted immediately.
   * Context events are coalesced. Status events are deduplicated.
   */
  enqueue(pending: PendingEnvelope): void {
    const kind = pending.event.kind;

    if (CRITICAL_KINDS.has(kind)) {
      this.emitNow(pending);
      return;
    }

    if (kind === 'context') {
      this.coalesceContext(pending);
      return;
    }

    if (kind === 'status') {
      this.coalesceStatus(pending);
      return;
    }

    // Unknown low-priority event kind: emit immediately.
    this.emitNow(pending);
  }

  metrics(): ProviderRuntimeEventBusMetrics {
    return {
      emitted: this.emitted,
      coalescedContext: this.coalescedContext,
      droppedStatus: this.droppedStatus,
      pendingContext: this.pendingContext.size,
    };
  }

  /** Delete per-instance state when an instance is removed. */
  removeInstance(instanceId: string): void {
    const entry = this.pendingContext.get(instanceId);
    if (entry) {
      clearTimeout(entry.timer);
      // Flush the last pending context event before removing state.
      this.pendingContext.delete(instanceId);
      this.emitNow(entry.pending);
    }
    this.seqByInstance.delete(instanceId);
    this.lastStatusByInstance.delete(instanceId);
  }

  /** Flush all pending context events. Useful for controlled shutdown. */
  flushPendingContext(): void {
    for (const [instanceId, entry] of this.pendingContext) {
      clearTimeout(entry.timer);
      this.pendingContext.delete(instanceId);
      this.emitNow(entry.pending);
    }
  }

  private emitNow(pending: PendingEnvelope): void {
    const seq = this.nextSeq(pending.instanceId);
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: randomUUID(),
      seq,
      timestamp: pending.timestamp,
      provider: pending.provider,
      instanceId: pending.instanceId,
      sessionId: pending.sessionId,
      adapterGeneration: pending.adapterGeneration,
      turnId: pending.turnId,
      event: pending.event,
    };
    this.emitted++;
    this.emitFn(envelope);
  }

  private coalesceContext(pending: PendingEnvelope): void {
    const instanceId = pending.instanceId;
    const existing = this.pendingContext.get(instanceId);

    if (existing) {
      // Replace with the newer event; the previous one is coalesced away.
      clearTimeout(existing.timer);
      this.coalescedContext++;
    }

    const timer = setTimeout(() => {
      this.pendingContext.delete(instanceId);
      this.emitNow(pending);
    }, this.contextFlushIntervalMs);

    // Allow the process to exit cleanly even if this timer is pending.
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }

    this.pendingContext.set(instanceId, { pending, timer });
  }

  private coalesceStatus(pending: PendingEnvelope): void {
    const instanceId = pending.instanceId;
    const event = pending.event;
    if (event.kind !== 'status') return;

    const statusStr = event.status;
    const now = Date.now();
    const last = this.lastStatusByInstance.get(instanceId);

    if (last && last.status === statusStr && now - last.emittedAt < this.statusDedupeIntervalMs) {
      this.droppedStatus++;
      return;
    }

    this.lastStatusByInstance.set(instanceId, { status: statusStr, emittedAt: now });
    this.emitNow(pending);
  }

  private nextSeq(instanceId: string): number {
    const next = this.seqByInstance.get(instanceId) ?? 0;
    this.seqByInstance.set(instanceId, next + 1);
    return next;
  }
}
