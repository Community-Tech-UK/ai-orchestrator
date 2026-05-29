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
import { CLAUDE_MODELS, normalizeModelForProvider } from '../../shared/types/provider.types';
import { computeTokenCost } from '../../shared/data/model-pricing';
import type { ContextUsage } from '../../shared/types/instance.types';
import { isCliAvailable } from '../cli/cli-detection';
import { checkClaudeCliAuthentication } from './claude-cli-auth';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';

const CLAUDE_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: true,
};

export const DEFAULT_CLAUDE_CONFIG: ProviderConfig = {
  type: 'claude-cli',
  name: 'Claude Code CLI',
  enabled: true,
  defaultModel: CLAUDE_MODELS.OPUS_1M,
};

export const CLAUDE_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Code',
  capabilities: CLAUDE_CAPABILITIES,
  defaultConfig: DEFAULT_CLAUDE_CONFIG,
};

export class ClaudeCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'claude';
  readonly capabilities: ProviderAdapterCapabilities = CLAUDE_CAPABILITIES;

  private adapter: ClaudeCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

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

    this.instanceId = options.instanceId ?? '';
    const model = normalizeModelForProvider(
      'claude',
      options.model,
      this.config.defaultModel || CLAUDE_MODELS.OPUS_1M,
    ) || this.config.defaultModel || CLAUDE_MODELS.OPUS_1M;

    this.adapter = new ClaudeCliAdapter({
      workingDirectory: options.workingDirectory,
      sessionId: options.sessionId,
      resume: options.resume,
      model,
      maxTokens: options.maxTokens,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
    });

    this.bindAdapterRuntimeEvents(this.adapter, {
      handleEvent: (runtimeEvent) => {
        switch (runtimeEvent.kind) {
          case 'context':
            this.updateUsageFromContext(runtimeEvent.rawPayload);
            return false;
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
   * Update usage statistics from context usage
   */
  private updateUsageFromContext(context: ContextUsage): void {
    const modelId = this.config.defaultModel || CLAUDE_MODELS.OPUS_1M;

    // Prefer the real input/output split the stream reports (Claude's
    // stream-json result/usage carries it); only fall back to a coarse 70/30
    // estimate when the provider didn't break tokens down.
    const hasRealSplit =
      context.inputTokens !== undefined || context.outputTokens !== undefined;
    const inputTokens = hasRealSplit
      ? context.inputTokens ?? 0
      : Math.floor(context.used * 0.7);
    const outputTokens = hasRealSplit
      ? context.outputTokens ?? 0
      : Math.max(0, context.used - Math.floor(context.used * 0.7));
    const totalTokens = context.used || inputTokens + outputTokens;

    // Prefer the provider-reported dollar cost (Claude's `total_cost_usd`,
    // surfaced as `costEstimate`) which already accounts for exact cache
    // pricing; otherwise price the token split with the shared table rather
    // than re-deriving cost by hand.
    const estimatedCost =
      context.costEstimate !== undefined
        ? context.costEstimate
        : computeTokenCost(modelId, { inputTokens, outputTokens });

    this.currentUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost,
    };
  }
}
