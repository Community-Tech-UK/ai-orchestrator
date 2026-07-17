/**
 * WS15 — worker-side durable event ring (queue + ack + replay).
 *
 * Every durable outbound instance event (output, state change, context,
 * completion) is recorded here with a per-instance monotonic `durableSeq`
 * BEFORE it rides the socket. The coordinator acks the highest seq it has
 * processed per instance (`node.streamAck`); on reconnect it asks for a
 * replay of everything after its cursor (`node.streamResume`). A link drop
 * longer than the coordinator's grace window therefore no longer amputates
 * output — the worker replays the gap.
 *
 * Bounded per instance by event count AND bytes (plan guardrail: bounded
 * buffers everywhere). When eviction drops unacked events, the ring records
 * the highest dropped seq so a later replay can emit an explicit gap marker
 * instead of silently pretending continuity.
 *
 * Plain data structure — no electron/socket imports (worker isolation rules).
 */

export interface DurableStreamEvent {
  seq: number;
  method: string;
  /** Frame params WITHOUT transport fields (token is re-attached at send time). */
  params: Record<string, unknown>;
  bytes: number;
}

export interface StreamReplayResult {
  events: DurableStreamEvent[];
  /**
   * Set when events between `afterSeq` and the first buffered event were
   * evicted — the replayer must surface a gap marker to the transcript.
   */
  gapThroughSeq?: number;
}

interface InstanceRing {
  nextSeq: number;
  events: DurableStreamEvent[];
  totalBytes: number;
  /** Highest seq evicted before being acked (0 = none). */
  droppedThroughSeq: number;
}

export const DEFAULT_MAX_EVENTS_PER_INSTANCE = 500;
export const DEFAULT_MAX_BYTES_PER_INSTANCE = 4 * 1024 * 1024;
const MAX_INSTANCES = 200;

export class WorkerStreamDurability {
  private readonly rings = new Map<string, InstanceRing>();

  constructor(
    private readonly maxEventsPerInstance = DEFAULT_MAX_EVENTS_PER_INSTANCE,
    private readonly maxBytesPerInstance = DEFAULT_MAX_BYTES_PER_INSTANCE,
  ) {}

  /**
   * Record a durable event and return its per-instance seq. The caller
   * includes the returned seq in the outbound frame as `durableSeq`.
   */
  record(instanceId: string, method: string, params: Record<string, unknown>): number {
    let ring = this.rings.get(instanceId);
    if (!ring) {
      if (this.rings.size >= MAX_INSTANCES) {
        const oldest = this.rings.keys().next().value;
        if (oldest !== undefined) this.rings.delete(oldest);
      }
      ring = { nextSeq: 1, events: [], totalBytes: 0, droppedThroughSeq: 0 };
      this.rings.set(instanceId, ring);
    }

    const seq = ring.nextSeq++;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(params), 'utf-8');
    } catch {
      // Unserializable params can't replay anyway — record a zero-byte shell
      // so the seq stays monotonic, but store no payload.
      ring.droppedThroughSeq = Math.max(ring.droppedThroughSeq, seq);
      return seq;
    }

    ring.events.push({ seq, method, params, bytes });
    ring.totalBytes += bytes;

    while (
      ring.events.length > this.maxEventsPerInstance ||
      ring.totalBytes > this.maxBytesPerInstance
    ) {
      const dropped = ring.events.shift();
      if (!dropped) break;
      ring.totalBytes -= dropped.bytes;
      ring.droppedThroughSeq = Math.max(ring.droppedThroughSeq, dropped.seq);
    }

    return seq;
  }

  /** Coordinator has processed everything up to and including `seq`. */
  ack(instanceId: string, seq: number): void {
    const ring = this.rings.get(instanceId);
    if (!ring) return;
    while (ring.events.length > 0 && ring.events[0].seq <= seq) {
      const acked = ring.events.shift()!;
      ring.totalBytes -= acked.bytes;
    }
  }

  /**
   * Everything buffered after `afterSeq`, plus a gap indicator when evicted
   * events fall inside the requested range.
   */
  replayAfter(instanceId: string, afterSeq: number): StreamReplayResult {
    const ring = this.rings.get(instanceId);
    if (!ring) return { events: [] };
    const events = ring.events.filter((event) => event.seq > afterSeq);
    const gap = ring.droppedThroughSeq > afterSeq;
    return {
      events,
      ...(gap ? { gapThroughSeq: ring.droppedThroughSeq } : {}),
    };
  }

  /** Instance ids with anything buffered (used to answer a blanket resume). */
  instanceIds(): string[] {
    return [...this.rings.keys()];
  }

  removeInstance(instanceId: string): void {
    this.rings.delete(instanceId);
  }

  stats(): { instances: number; events: number; bytes: number } {
    let events = 0;
    let bytes = 0;
    for (const ring of this.rings.values()) {
      events += ring.events.length;
      bytes += ring.totalBytes;
    }
    return { instances: this.rings.size, events, bytes };
  }
}
