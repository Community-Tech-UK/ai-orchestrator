/**
 * OpenCode CLI Provider - drives the `opencode` binary over ACP
 * (`opencode acp`). OpenCode fronts many backends (MiMo Token Plan, its free
 * Zen models, OpenRouter, ...), so model ids are `provider/model` pairs and
 * there is no AIO default model: an unset model means OpenCode's own default.
 */

import { execFile, spawn } from 'child_process';
import { BaseProvider } from './provider-interface';
import { AcpCliAdapter } from '../cli/adapters/acp-cli-adapter';
import { createOpenCodeAdapter } from '../cli/adapters/adapter-factory';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
} from '../../shared/types/provider.types';
import type { FileAttachment } from '../../shared/types/instance.types';
import type { ProviderName, ProviderCompleteEvent } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import { generateId } from '../../shared/utils/id-generator';
import { probeVersionStatus } from '../cli/adapters/cli-status-probe';
import { readOpenCodeAuthStatus } from './opencode-auth-status';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';

const AUTH_COMMAND_TIMEOUT_MS = 10_000;

const OPENCODE_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: false,
};

export const DEFAULT_OPENCODE_CONFIG: ProviderConfig = {
  type: 'opencode',
  name: 'OpenCode',
  enabled: false,
};

export const OPENCODE_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'opencode',
  displayName: 'OpenCode',
  capabilities: OPENCODE_CAPABILITIES,
  defaultConfig: DEFAULT_OPENCODE_CONFIG,
};

/** `auth list` and `debug config` open OpenCode's database, so they share the process gate. */
function runOpenCode(args: string[]): Promise<string> {
  return withOpenCodeProcessGate(() => new Promise<string>((resolve, reject) => {
    execFile('opencode', args, { timeout: AUTH_COMMAND_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  }));
}

export class OpenCodeCliProvider extends BaseProvider {
  readonly provider: ProviderName = 'opencode';
  readonly capabilities: ProviderAdapterCapabilities = OPENCODE_CAPABILITIES;

  private adapter: AcpCliAdapter | null = null;
  private currentUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig, private readonly runCommand: (args: string[]) => Promise<string> = runOpenCode) {
    super(config);
  }

  getType(): ProviderType {
    return 'opencode';
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
      const cliStatus = await probeVersionStatus({
        spawn: () => spawn('opencode', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }),
        path: 'opencode',
        timeoutError: 'Timeout checking OpenCode CLI',
        spawnError: (err) => `Failed to launch opencode: ${err.message}`,
        unavailableError: ({ code, output }) =>
          `OpenCode CLI not found or failed (exit ${code}): ${output.trim() || 'no output'}`,
        isAvailable: ({ code, version }) => code === 0 || Boolean(version),
        killSignal: 'SIGTERM',
        outputFormat: 'separate',
      });
      if (!cliStatus.available) {
        return {
          type: 'opencode',
          available: false,
          authenticated: false,
          error: cliStatus.error || 'OpenCode CLI not available',
        };
      }
      const auth = await readOpenCodeAuthStatus(this.runCommand, this.config.defaultModel)
        .catch(() => ({ authenticated: false, counts: null }));
      return {
        type: 'opencode',
        available: true,
        authenticated: auth.authenticated,
        ...(auth.authenticated ? {} : { error: 'OpenCode has no credential for the selected model. Run `opencode auth login`.' }),
      };
    } catch (error) {
      return {
        type: 'opencode',
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

    this.adapter = createOpenCodeAdapter({
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
          case 'complete':
            if (runtimeEvent.event.kind === 'complete') this.updateUsageFromTurn(runtimeEvent.event);
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

  /**
   * Accumulates the measured per-turn usage OpenCode reports. Cost is what
   * OpenCode reported for the turn (`usage_update`, see acp-usage-update.ts);
   * there is no static price table for `provider/model` ids, so a turn with no
   * reported cost adds $0 rather than borrowing another vendor's rate.
   */
  private updateUsageFromTurn(event: ProviderCompleteEvent): void {
    const previous = this.currentUsage;
    const inputTokens = (previous?.inputTokens ?? 0) + (event.inputTokens ?? 0);
    const outputTokens = (previous?.outputTokens ?? 0) + (event.outputTokens ?? 0);
    const cacheReadTokens = (previous?.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
    const reasoningTokens = (previous?.reasoningTokens ?? 0) + (event.reasoningTokens ?? 0);
    this.currentUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      reasoningTokens,
      totalTokens: (previous?.totalTokens ?? 0) + (event.tokensUsed ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)),
      estimatedCost: (previous?.estimatedCost ?? 0) + (event.costUsd ?? 0),
    };
  }
}
