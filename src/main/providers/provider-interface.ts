/**
 * Provider Interface - Base interface for all AI providers
 */

import { Subject, type Observable } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import {
  observeAdapterRuntimeEvents,
  type AdapterRuntimeEventSource,
  type NormalizedAdapterRuntimeEvent,
} from './adapter-runtime-event-bridge';
import { toProviderOutputEvent } from './provider-output-event';

/**
 * Base provider interface that all providers must implement.
 *
 * Exposes a typed `events$` stream of normalized envelopes via `pushEvent()`.
 * Subclasses declare `provider` and `capabilities` and emit through the
 * `push*` helpers instead of EventEmitter inheritance.
 */
export abstract class BaseProvider implements ProviderAdapter {
  protected config: ProviderConfig;
  protected sessionId: string;
  protected instanceId = '';
  protected isActive = false;

  // New Wave 2 members:
  abstract readonly provider: ProviderName;
  abstract readonly capabilities: ProviderAdapterCapabilities;

  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$: Observable<ProviderRuntimeEventEnvelope> = this._events$.asObservable();
  private _seq = 0;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.sessionId = '';
  }

  /**
   * Build an envelope for the given event and push it onto the `events$` stream.
   * Called by subclasses directly after Wave 2 Phase 5; during Phase 1 the
   * subscribe-to-self bridge in Task 8 routes legacy `emit('output', …)`
   * through this helper via the normalizer.
   */
  protected pushEvent(event: ProviderRuntimeEvent): void {
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: randomUUID(),
      seq: this._seq++,
      timestamp: Date.now(),
      provider: this.provider,
      instanceId: this.instanceId,
      sessionId: this.sessionId || undefined,
      event,
    };
    if (process.env['NODE_ENV'] !== 'production') {
      ProviderRuntimeEventEnvelopeSchema.parse(envelope);
    }
    this._events$.next(envelope);
  }

  protected pushOutput(message: OutputMessage): void;
  protected pushOutput(content: string, messageType?: string, metadata?: Record<string, unknown>): void;
  protected pushOutput(
    contentOrMessage: OutputMessage | string,
    messageType?: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (typeof contentOrMessage !== 'string') {
      this.pushEvent(toProviderOutputEvent(contentOrMessage));
      return;
    }

    const event: ProviderRuntimeEvent = {
      kind: 'output',
      content: contentOrMessage,
    };

    if (messageType !== undefined) {
      event.messageType = messageType;
    }

    if (metadata !== undefined) {
      event.metadata = { ...metadata };
    }

    this.pushEvent(event);
  }
  protected pushToolUse(toolName: string, input?: Record<string, unknown>, toolUseId?: string): void {
    this.pushEvent({ kind: 'tool_use', toolName, input, toolUseId });
  }
  protected pushToolResult(params: { toolName: string; success: boolean; toolUseId?: string; output?: string; error?: string }): void {
    this.pushEvent({ kind: 'tool_result', ...params });
  }
  protected pushStatus(status: string): void {
    this.pushEvent({ kind: 'status', status });
  }
  protected pushContext(used: number, total: number, percentage?: number): void {
    this.pushEvent({ kind: 'context', used, total, percentage });
  }
  protected pushError(message: string, recoverable = false, details?: Record<string, unknown>): void {
    this.pushEvent({ kind: 'error', message, recoverable, details });
  }
  protected pushExit(code: number | null, signal: string | null): void {
    this.pushEvent({ kind: 'exit', code, signal });
  }
  protected pushSpawned(pid: number): void {
    this.pushEvent({ kind: 'spawned', pid });
  }
  protected pushComplete(params: { tokensUsed?: number; costUsd?: number; durationMs?: number } = {}): void {
    this.pushEvent({ kind: 'complete', ...params });
  }

  protected completeEvents(): void {
    this._events$.complete();
  }

  protected bindAdapterRuntimeEvents(
    adapter: AdapterRuntimeEventSource,
    options: {
      handleEvent?: (runtimeEvent: NormalizedAdapterRuntimeEvent) => boolean | void;
    } = {},
  ): () => void {
    return observeAdapterRuntimeEvents(adapter, (runtimeEvent) => {
      const handled = options.handleEvent?.(runtimeEvent) ?? false;
      if (!handled) {
        this.pushEvent(runtimeEvent.event);
      }
    });
  }

  /**
   * Get the provider type
   */
  abstract getType(): ProviderType;

  /**
   * Get provider capabilities
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Check if the provider is available and properly configured
   */
  abstract checkStatus(): Promise<ProviderStatus>;

  /**
   * Initialize a session with the provider
   */
  abstract initialize(options: ProviderSessionOptions): Promise<void>;

  /**
   * Send a message to the provider
   */
  abstract sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>;

  /**
   * Terminate the provider session
   */
  abstract terminate(graceful?: boolean): Promise<void>;

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if the provider session is active
   */
  isRunning(): boolean {
    return this.isActive;
  }

  /**
   * Get current usage statistics (if available)
   */
  getUsage(): ProviderUsage | null {
    return null;
  }

  /**
   * Get the process ID (for CLI-based providers)
   */
  getPid(): number | null {
    return null;
  }
}

/**
 * Factory function type for creating providers
 */
export type ProviderFactory = (config: ProviderConfig) => BaseProvider;
