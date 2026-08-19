/**
 * Queue-while-busy for phone-sent messages.
 *
 * The desktop renderer owns this behaviour for its own composer
 * (`instance-messaging.store.ts` → `isTransientQueueStatus` → `enqueueMessage`).
 * The mobile gateway is a main-process peer of the renderer, so it had no share
 * of that logic: a message sent while a turn was running went straight at the
 * provider adapter, which rejected it ("Codex app-server runtime already has an
 * active turn") and lost the message behind an HTTP 500.
 *
 * This module is the gateway's equivalent: park the message, deliver it in
 * order on the next ready edge. It deliberately queues only for statuses we
 * know are mid-turn or transitioning — every other status keeps the previous
 * send-now behaviour, so nothing that worked before changes shape.
 *
 * Queues live in memory only. They do not survive a Harness restart, and the
 * phone is told what is pending through the snapshot so nothing is silently held.
 */

import type { ServerResponse } from 'http';
import type { FileAttachment, Instance } from '../../shared/types/instance.types';
import type { MobileQueuedMessageDto } from '../../shared/types/mobile-gateway.types';
import { sendJsonResponse } from './mobile-gateway-http-utils';

/** Per-instance cap. Attachments sit in memory until delivered, so this is bounded. */
export const MAX_QUEUED_PER_INSTANCE = 20;
/** Delivery attempts across ready edges before the head is parked as failed. */
export const MAX_DELIVERY_ATTEMPTS = 3;
/**
 * Re-check a still-loaded queue this long after a delivery, in case that
 * delivery produced no status edge to ride. Mirrors the desktop queue watchdog.
 */
export const FOLLOW_UP_DRAIN_MS = 2000;

/**
 * Statuses where the session cannot take a new prompt right now but is expected
 * to become ready on its own. Mirrors the renderer's `isTransientQueueStatus`,
 * minus `hibernated` (which needs an explicit wake, and whose direct-send
 * behaviour we leave untouched).
 */
const QUEUE_STATUSES = new Set<string>([
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_permission',
  'respawning',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'initializing',
  'waking',
  'hibernating',
  'degraded',
]);

/** Statuses that can accept input immediately (renderer `isReadyForInputStatus`). */
const READY_STATUSES = new Set<string>(['idle', 'ready', 'waiting_for_input']);

/** Terminal statuses — a queued message can never be delivered from here. */
const TERMINAL_STATUSES = new Set<string>([
  'failed',
  'error',
  'terminated',
  'cancelled',
  'superseded',
]);

export interface QueuedInput {
  id: string;
  message: string;
  attachments?: FileAttachment[];
  enqueuedAt: number;
  attempts: number;
  error?: string;
}

/** The slice of an instance the queue reasons about. */
type QueueInstanceView = Pick<Instance, 'status' | 'waitReason'>;

/**
 * An idle instance parked on a provider quota window: main resends the throttled
 * turn itself when the window resets, so a new send must not race it.
 */
function isQuotaParked(instance: QueueInstanceView): boolean {
  return instance.waitReason?.kind === 'quota-park';
}

/** True when a send must be parked instead of delivered now. */
export function shouldQueueInput(instance: QueueInstanceView, paused: boolean): boolean {
  if (paused) return true;
  if (QUEUE_STATUSES.has(instance.status)) return true;
  return isQuotaParked(instance);
}

/** True when a parked message can be delivered right now. */
export function isReadyForQueuedInput(instance: QueueInstanceView, paused: boolean): boolean {
  if (paused) return false;
  if (!READY_STATUSES.has(instance.status)) return false;
  return !isQuotaParked(instance);
}

