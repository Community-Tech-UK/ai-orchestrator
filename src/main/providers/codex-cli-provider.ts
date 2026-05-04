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
import type { OutputMessage } from '../../shared/types/instance.types';
import { isCliAvailable } from '../cli/cli-detection';
import { generateId } from '../../shared/utils/id-generator';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';

const CODEX_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

const DEFAULT_CODEX_TURN_TIMEOUT_MS = 900_000;

export const DEFAULT_CODEX_CONFIG: ProviderConfig = {
  type: 'openai',
  name: 'OpenAI',
  enabled: false,
  // Don't set a default model - let Codex CLI use its configured default
  // This avoids issues with ChatGPT accounts that don't support certain models
};

export const CODEX_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'codex',
  displayName: 'OpenAI Codex',
  capabilities: CODEX_CAPABILITIES,
  defaultConfig: DEFAULT_CODEX_CONFIG,
};

export class CodexCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'codex';
  readonly capabilities: ProviderAdapterCapabilities = CODEX_CAPABILITIES;

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

    this.instanceId = options.instanceId ?? '';

    // Map session options to Codex config
    // Don't specify a model by default - let Codex use its configured default
    // This avoids issues with ChatGPT accounts that don't support certain models
    const codexConfig: CodexCliConfig = {
      sessionId: options.sessionId,
      resume: options.resume,
      model: options.model || this.config.defaultModel, // undefined is OK - Codex will use its default
      approvalMode: options.yoloMode ? 'full-auto' : 'suggest',
      sandboxMode: options.yoloMode ? 'danger-full-access' : 'read-only',
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      timeout: DEFAULT_CODEX_TURN_TIMEOUT_MS,
    };

    this.adapter = new CodexCliAdapter(codexConfig);

    this.bindAdapterRuntimeEvents(this.adapter, {
      handleEvent: (runtimeEvent) => {
        switch (runtimeEvent.kind) {
          case 'complete':
            this.pushStatus('idle');
            return true;
          case 'exit':
            this.isActive = false;
            return false;
          case 'spawned':
            this.isActive = true;
            return false;
          default:
            return false;
        }
      },
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
   * Estimate cost based on GPT-4 pricing
   */
  private estimateCost(tokens: number): number {
    // GPT-4 pricing (approximate)
    const pricePerMillion = 30; // $30 per million tokens (blended)
    return (tokens / 1_000_000) * pricePerMillion;
  }
}
