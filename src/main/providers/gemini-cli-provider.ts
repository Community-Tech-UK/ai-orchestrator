/**
 * Gemini CLI Provider - Uses Google Gemini CLI for AI interactions
 *
 * This provider wraps the GeminiCliAdapter to conform to the provider interface.
 * It provides Gemini CLI functionality including file operations, vision, and tool use.
 */

import { BaseProvider } from './provider-interface';
import { GeminiCliAdapter, GeminiCliConfig } from '../cli/adapters/gemini-cli-adapter';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import type { OutputMessage } from '../../shared/types/instance.types';
import { isCliAvailable } from '../cli/cli-detection';
import { generateId } from '../../shared/utils/id-generator';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';

const GEMINI_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: false,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_GEMINI_CONFIG: ProviderConfig = {
  type: 'google',
  name: 'Google AI',
  enabled: false,
  // Don't set a default model - let Gemini CLI use its configured default
  // This avoids model access issues
};

export const GEMINI_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'gemini',
  displayName: 'Google Gemini',
  capabilities: GEMINI_CAPABILITIES,
  defaultConfig: DEFAULT_GEMINI_CONFIG,
};

export class GeminiCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'gemini';
  readonly capabilities: ProviderAdapterCapabilities = GEMINI_CAPABILITIES;

  private adapter: GeminiCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'google'; // Maps to google provider type
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false, // Attachment-based vision is not wired in orchestrator mode
      fileAttachments: false,
      functionCalling: true,
      builtInCodeTools: true,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      const cliInfo = await isCliAvailable('gemini');
      return {
        type: 'google',
        available: cliInfo.installed,
        authenticated: cliInfo.authenticated ?? cliInfo.installed,
        error: cliInfo.installed ? undefined : cliInfo.error || 'Gemini CLI not found',
      };
    } catch (error) {
      return {
        type: 'google',
        available: false,
        authenticated: false,
        error: (error as Error).message,
      };
    }
  }

  async initialize(options: ProviderSessionOptions): Promise<void> {
    if (this.adapter) {
      throw new Error('Provider already initialized');
    }

    this.instanceId = options.instanceId ?? '';

    // Map session options to Gemini config
    // Don't specify a model by default - let Gemini CLI use its configured default
    // This avoids model access issues (e.g., gemini-1.5-pro may not be available)
    const geminiConfig: GeminiCliConfig = {
      model: options.model || this.config.defaultModel, // undefined is OK - Gemini will use its default
      // Default yolo on: non-interactive one-shot invocation without --yolo causes
      // Gemini to remove tools requiring approval (run_shell_command, write_file, etc.)
      // from its registry. The orchestrator is the approval layer.
      yolo: options.yoloMode ?? true,
      sandbox: false,
      workingDir: options.workingDirectory,
      timeout: 300000,
    };

    this.adapter = new GeminiCliAdapter(geminiConfig);

    // Forward adapter events to the normalized envelope stream.
    // Note: Adapter emits OutputMessage objects during streaming, not plain strings
    this.adapter.on('output', (outputData: OutputMessage | string) => {
      if (typeof outputData === 'string') {
        if (outputData) {
          this.pushOutput(outputData, 'assistant');
        }
        return;
      }

      if (outputData && typeof outputData === 'object') {
        this.pushOutput(outputData);
      }
    });

    this.adapter.on('status', (status: string) => {
      this.pushStatus(status);
    });

    this.adapter.on('error', (error: Error | string) => {
      this.pushError(error instanceof Error ? error.message : String(error), false);
    });

    this.adapter.on('complete', () => {
      this.pushStatus('idle');
    });

    this.adapter.on('exit', (code: number | null, signal: string | null) => {
      this.isActive = false;
      this.pushExit(code, signal);
    });

    this.adapter.on('spawned', (pid: number) => {
      this.isActive = true;
      if (pid != null) this.pushSpawned(pid);
    });

    // Initialize the adapter
    await this.adapter.initialize();
    this.sessionId = this.adapter.getSessionId() || generateId();
    this.isActive = true;
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) {
      throw new Error('Provider not initialized');
    }

    if (attachments && attachments.length > 0) {
      throw new Error('Gemini provider does not support attachments. Vision capability is disabled.');
    }

    try {
      const response = await this.adapter.sendMessage({
        role: 'user',
        content: message,
      });

      // Update usage
      if (response.usage) {
        this.currentUsage = {
          inputTokens: response.usage.inputTokens || 0,
          outputTokens: response.usage.outputTokens || 0,
          totalTokens: response.usage.totalTokens || 0,
          estimatedCost: this.estimateCost(response.usage.totalTokens || 0),
        };
      }

      // Emit the response as output
      const outputMessage: OutputMessage = {
        id: response.id,
        timestamp: Date.now(),
        type: 'assistant',
        content: response.content,
      };
      this.pushOutput(outputMessage);
    } catch (error) {
      this.pushError(error instanceof Error ? error.message : String(error), false);
      throw error;
    }
  }

  async terminate(graceful = true): Promise<void> {
    if (this.adapter) {
      await this.adapter.terminate(graceful);
      this.adapter = null;
      this.isActive = false;
    }
  }

  override getPid(): number | null {
    return this.adapter?.getPid() || null;
  }

  override getUsage(): ProviderUsage | null {
    return this.currentUsage;
  }

  /**
   * Estimate cost based on Gemini pricing
   */
  private estimateCost(tokens: number): number {
    // Gemini Pro pricing (approximate blended rate)
    const pricePerMillion = 3.5; // $3.50 per million tokens (blended)
    return (tokens / 1_000_000) * pricePerMillion;
  }
}
