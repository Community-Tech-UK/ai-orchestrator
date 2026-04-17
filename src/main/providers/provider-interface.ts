/**
 * Provider Interface - Base interface for all AI providers
 */

import { EventEmitter } from 'events';
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
import type { OutputMessage, InstanceStatus, ContextUsage } from '../../shared/types/instance.types';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';

/**
 * Events emitted by providers
 */
export interface ProviderEvents {
  'output': (message: OutputMessage) => void;
  'status': (status: InstanceStatus) => void;
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number | null) => void;
}

/**
 * Base provider interface that all providers must implement.
 *
 * Wave 2 addition: implements `ProviderAdapter` and exposes a typed
 * `events$` stream of normalized envelopes via `pushEvent()`. Subclasses
 * declare `provider` and `capabilities` so consumers can route events
 * by CLI family and inspect adapter-level flags.
 */
export abstract class BaseProvider extends EventEmitter implements ProviderAdapter {
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
    super();
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

  protected completeEvents(): void {
    this._events$.complete();
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
