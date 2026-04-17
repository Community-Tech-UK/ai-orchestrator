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
import type { OutputMessage, InstanceStatus } from '../../shared/types/instance.types';
import { isCliAvailable } from '../cli/cli-detection';
import { generateId } from '../../shared/utils/id-generator';

// @ts-expect-error wave2-task9 — provider + capabilities declared in Task 9
export class GeminiCliProvider extends BaseProvider {
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

    // Forward adapter events to provider events
    // Note: Adapter emits OutputMessage objects during streaming, not plain strings
    this.adapter.on('output', (outputData: OutputMessage | string) => {
      if (typeof outputData === 'string') {
        // Plain string content
        const message: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'assistant',
          content: outputData,
        };
        this.emit('output', message);
      } else if (outputData && typeof outputData === 'object') {
        // OutputMessage object from adapter
        const content = outputData.content;
        if (typeof content === 'string' && content) {
          const message: OutputMessage = {
            id: outputData.id || generateId(),
            timestamp: outputData.timestamp || Date.now(),
            type: outputData.type || 'assistant',
            content,
            metadata: outputData.metadata,
          };
          this.emit('output', message);
        }
      }
    });

    this.adapter.on('status', (status: string) => {
      this.emit('status', status as InstanceStatus);
    });

    this.adapter.on('error', (error: Error | string) => {
      if (typeof error === 'string') {
        this.emit('error', new Error(error));
      } else {
        this.emit('error', error);
      }
    });

    this.adapter.on('complete', () => {
      this.emit('status', 'idle' as InstanceStatus);
    });

    this.adapter.on('exit', (code: number | null, signal: string | null) => {
      this.isActive = false;
      this.emit('exit', code, signal);
    });

    this.adapter.on('spawned', (pid: number) => {
      this.isActive = true;
      this.emit('spawned', pid);
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
      this.emit('output', outputMessage);
    } catch (error) {
      this.emit('error', error as Error);
      throw error;
    }
  }

  async terminate(graceful: boolean = true): Promise<void> {
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