export function isTerminalForQueue(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface MobileInputQueueDeps {
  /** Live instance lookup; `undefined` means the session is gone. */
  getInstance(instanceId: string): QueueInstanceView | undefined;
  /**
   * True when this instance cannot take a queued delivery right now: the
   * orchestrator is globally paused, OR (LT-181) a send is already in flight
   * for this instance — either a direct one or this queue's own drained
   * delivery, since both go through `dispatchSend()`. The latter matters because
   * `instance.status` does not flip to a busy status until the adapter's
   * `sendInputImpl` actually runs, so the drain safety-net below — triggered
   * right after enqueueing, precisely to catch a ready edge that already
   * passed — must not treat that window as "ready" and redeliver into the
   * same in-flight send.
   */
  isPaused(instanceId: string): boolean;
  /** Actual delivery. Rejects exactly like `InstanceManager.sendInput`. */
  deliver(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<void>;
  /** Called whenever the queue contents changed, so the snapshot can be re-broadcast. */
  onChange(instanceId: string): void;
  logger: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
  /** Injectable clock + id source so tests stay deterministic. */
  now?: () => number;
  nextId?: () => string;
}

export class MobileInputQueue {
  private readonly queues = new Map<string, QueuedInput[]>();
  /** Instances with a drain running, so concurrent ready edges don't double-send. */
  private readonly draining = new Set<string>();
  /** Pending follow-up drains, keyed by instance, so they can be cancelled. */
  private readonly followUps = new Map<string, ReturnType<typeof setTimeout>>();
  private idCounter = 0;

  constructor(private readonly deps: MobileInputQueueDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private nextId(): string {
    if (this.deps.nextId) return this.deps.nextId();
    this.idCounter += 1;
    return `q${this.now().toString(36)}-${this.idCounter}`;
  }

  /**
   * Park a message. Returns null when the instance's queue is full — the caller
   * surfaces that as a rejection rather than dropping the message quietly.
   */
  enqueue(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
  ): QueuedInput | null {
    const queue = this.queues.get(instanceId) ?? [];
    if (queue.length >= MAX_QUEUED_PER_INSTANCE) {
      return null;
    }
    const item: QueuedInput = {
      id: this.nextId(),
      message,
      attachments,
      enqueuedAt: this.now(),
      attempts: 0,
    };
    queue.push(item);
    this.queues.set(instanceId, queue);
    this.deps.onChange(instanceId);
    return item;
  }

  /** Queue depth for one instance. */
  size(instanceId: string): number {
    return this.queues.get(instanceId)?.length ?? 0;
  }

  /** Wire form of one instance's queue, or undefined when empty. */
  toDto(instanceId: string): MobileQueuedMessageDto[] | undefined {
    const queue = this.queues.get(instanceId);
    if (!queue || queue.length === 0) return undefined;
    return queue.map((item) => ({
      id: item.id,
      message: item.message,
      hasAttachments: Boolean(item.attachments?.length),
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      ...(item.error ? { error: item.error } : {}),
    }));
  }

  /** Remove one parked message. Returns it so the caller can hand the text back. */
  cancel(instanceId: string, queueId: string): QueuedInput | null {
    const queue = this.queues.get(instanceId);
    if (!queue) return null;
    const index = queue.findIndex((item) => item.id === queueId);
    if (index < 0) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(instanceId);
    this.deps.onChange(instanceId);
    return removed;
  }

  /** Drop everything parked for an instance (session removed, gateway stopping). */
  clear(instanceId: string): void {
    this.cancelFollowUp(instanceId);
    const dropped = this.queues.get(instanceId);
    if (!this.queues.delete(instanceId)) return;
    if (dropped?.length) {
      // Last trace of text the user sent that will now never be delivered.
      this.deps.logger.warn('Dropping queued mobile messages for a gone session', {
        instanceId,
        count: dropped.length,
        previews: dropped.map((item) => item.message.slice(0, 120)),
      });
    }
    this.deps.onChange(instanceId);
  }

  clearAll(): void {
    for (const instanceId of [...this.followUps.keys()]) this.cancelFollowUp(instanceId);
    this.queues.clear();
    this.draining.clear();
  }

  /**
   * Deliver at most one parked message, then wait for the next ready edge — the
   * same one-per-edge cadence the desktop queue uses. Delivering back-to-back
   * would race the status flip to `busy` and burn a retry on the very rejection
   * the queue exists to avoid.
   *
   * Safe to call on every status change: it no-ops when the queue is empty, the
   * instance isn't ready, or a drain is already running for that instance.
   */
  async drain(instanceId: string): Promise<void> {
    if (this.draining.has(instanceId)) return;
    if (this.size(instanceId) === 0) return;
    this.draining.add(instanceId);
    try {
      await this.deliverNext(instanceId);
    } finally {
      this.draining.delete(instanceId);
    }
    // Safety net for the case where delivery produced no status edge at all;
    // a no-op when the session is (correctly) busy with the message we just sent.
    if (this.size(instanceId) > 0) this.scheduleFollowUp(instanceId);
  }

  private async deliverNext(instanceId: string): Promise<void> {
    const queue = this.queues.get(instanceId);
    const head = queue?.[0];
    if (!queue || !head) return;
    // A head that already exhausted its retries blocks the queue on purpose:
    // silently reordering the user's messages would be worse than stopping.
    if (head.error) return;

    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.clear(instanceId);
      return;
    }
    if (isTerminalForQueue(instance.status)) {
      this.failHead(instanceId, head, `Session ended (${instance.status}) before this was sent`);
      return;
    }
    if (!isReadyForQueuedInput(instance, this.deps.isPaused(instanceId))) return;

    head.attempts += 1;
    try {
      await this.deps.deliver(instanceId, head.message, head.attachments);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (head.attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.failHead(instanceId, head, reason);
      } else {
        this.deps.logger.warn('Mobile queued message delivery failed; will retry', {
          instanceId,
          queueId: head.id,
          attempts: head.attempts,
          error: reason,
        });
        this.deps.onChange(instanceId);
      }
      return;
    }

    // Re-read: the queue may have been cancelled/cleared while we awaited.
    const current = this.queues.get(instanceId);
    if (current?.[0]?.id === head.id) {
      current.shift();
      if (current.length === 0) this.queues.delete(instanceId);
    }
    this.deps.logger.info('Delivered queued mobile message', {
      instanceId,
      queueId: head.id,
      remaining: this.size(instanceId),
    });
    this.deps.onChange(instanceId);
  }

  private scheduleFollowUp(instanceId: string): void {
    if (this.followUps.has(instanceId)) return;
    const timer = setTimeout(() => {
      this.followUps.delete(instanceId);
      void this.drain(instanceId);
    }, FOLLOW_UP_DRAIN_MS);
    timer.unref?.();
    this.followUps.set(instanceId, timer);
  }

  private cancelFollowUp(instanceId: string): void {
    const timer = this.followUps.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.followUps.delete(instanceId);
    }
  }

  private failHead(instanceId: string, head: QueuedInput, reason: string): void {
    head.error = reason;
    this.deps.logger.warn('Mobile queued message parked after failed delivery', {
      instanceId,
      queueId: head.id,
      attempts: head.attempts,
      error: reason,
    });
    this.deps.onChange(instanceId);
  }
}

/**
 * `DELETE /api/instances/:id/queue/:queueId` — cancel one parked message.
 * Returns true when the request was handled (so the server can stop routing).
 */
export function handleMobileQueueRoutes(
  queue: MobileInputQueue,
  res: ServerResponse,
  segments: string[],
  method: string,
): boolean {
  if (segments[1] !== 'instances' || segments[3] !== 'queue') return false;
  if (segments.length !== 5 || method !== 'DELETE') return false;
  const instanceId = decodeURIComponent(segments[2]);
  const queueId = decodeURIComponent(segments[4]);
  const removed = queue.cancel(instanceId, queueId);
  if (!removed) {
    sendJsonResponse(res, 404, { error: 'Queued message not found' });
    return true;
  }
  sendJsonResponse(res, 200, { ok: true, message: removed.message });
  return true;
}
