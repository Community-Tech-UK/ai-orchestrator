/**
 * Grok Build CLI Provider - Uses the xAI Grok Build CLI (`grok` binary) for AI
 * interactions via ACP (`grok agent stdio`).
 *
 * Note on identity: `provider` is `'grok'` because ProviderName names the CLI
 * transport. The backing model (currently `grok-4.5`) is selected via
 * `options.model` / `defaultModel`.
 */

import { BaseProvider } from './provider-interface';
import { AcpCliAdapter } from '../cli/adapters/acp-cli-adapter';
import { createGrokAdapter } from '../cli/adapters/adapter-factory';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import { GROK_MODELS, MODEL_PRICING } from '../../shared/types/provider.types';
import type { ContextUsage, FileAttachment } from '../../shared/types/instance.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import { generateId } from '../../shared/utils/id-generator';
import { probeVersionStatus } from '../cli/adapters/cli-status-probe';
import { spawn } from 'child_process';

const GROK_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_GROK_CONFIG: ProviderConfig = {
  type: 'grok',
  name: 'Grok Build',
  enabled: false,
  defaultModel: GROK_MODELS.GROK_45,
};

export const GROK_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'grok',
  displayName: 'Grok',
  capabilities: GROK_CAPABILITIES,
  defaultConfig: DEFAULT_GROK_CONFIG,
};

export class GrokCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'grok';
  readonly capabilities: ProviderAdapterCapabilities = GROK_CAPABILITIES;

  private adapter: AcpCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'grok';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: true,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      const cliStatus = await probeVersionStatus({
        spawn: () => spawn('grok', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }),
        path: 'grok',
        timeoutError: 'Timeout checking Grok CLI',
        spawnError: (err) => `Failed to launch grok: ${err.message}`,
        unavailableError: ({ code, output }) =>
          `Grok CLI not found or failed (exit ${code}): ${output.trim() || 'no output'}`,
        isAvailable: ({ code, version }) => code === 0 || Boolean(version),
        killSignal: 'SIGTERM',
        outputFormat: 'separate',
      });
      return {
        type: 'grok',
        available: cliStatus.available,
        authenticated: cliStatus.authenticated ?? cliStatus.available,
        error: cliStatus.available ? undefined : cliStatus.error || 'Grok CLI not available',
      };
    } catch (error) {
      return {
        type: 'grok',
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

    this.adapter = createGrokAdapter({
      model: options.model || this.config.defaultModel,
      workingDirectory: options.workingDirectory,
      systemPrompt: options.systemPrompt,
      yoloMode: options.yoloMode,
      instanceId: options.instanceId,
      timeout: 300_000,
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

    await this.adapter.spawn();
    this.sessionId = this.adapter.getSessionId() || generateId();
    this.isActive = true;
  }

  async sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void> {
    if (!this.adapter) {
      throw new Error('Provider not initialized');
    }

    try {
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
    return this.adapter?.getPid() ?? null;
  }

  override getUsage(): ProviderUsage | null {
    return this.currentUsage;
  }

  private updateUsageFromContext(context: ContextUsage): void {
    const modelId = this.config.defaultModel || GROK_MODELS.GROK_45;
    const pricing = (MODEL_PRICING as Record<string, { input: number; output: number }>)[modelId]
      || { input: 2.0, output: 10.0 };

    const tokenBasis = context.cumulativeTokens ?? context.used;
    const estimatedInputTokens = Math.floor(tokenBasis * 0.7);
    const normalizedOutputTokens = tokenBasis - estimatedInputTokens;

    const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
    const outputCost = (normalizedOutputTokens / 1_000_000) * pricing.output;

    this.currentUsage = {
      inputTokens: estimatedInputTokens,
      outputTokens: normalizedOutputTokens,
      totalTokens: tokenBasis,
      estimatedCost: inputCost + outputCost,
    };
  }
}
