import type { EventEmitter } from 'node:events';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { getLogger } from '../logging/logger';
import { getConversationLedgerService, type ConversationLedgerService } from './conversation-ledger-service';
import type { ProviderEventCaptureInput } from './provider-event-capture.types';

const logger = getLogger('ProviderEventCaptureService');
const DEFAULT_FLUSH_DELAY_MS = 150;

type LedgerCapturePort = Pick<ConversationLedgerService, 'appendProviderEventCaptures'>;

export interface ProviderEventCaptureServiceOptions {
  ledger?: LedgerCapturePort;
  flushDelayMs?: number;
}

/**
 * Batches raw-backed canonical provider events for durable replay fixtures.
 * The producer is the normalized event stream, so the capture sequence is the
 * same sequence clients observe; the SQLite write remains off the hot adapter
 * event path through ConversationLedgerService's worker-backed port.
 */
export class ProviderEventCaptureService {
  private readonly ledger: LedgerCapturePort;
  private readonly flushDelayMs: number;
  private readonly pending: ProviderEventCaptureInput[] = [];
  private source: EventEmitter | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly onNormalizedEvent = (value: unknown): void => this.enqueue(value);

  constructor(options: ProviderEventCaptureServiceOptions = {}) {
    this.ledger = options.ledger ?? getConversationLedgerService();
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
  }

  start(source: EventEmitter): void {
    if (this.source === source) return;
    if (this.source) this.source.off('provider:normalized-event', this.onNormalizedEvent);
    this.source = source;
    source.on('provider:normalized-event', this.onNormalizedEvent);
  }

  async stop(): Promise<void> {
    if (this.source) {
      this.source.off('provider:normalized-event', this.onNormalizedEvent);
      this.source = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, this.pending.length);
    this.flushing = this.ledger.appendProviderEventCaptures(batch)
      .catch((error: unknown) => {
        this.pending.unshift(...batch);
        throw error;
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private enqueue(value: unknown): void {
    const parsed = ProviderRuntimeEventEnvelopeSchema.safeParse(value);
    if (!parsed.success || !parsed.data.raw) {
      return;
    }
    this.pending.push(toCapture(parsed.data as ProviderRuntimeEventEnvelope));
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error: unknown) => {
        logger.warn('Provider event capture flush failed; batch retained for retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.flushDelayMs);
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
