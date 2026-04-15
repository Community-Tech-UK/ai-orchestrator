/**
 * Provider Interface - Base interface for all AI providers
 */

import { EventEmitter } from 'events';
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
 * Base provider interface that all providers must implement
 */
export abstract class BaseProvider extends EventEmitter {
  protected config: ProviderConfig;
  protected sessionId: string;
  protected isActive = false;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
    this.sessionId = '';
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
