/**
 * Cursor CLI Provider - Uses the Cursor CLI (`cursor-agent` binary) for AI
 * interactions.
 *
 * This provider wraps the CursorCliAdapter, which spawns `cursor-agent` child
 * processes per message (exec-per-message pattern, like Gemini / Copilot)
 * rather than managing a persistent interactive session. Multi-turn is
 * achieved transparently via `--resume=<session_id>` once the first turn
 * completes — Cursor's own `session_id` is captured from terminal `result`
 * events by the adapter.
 *
 * The adapter emits `output` / `status` / `context` events that we forward
 * onto the normalized provider events$ stream. `sendMessage()` does not
 * return an assistant message — completion is observed via the adapter's
 * `output` events.
 *
 * Note on identity: `provider` is `'cursor'` because ProviderName names the
 * CLI transport, not the model family. Cursor routes across multiple models
 * through one CLI; the caller selects the backing model via `options.model`
 * (or leaves it unset to let the CLI pick from the user's subscription).
 */

import { BaseProvider } from './provider-interface';
import { CursorCliAdapter, CursorCliConfig } from '../cli/adapters/cursor-cli-adapter';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import { MODEL_PRICING } from '../../shared/types/provider.types';
import type { OutputMessage, ContextUsage, FileAttachment } from '../../shared/types/instance.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import { generateId } from '../../shared/utils/id-generator';

const CURSOR_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  // CLI runs in yolo mode today; the orchestrator does not mediate tool-use
  // prompts for Cursor. Flip this when --permissions or equivalent lands.
  permissionPrompts: false,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_CURSOR_CONFIG: ProviderConfig = {
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: false,
  // Cursor's first-class model list rotates; leave defaultModel unset so the
  // CLI picks from the user's subscription unless the caller overrides.
};

export const CURSOR_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'cursor',
  displayName: 'Cursor',
  capabilities: CURSOR_CAPABILITIES,
  defaultConfig: DEFAULT_CURSOR_CONFIG,
};

export class CursorCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'cursor';
  readonly capabilities: ProviderAdapterCapabilities = CURSOR_CAPABILITIES;

  private adapter: CursorCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'cursor';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      // Cursor CLI does not currently surface multimodal input.
      vision: false,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: true,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      // Build a throwaway adapter just to probe the CLI. checkStatus() on
      // CursorCliAdapter runs `cursor-agent --version` in a 5-second timeout.
      const probe = new CursorCliAdapter();
      const cliStatus = await probe.checkStatus();
      return {
        type: 'cursor',
        available: cliStatus.available,
        authenticated: cliStatus.authenticated ?? cliStatus.available,
        error: cliStatus.available ? undefined : cliStatus.error || 'Cursor CLI not available',
      };
    } catch (error) {
      return {
        type: 'cursor',
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

    // Map session options to Cursor CLI config. If no model is supplied we
    // fall back to the provider config default; the adapter itself will let
    // the CLI pick from the user's subscription when neither is set.
    const cursorConfig: CursorCliConfig = {
      model: options.model || this.config.defaultModel,
      workingDir: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
      timeout: 300000,
    };

    this.adapter = new CursorCliAdapter(cursorConfig);

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
      // sendInput() is the Cursor adapter's analogue of sendMessage(). It does
      // not return a response object — completion arrives via the `output`
      // events set up in initialize(). Usage is updated via `context` events
      // handled in initialize(), which populate this.currentUsage.
      //
      // Map ProviderAttachment → FileAttachment: the adapter uses the
      // instance-level attachment shape (`name` / `type` / `size` / `data`
      // data-URL). We approximate `size` from the base64 payload length
      // (~3/4 of encoded chars) and encode the provider's `mimeType` into
      // `type` for the adapter to recover downstream.
      const mappedAttachments: FileAttachment[] | undefined = attachments?.map((a) => ({
        name: a.name,
        type: a.mimeType,
        size: Math.floor((a.data.length * 3) / 4),
        data: a.data,
      }));
      await this.adapter.sendInput(message, mappedAttachments);
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
      this.completeEvents();
    }
  }

  override getPid(): number | null {
    // The Cursor CLI adapter runs exec-per-message, so there is no stable
    // long-lived PID. Kept for interface symmetry — BaseCliAdapter.getPid()
    // returns the live child's PID while a turn is in flight and null
    // between turns.
    return this.adapter?.getPid() ?? null;
  }

  override getUsage(): ProviderUsage | null {
    return this.currentUsage;
  }

  /**
   * Update usage statistics from context usage.
   *
   * Mirrors ClaudeCliProvider/CopilotCliProvider.updateUsageFromContext:
   * context events give us the running total token count but no input/output
   * split, so we estimate 70/30 to derive per-side cost. Model pricing falls
   * back to Sonnet-class rates when the selected Cursor model is not in
   * MODEL_PRICING (e.g. the `auto` sentinel).
   */
  private updateUsageFromContext(context: ContextUsage): void {
    const modelId = this.config.defaultModel || '';
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
