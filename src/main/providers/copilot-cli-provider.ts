/**
 * Copilot CLI Provider - Uses the GitHub Copilot CLI (`copilot` binary) for AI
 * interactions.
 *
 * This provider wraps the CopilotCliAdapter, which spawns `copilot -p` child
 * processes per message (exec-per-message pattern, like Gemini) rather than
 * managing a persistent interactive session. Multi-turn is achieved transparently
 * via `--resume=<sessionId>` once the first turn completes.
 *
 * Predecessor note: this replaces the former `copilot-sdk-provider` which wrapped
 * `@github/copilot-sdk`. The SDK had repeated ESM packaging issues (e.g. missing
 * `.js` subpath imports in vscode-jsonrpc) that broke the packaged DMG; spawning
 * the standalone CLI directly drops that fragility and matches the shape of
 * every other provider in this project (Claude, Codex, Gemini).
 *
 * The adapter emits `output` / `status` / `context` events that we forward onto
 * the normalized provider events$ stream. `sendMessage()` does not return an
 * assistant message — completion is observed via the adapter's `output` events.
 *
 * Note on identity: `provider` is `'copilot'` because ProviderName names the
 * CLI transport, not the model family. Copilot routes across Claude / GPT /
 * Gemini / Llama models through one CLI, so the caller selects the backing
 * model via `options.model`.
 */

import { BaseProvider } from './provider-interface';
import { CopilotCliAdapter, CopilotCliConfig } from '../cli/adapters/copilot-cli-adapter';
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
import type { OutputMessage, ContextUsage } from '../../shared/types/instance.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import { generateId } from '../../shared/utils/id-generator';

const COPILOT_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  // CLI runs with --allow-all-tools + --allow-all-paths/--allow-all-urls; the
  // orchestrator does not mediate tool-use prompts today.
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

export class CopilotCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'copilot';
  readonly capabilities: ProviderAdapterCapabilities = COPILOT_CAPABILITIES;

  private adapter: CopilotCliAdapter | null = null;
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
      // Build a throwaway adapter just to probe the CLI. checkStatus() on
      // CopilotCliAdapter runs `copilot --version` in a 5-second timeout.
      const probe = new CopilotCliAdapter();
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

    this.instanceId = options.instanceId ?? '';

    // Map session options to Copilot CLI config. If no model is supplied we
    // fall back to the provider config default; the adapter itself will let
    // the CLI use the user's configured default when neither is set.
    const copilotConfig: CopilotCliConfig = {
      model: options.model || this.config.defaultModel,
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
      timeout: 300000,
    };

    this.adapter = new CopilotCliAdapter(copilotConfig);

    // Forward adapter events directly to the normalized events$ stream via
    // push* helpers (inline translation — no legacy this.emit relay).
    this.adapter.on('output', (message: OutputMessage) => {
      this.pushOutput(message);
    });

    this.adapter.on('status', (status: string) => {
      this.pushStatus(status);
    });

    this.adapter.on('context', (usage: ContextUsage) => {
      this.updateUsageFromContext(usage);
      this.pushContext(usage.used, usage.total, usage.percentage);
    });

    this.adapter.on('error', (error: Error | string) => {
      this.pushError(error instanceof Error ? error.message : String(error), false);
    });

    this.adapter.on('exit', (code: number | null, signal: string | null) => {
      this.isActive = false;
      this.pushExit(code, signal);
    });

    this.adapter.on('spawned', (pid: number) => {
      this.isActive = true;
      if (pid != null) this.pushSpawned(pid);
    });

    // spawn() validates the CLI is available and marks the adapter ready.
    // Multi-turn is handled transparently via --resume on subsequent sendInputs.
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
    // The Copilot CLI adapter runs exec-per-message, so there is no stable
    // long-lived PID. Kept for interface symmetry.
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
