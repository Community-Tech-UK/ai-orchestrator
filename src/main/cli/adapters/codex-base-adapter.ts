import {
  BaseCliAdapter,
  type CliAdapterConfig,
  type CliCapabilities,
  type CliStatus,
  type ResumeAttemptResult,
} from './base-cli-adapter';
import { CodexHomeManager } from './codex/codex-home-manager';
import type { CodexCliConfig } from './codex-adapter-config';
import { PROVIDER_MODEL_LIST, type ModelDisplayInfo } from '../../../shared/types/provider.types';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getLogger } from '../../logging/logger';
import { checkAppServerAvailability } from './codex/app-server-client';
import { discoverCodexModels } from './codex/model-list';
import { probeVersionStatus } from './cli-status-probe';
import { ActivityStateDetector } from '../../providers/activity-state-detector';
import type { ResumeCursor } from '../../session/session-continuity';

const logger = getLogger('CodexBaseAdapter');

/** Shared process configuration and isolated CODEX_HOME lifecycle. */
export abstract class CodexBaseAdapter extends BaseCliAdapter {
  protected readonly cliConfig: CodexCliConfig;
  private readonly codexHome = new CodexHomeManager();
  /** Which config.toml treatment the current prepared CODEX_HOME has, if any. */
  protected preparedHomeKind: 'mcp-toml' | 'app-server' | 'exec' | null = null;
  protected cumulativeTokensUsed = 0;
  protected cumulativeCostUsd = 0;
  protected lastTurnTokens = 0;
  protected hasTokenUsageNotification = false;
  protected codexReportedContextWindow = 0;
  protected resumeCursor: ResumeCursor | null = null;
  protected lastResumeAttemptResult: ResumeAttemptResult | null = null;
  protected activityDetector: ActivityStateDetector | null = null;

  protected constructor(config: CodexCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'codex',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      sessionPersistence: !config.ephemeral,
      env: config.env,
    };
    super(adapterConfig);
    this.cliConfig = config;
    this.sessionId = config.sessionId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getName(): string {
    return 'codex-cli';
  }

  setActivityDetector(detector: ActivityStateDetector): void {
    this.activityDetector = detector;
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: true,
      codeExecution: true,
      contextWindow: this.resolveContextWindow(),
      outputFormats: ['text', 'json'],
    };
  }

  async checkStatus(): Promise<CliStatus> {
    return probeVersionStatus({
      spawn: () => this.spawnProcess(['--version']),
      path: 'codex',
      timeoutError: 'Timeout checking Codex CLI',
      spawnError: (err) => `Failed to spawn codex: ${err.message}`,
      unavailableError: ({ output }) => `Codex CLI not found or not configured: ${output}`,
      isAvailable: ({ code, output }) => code === 0 || output.includes('codex'),
      metadata: () => ({ appServerAvailable: checkAppServerAvailability() }),
    });
  }

  async listAvailableModels(
    options: { fallbackToStatic?: boolean } = {},
  ): Promise<ModelDisplayInfo[]> {
    try {
      return await discoverCodexModels({
        cwd: this.cliConfig.workingDir || process.cwd(),
        env: { ...getSafeEnvForTrustedProcess(), ...this.config.env },
      });
    } catch (error) {
      if (options.fallbackToStatic === false) throw error;
      logger.warn('Falling back to static Codex model list', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [...(PROVIDER_MODEL_LIST['codex'] ?? [])];
    }
  }

  protected abstract resolveContextWindow(): number;

  /** Codex thread resumption is independent of approval policy. */
  protected supportsNativeResume(): boolean {
    return true;
  }

  /** Prepare a session-isolated CODEX_HOME with mode-specific MCP treatment. */
  protected prepareCodexHome(kind: 'app-server' | 'exec'): void {
    const codexHomeDir = this.cliConfig.mcpServersConfigToml
      ? this.codexHome.prepareHomeWithMcpConfig(this.cliConfig.mcpServersConfigToml)
      : kind === 'app-server'
        ? this.codexHome.prepareSessionIsolatedHome()
        : this.codexHome.prepareMcpFreeHome();
    if (!codexHomeDir) {
      throw new Error(
        'Failed to prepare isolated CODEX_HOME; refusing to start Codex without state isolation',
      );
    }
    this.preparedHomeKind = this.cliConfig.mcpServersConfigToml ? 'mcp-toml' : kind;
    this.config.env = { ...this.config.env, CODEX_HOME: codexHomeDir };
  }

  protected cleanupCodexHome(): void {
    this.codexHome.cleanup();
    this.preparedHomeKind = null;
  }
}
