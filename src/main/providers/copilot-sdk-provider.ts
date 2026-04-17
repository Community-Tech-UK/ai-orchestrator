/**
 * Copilot SDK Provider - Uses GitHub Copilot CLI for AI interactions
 *
 * This provider wraps the CopilotSdkAdapter (which drives @github/copilot-sdk)
 * to conform to the shared provider interface. Unlike the other CLI providers,
 * the Copilot adapter delegates process management to the SDK: the underlying
 * Copilot CLI is spawned and communicated with over JSON-RPC internally, so the
 * adapter exposes `spawn()` / `sendInput()` rather than `initialize()` /
 * `sendMessage()`. Results stream back via `output` / `status` / `context`
 * events rather than sendMessage's return value, so this wrapper does not
 * re-emit a synthetic assistant message from `sendMessage()` — the adapter's
 * own `output` events already cover that.
 *
 * Note on identity: `provider` is `'copilot'` because ProviderName names the
 * CLI transport, not the model family. Copilot routes across Claude / GPT /
 * Gemini / Llama models through one CLI, so the caller selects the backing
 * model via `options.model`.
 */

import { BaseProvider } from './provider-interface';
import { CopilotSdkAdapter, CopilotSdkConfig } from '../cli/adapters/copilot-sdk-adapter';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import { MODEL_PRICING, COPILOT_MODELS } from '../../shared/types/provider.types';
import type { OutputMessage, InstanceStatus, ContextUsage } from '../../shared/types/instance.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import { generateId } from '../../shared/utils/id-generator';

const COPILOT_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  // SDK uses approveAll by default; orchestrator does not mediate tool-use prompts today.
  permissionPrompts: false,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_COPILOT_CONFIG: ProviderConfig = {
  type: 'copilot',
  name: 'GitHub Copilot CLI',
  enabled: false,
  // Copilot dynamically fetches available models from the CLI at runtime; don't pin a default.
};

export const COPILOT_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'copilot',
  displayName: 'GitHub Copilot',
  capabilities: COPILOT_CAPABILITIES,
  defaultConfig: DEFAULT_COPILOT_CONFIG,
};

export class CopilotSdkProvider extends BaseProvider {
  readonly provider: ProviderName = 'copilot';
  readonly capabilities: ProviderAdapterCapabilities = COPILOT_CAPABILITIES;

  private adapter: CopilotSdkAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'copilot';
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
      // The Copilot adapter probes the SDK directly rather than going through
      // the CLI detection service; we do the same by constructing a throwaway
      // adapter just for checkStatus().
      const probe = new CopilotSdkAdapter();
      const cliStatus = await probe.checkStatus();
      return {
        type: 'copilot',
        available: cliStatus.available,
        authenticated: cliStatus.authenticated ?? cliStatus.available,
        error: cliStatus.available ? undefined : cliStatus.error || 'Copilot CLI not available',
      };
    } catch (error) {
      return {
        type: 'copilot',
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

    // Map session options to Copilot SDK config. If no model is supplied we
    // fall back to the provider config default; the adapter itself will
    // ultimately fall back to 'gpt-4' if neither is set.
    const copilotConfig: CopilotSdkConfig = {
      model: options.model || this.config.defaultModel,
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
      timeout: 300000,
    };

    this.adapter = new CopilotSdkAdapter(copilotConfig);

    // Forward adapter events to provider events. The Copilot adapter already
    // emits fully-formed OutputMessage objects (including streaming deltas,
    // tool-use, tool-result variants) so we pass them through as-is.
    this.adapter.on('output', (message: OutputMessage) => {
      this.emit('output', message);
    });

    this.adapter.on('status', (status: string) => {
      this.emit('status', status as InstanceStatus);
    });

    this.adapter.on('context', (usage: ContextUsage) => {
      this.updateUsageFromContext(usage);
      this.emit('context', usage);
    });

    this.adapter.on('error', (error: Error | string) => {
      if (typeof error === 'string') {
        this.emit('error', new Error(error));
      } else {
        this.emit('error', error);
      }
    });

    this.adapter.on('exit', (code: number | null, signal: string | null) => {
      this.isActive = false;
      this.emit('exit', code, signal);
    });

    this.adapter.on('spawned', (pid: number) => {
      this.isActive = true;
      this.emit('spawned', pid);
    });

    // spawn() starts the SDK client + session and returns a synthetic PID
    // (the SDK does not expose the underlying process PID).
    await this.adapter.spawn();
    this.sessionId = this.adapter.getSessionId() || generateId();
    this.isActive = true;
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) {
      throw new Error('Provider not initialized');
    }

    try {
      // sendInput() is the Copilot adapter's analogue of sendMessage(). It does
      // not return a response object — completion arrives via the `output`
      // events set up in initialize(). Usage is updated via `context` events
      // handled in initialize(), which populate this.currentUsage.
      await this.adapter.sendInput(
        message,
        attachments?.map((a) => ({
          name: a.name,
          type: a.type,
          mimeType: a.mimeType,
          data: a.data,
        })),
      );
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
    // The Copilot SDK does not expose the underlying CLI PID; the adapter
    // always returns null here. Kept for interface symmetry.
    return this.adapter?.getPid() ?? null;
  }

  override getUsage(): ProviderUsage | null {
    return this.currentUsage;
  }

  /**
   * Update usage statistics from context usage.
   *
   * Mirrors ClaudeCliProvider.updateUsageFromContext: context events give us
   * the running total token count but no input/output split, so we estimate
   * 70/30 to derive per-side cost. Model pricing falls back to Sonnet-class
   * rates when the selected Copilot model is not in MODEL_PRICING.
   */
  private updateUsageFromContext(context: ContextUsage): void {
    const modelId = this.config.defaultModel || COPILOT_MODELS.CLAUDE_SONNET_46;
    const pricing = (MODEL_PRICING as Record<string, { input: number; output: number }>)[modelId]
      || { input: 3.0, output: 15.0 };

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
