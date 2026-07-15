import type { EventEmitter } from 'node:events';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getConversationLedgerService, type ConversationLedgerService } from './conversation-ledger-service';
import type { ProviderEventCaptureInput } from './provider-event-capture.types';

const logger = getLogger('ProviderEventCaptureService');
const DEFAULT_FLUSH_DELAY_MS = 150;
const RETRY_FLUSH_DELAY_MS = 1_000;

/** Keep a ledger IPC write small even after a long-running provider burst. */
export const MAX_PROVIDER_EVENT_CAPTURE_BATCH_SIZE = 250;

type LedgerCapturePort = Pick<ConversationLedgerService, 'appendProviderEventCaptures'>;

export interface ProviderEventCaptureServiceOptions {
  ledger?: LedgerCapturePort;
  flushDelayMs?: number;
}

/**
 * Batches raw-backed provider ingress events for durable replay fixtures. This
 * subscribes before renderer-facing event coalescing, so a forensic capture
 * never loses an adapter event merely because the UI only needs its latest
 * context/status state. SQLite writes remain off the hot adapter path through
 * ConversationLedgerService's worker-backed port.
 */
export class ProviderEventCaptureService {
  private readonly ledger: LedgerCapturePort;
  private readonly flushDelayMs: number;
  private readonly pending: ProviderEventCaptureInput[] = [];
  private source: EventEmitter | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private unregisterCleanup: (() => void) | null = null;
  private readonly onRawEvent = (value: unknown): void => this.enqueue(value);

  constructor(options: ProviderEventCaptureServiceOptions = {}) {
    this.ledger = options.ledger ?? getConversationLedgerService();
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
  }

  start(source: EventEmitter): void {
    if (this.source === source) return;
    if (this.source) this.source.off('provider:raw-event', this.onRawEvent);
    this.source = source;
    source.on('provider:raw-event', this.onRawEvent);
    this.unregisterCleanup ??= registerCleanup(() => this.stop());
  }

  async stop(): Promise<void> {
    this.unregisterCleanup?.();
    this.unregisterCleanup = null;
    if (this.source) {
      this.source.off('provider:raw-event', this.onRawEvent);
      this.source = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // A final adapter event can arrive after the active write snapshots its
    // batch but before the listener is detached. Drain until the snapshot and
    // every such queued event have reached the ledger; `source` is deliberately
    // null here, so the normal timer-based follow-up cannot be relied on.
    do {
      await this.flush();
    } while (this.pending.length > 0 || this.flushing);
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, MAX_PROVIDER_EVENT_CAPTURE_BATCH_SIZE);
    let followUpDelayMs = this.flushDelayMs;
    this.flushing = this.ledger.appendProviderEventCaptures(batch)
      .catch((error: unknown) => {
        this.pending.unshift(...batch);
        followUpDelayMs = RETRY_FLUSH_DELAY_MS;
        throw error;
      })
      .finally(() => {
        this.flushing = null;
        // `enqueue` intentionally does not create a second timer while a
        // write is active. Schedule it here so events received mid-write are
        // never left in memory until an unrelated future event arrives.
        if (this.pending.length > 0 && this.source) {
          this.scheduleFlush(followUpDelayMs);
        }
      });
    return this.flushing;
  }

  private enqueue(value: unknown): void {
    const parsed = ProviderRuntimeEventEnvelopeSchema.safeParse(value);
    if (!parsed.success || !parsed.data.raw) {
      return;
    }
    this.pending.push(toCapture(parsed.data as ProviderRuntimeEventEnvelope));
    this.scheduleFlush(this.flushDelayMs);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.pending.length === 0 || this.flushTimer || this.flushing || !this.source) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error: unknown) => {
        logger.warn('Provider event capture flush failed; batch retained for retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    this.flushTimer.unref?.();
  }
}

function toCapture(envelope: ProviderRuntimeEventEnvelope): ProviderEventCaptureInput {
  return {
    eventId: envelope.eventId,
    provider: envelope.provider,
    instanceId: envelope.instanceId,
    sessionId: envelope.sessionId ?? null,
    sequence: envelope.seq,
    createdAt: envelope.timestamp,
    event: envelope.event,
    raw: envelope.raw!,
  };
}

let providerEventCaptureService: ProviderEventCaptureService | null = null;

export function getProviderEventCaptureService(): ProviderEventCaptureService {
  providerEventCaptureService ??= new ProviderEventCaptureService();
  return providerEventCaptureService;
}

export async function _resetProviderEventCaptureServiceForTesting(): Promise<void> {
  await providerEventCaptureService?.stop();
  providerEventCaptureService = null;
}
