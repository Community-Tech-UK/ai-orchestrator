/**
 * Claude CLI Provider - Uses Claude Code CLI for AI interactions
 *
 * This provider wraps the existing ClaudeCliAdapter to conform to
 * the provider interface. It provides full Claude Code functionality
 * including file operations, bash execution, and tool use.
 */

import { BaseProvider } from './provider-interface';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import { MODEL_PRICING, CLAUDE_MODELS } from '../../shared/types/provider.types';
import type { ContextUsage } from '../../shared/types/instance.types';
import { isCliAvailable } from '../cli/cli-detection';
import { checkClaudeCliAuthentication } from './claude-cli-auth';

// @ts-expect-error wave2-task9 — provider + capabilities declared in Task 9
export class ClaudeCliProvider extends BaseProvider {
  private adapter: ClaudeCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;
  private lastContextUsage: ContextUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'claude-cli';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: true,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: true, // Claude Code has built-in file/bash tools
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      const cliInfo = await isCliAvailable('claude');
      if (!cliInfo.installed) {
        return {
          type: 'claude-cli',
          available: false,
          authenticated: false,
          error: 'Claude CLI not found',
        };
      }

      const authStatus = await checkClaudeCliAuthentication();
      return {
        type: 'claude-cli',
        available: true,
        authenticated: authStatus.authenticated,
        error: authStatus.authenticated ? undefined : authStatus.message,
      };
    } catch (error) {
      return {
        type: 'claude-cli',
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

    this.adapter = new ClaudeCliAdapter({
      workingDirectory: options.workingDirectory,
      sessionId: options.sessionId,
      resume: options.resume,
      model: options.model || this.config.defaultModel,
      maxTokens: options.maxTokens,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
    });

    // Forward adapter events to provider events
    this.adapter.on('output', (message) => this.emit('output', message));
    this.adapter.on('status', (status) => this.emit('status', status));
    this.adapter.on('context', (usage: ContextUsage) => {
      this.lastContextUsage = usage;
      this.updateUsageFromContext(usage);
      this.emit('context', usage);
    });
    this.adapter.on('error', (error) => this.emit('error', error));
    this.adapter.on('exit', (code, signal) => {
      this.isActive = false;
      this.emit('exit', code, signal);
    });
    this.adapter.on('spawned', (pid) => {
      this.isActive = true;
      this.emit('spawned', pid);
    });

    // Spawn the CLI process
    await this.adapter.spawn();
    this.sessionId = this.adapter.getSessionId() || '';
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) {
      throw new Error('Provider not initialized');
    }

    // Convert provider attachments to CLI format
    const cliAttachments = attachments?.map((a) => ({
      name: a.name,
      type: a.mimeType,
      size: a.data.length,
      data: a.data,
    }));

    await this.adapter.sendInput(message, cliAttachments);
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
   * Update usage statistics from context usage
   */
  private updateUsageFromContext(context: ContextUsage): void {
    // Estimate cost based on model pricing
    const modelId = this.config.defaultModel || CLAUDE_MODELS.SONNET;
    const pricing = (MODEL_PRICING as any)[modelId] || { input: 3.0, output: 15.0 };

    // Context usage gives us total tokens used, estimate input/output split
    // This is approximate since we don't have exact breakdown
    const estimatedInputTokens = Math.floor(context.used * 0.7);
    const estimatedOutputTokens = context.used - estimatedInputTokens;

    const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
    const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;

    this.currentUsage = {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      totalTokens: context.used,
      estimatedCost: inputCost + outputCost,
    };
  }
}
