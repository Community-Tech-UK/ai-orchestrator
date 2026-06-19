/**
 * Antigravity CLI Provider — uses the Google Antigravity CLI (`agy`).
 *
 * Successor to the retired Gemini CLI provider. Wraps AntigravityCliAdapter to
 * conform to the provider interface (file operations, tool use, shell).
 */

import { BaseProvider } from './provider-interface';
import { AntigravityCliAdapter, AntigravityCliConfig } from '../cli/adapters/antigravity-cli-adapter';
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
import { computeTokenCost } from '../../shared/data/model-pricing';
import { isCliAvailable } from '../cli/cli-detection';
import { generateId } from '../../shared/utils/id-generator';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';

const ANTIGRAVITY_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: false,
  streamingOutput: true,
  usageReporting: false,
  subAgents: false,
};

export const DEFAULT_ANTIGRAVITY_CONFIG: ProviderConfig = {
  type: 'google',
  name: 'Antigravity',
  enabled: false,
  // Don't set a default model - let agy use its configured default.
};

export const ANTIGRAVITY_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'antigravity',
  displayName: 'Antigravity',
  capabilities: ANTIGRAVITY_CAPABILITIES,
  defaultConfig: DEFAULT_ANTIGRAVITY_CONFIG,
};

export class AntigravityCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'antigravity';
  readonly capabilities: ProviderAdapterCapabilities = ANTIGRAVITY_CAPABILITIES;

  private adapter: AntigravityCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'google';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: false,
      functionCalling: true,
      builtInCodeTools: true,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      const cliInfo = await isCliAvailable('antigravity');
      return {
        type: 'google',
        available: cliInfo.installed,
        authenticated: cliInfo.authenticated ?? cliInfo.installed,
        error: cliInfo.installed ? undefined : cliInfo.error || 'Antigravity CLI (agy) not found',
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

    const antigravityConfig: AntigravityCliConfig = {
      model: options.model || this.config.defaultModel,
      // Default auto-approve on: non-interactive one-shot invocation without
      // --dangerously-skip-permissions blocks on permission prompts. The
      // orchestrator is the approval layer.
      yolo: options.yoloMode ?? true,
      sandbox: false,
      workingDir: options.workingDirectory,
      timeout: 300000,
    };

    this.adapter = new AntigravityCliAdapter(antigravityConfig);

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

    await this.adapter.initialize();
    this.sessionId = this.adapter.getSessionId() || generateId();
    this.isActive = true;
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) {
      throw new Error('Provider not initialized');
    }

    if (attachments && attachments.length > 0) {
      throw new Error('Antigravity provider does not support attachments. Vision capability is disabled.');
    }

    try {
      const response = await this.adapter.sendMessage({
        role: 'user',
        content: message,
      });

      if (response.usage) {
        const inputTokens = response.usage.inputTokens || 0;
        const outputTokens = response.usage.outputTokens || 0;
        this.currentUsage = {
          inputTokens,
          outputTokens,
          totalTokens: response.usage.totalTokens || 0,
          estimatedCost: computeTokenCost(this.config.defaultModel, { inputTokens, outputTokens }),
        };
      }

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
}
