import type { Observable } from 'rxjs';
import type {
  ProviderName,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type {
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
  ProviderCapabilities,
} from '@shared/types/provider.types';

/**
 * Adapter-level capability flags — distinct from the existing model-capability
 * `ProviderCapabilities` (toolExecution/streaming/vision/...). These flags
 * answer "what can the runtime adapter do", not "what does the model support".
 */
export interface ProviderAdapterCapabilities {
  /** Supports `interruptTurn()` / mid-turn cancellation. */
  readonly interruption: boolean;
  /** Surfaces tool-use confirmation prompts. */
  readonly permissionPrompts: boolean;
  /** Can resume against a persisted session id. */
  readonly sessionResume: boolean;
  /** Emits streaming `output` events mid-turn (not batch-on-complete). */
  readonly streamingOutput: boolean;
  /** `getUsage()` returns real data. */
  readonly usageReporting: boolean;
  /** Spawns sub-agents (Claude Task tool, etc.). */
  readonly subAgents: boolean;
}

/**
 * Unified provider adapter contract. Consumers subscribe to `events$` for a
 * typed envelope stream and invoke the existing lifecycle methods unchanged.
 *
 * Wave 2 addition. See docs/superpowers/specs/2026-04-17-wave2-provider-normalization-design.md.
 */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly events$: Observable<ProviderRuntimeEventEnvelope>;

  getCapabilities(): ProviderCapabilities;
  checkStatus(): Promise<ProviderStatus>;
  initialize(options: ProviderSessionOptions): Promise<void>;
  sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>;
  terminate(graceful?: boolean): Promise<void>;
  getUsage(): ProviderUsage | null;
  getPid(): number | null;
  isRunning(): boolean;
  getSessionId(): string;
}
