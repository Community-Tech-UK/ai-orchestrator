/**
 * Codex CLI Provider - Uses OpenAI Codex CLI for AI interactions
 *
 * This provider wraps the CodexCliAdapter to conform to the provider interface.
 * It provides Codex CLI functionality including file operations, code execution, and tool use.
 */

import { BaseProvider } from './provider-interface';
import { CodexCliAdapter, CodexCliConfig } from '../cli/adapters/codex-cli-adapter';
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
export class CodexCliProvider extends BaseProvider {
  private adapter: CodexCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'openai'; // Maps to openai provider type
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: true,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: true,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      const cliInfo = await isCliAvailable('codex');
      return {
        type: 'openai',
        available: cliInfo.installed,
        authenticated: cliInfo.installed, // CLI handles auth internally
        error: cliInfo.installed ? undefined : cliInfo.error || 'Codex CLI not found',
      };
    } catch (error) {
      return {
        type: 'openai',
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

    // Map session options to Codex config
    // Don't specify a model by default - let Codex use its configured default
    // This avoids issues with ChatGPT accounts that don't support certain models
    const codexConfig: CodexCliConfig = {
      sessionId: options.sessionId,
      resume: options.resume,
      model: options.model || this.config.defaultModel, // undefined is OK - Codex will use its default
      approvalMode: options.yoloMode ? 'full-auto' : 'suggest',
      sandboxMode: options.yoloMode ? 'workspace-write' : 'read-only',
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      timeout: 300000,
    };

    this.adapter = new CodexCliAdapter(codexConfig);

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

    try {
      const response = await this.adapter.sendMessage({
        role: 'user',
        content: message,
        attachments: attachments?.map((attachment) => ({
          type: attachment.mimeType?.startsWith('image/') ? 'image' : 'file',
          name: attachment.name,
          mimeType: attachment.mimeType,
          content: attachment.data,
        })),
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
   * Estimate cost based on GPT-4 pricing
   */
  private estimateCost(tokens: number): number {
    // GPT-4 pricing (approximate)
    const pricePerMillion = 30; // $30 per million tokens (blended)
    return (tokens / 1_000_000) * pricePerMillion;
  }
}
