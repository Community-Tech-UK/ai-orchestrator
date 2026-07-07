/**
 * SpawnConfigBuilder — builds MCP config paths and permission/RTK hook paths
 * to pass to spawned CLI instances.
 *
 * Extracted from `instance-lifecycle.ts` so that single-purpose spawn-time
 * configuration is testable in isolation and the lifecycle manager stays
 * focused on lifecycle state.
 *
 * Pure code paths only — every method is a function of (executionLocation,
 * instanceId, provider, yolo) plus singletons (settings, RPC sockets, etc.).
 * No instance state is read; no instance state is mutated.
 */

import { app } from 'electron';
import { existsSync } from 'fs';
import * as path from 'path';

import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import {
  ORCHESTRATOR_INJECTION_PROVIDERS,
  isOrchestratorRuntimeInjectionProvider,
  isSupportedProvider,
} from '../../../shared/types/mcp-scopes.types';
import {
  buildBrowserGatewayMcpConfigJson,
  getBrowserGatewayRpcSocketPath,
  type BrowserGatewayMcpConfigOptions,
  buildChromeDevtoolsMcpConfigJson,
  resolveChromeDevtoolsBrowserUrl,
  type ChromeDevtoolsMcpConfigOptions,
} from '../../browser-gateway';
import { ensureHookScript, ensureRtkDeferHookScript } from '../../cli/hooks/hook-path-resolver';
import { getRtkRuntime } from '../../cli/rtk/rtk-runtime';
import {
  buildCodememMcpConfig,
  type CodememMcpConfigOptions,
} from '../../codemem/mcp-config';
import { getCodememRpcSocketPath } from '../../codemem/codemem-rpc-server';
import type { SettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import { getOrchestratorInjectionReader } from '../../mcp/mcp-multi-provider-singletons';
import {
  buildOrchestratorToolsMcpConfig,
  type OrchestratorToolsMcpConfigOptions,
} from '../../mcp/orchestrator-tools-mcp-config';
import { getOrchestratorToolsRpcSocketPath } from '../../mcp/orchestrator-tools-rpc-server';
import { resolveAioMcpCliPath } from '../../util/aio-mcp-cli-path';

const logger = getLogger('SpawnConfigBuilder');

// MCP config file for spawned CLI instances (LSP server, etc.)
// In packaged app: extraResources places config/ in Contents/Resources/config/
// In dev mode: config/ is at project root, 4 levels up from
//   dist/main/instance/lifecycle/.
export const MCP_CONFIG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'config', 'mcp-servers.json')
  : path.resolve(__dirname, '../../../../config/mcp-servers.json');

export interface SpawnConfigBuilderDeps {
  settings: SettingsManager;
}

/**
 * Builds the per-spawn configuration that needs to be threaded into every
 * CLI adapter spawn (createInstance, wake, restart, mode/model/yolo switch,
 * deferred-permission resume, etc.).
 *
 * `InstanceLifecycleManager` owns one of these and delegates to it. The
 * builder owns no instance state of its own; it only memoizes the
 * process-wide RTK eligibility flag, which is determined by settings that
 * require a restart to change.
 */
export class SpawnConfigBuilder {
  private rtkHookEligibility: boolean | null = null;
  private readonly settings: SettingsManager;

  constructor(deps: SpawnConfigBuilderDeps) {
    this.settings = deps.settings;
  }

  /**
   * Returns MCP config paths to pass to spawned CLI instances.
   * Returns empty for remote instances — local filesystem paths don't exist
   * on the worker.
   */
  getMcpConfig(
    executionLocation?: ExecutionLocation,
    instanceId?: string,
    provider?: string,
  ): string[] {
    // MCP config paths are local filesystem paths. Remote workers have their
    // own MCP config on their filesystem; passing ours would cause invalid
    // --mcp-config arguments that may crash the CLI on the worker.
    if (executionLocation?.type === 'remote') {
      return [];
    }
    const configs: string[] = [];
    try {
      if (existsSync(MCP_CONFIG_PATH)) {
        logger.info('MCP config found', { path: MCP_CONFIG_PATH });
        configs.push(MCP_CONFIG_PATH);
      }
    } catch (err) {
      logger.error('Failed to check MCP config', err instanceof Error ? err : new Error(String(err)), {
        path: MCP_CONFIG_PATH,
      });
    }

    if (this.settings.getAll().codememEnabled) {
      const codememOptions = this.getCodememMcpOptions(instanceId);
      if (codememOptions) {
        const codememConfig = buildCodememMcpConfig(codememOptions);
        if (codememConfig) {
          configs.push(codememConfig);
        } else {
          logger.warn('Codemem MCP bridge entrypoint not found — child sessions will not expose mcp__codemem__* tools', {
            aioMcpCliPath: codememOptions.aioMcpCliPath,
            isPackaged: app.isPackaged,
          });
        }
      } else {
        logger.warn(
          'Codemem MCP not configured — aio-mcp SEA binary or codemem RPC socket missing',
          { instanceId, isPackaged: app.isPackaged },
        );
      }
    }

    const browserGatewayOptions = this.getBrowserGatewayMcpOptions(
      executionLocation,
      instanceId,
      provider,
    );
    if (browserGatewayOptions) {
      const browserGatewayConfig = buildBrowserGatewayMcpConfigJson(browserGatewayOptions);
      if (browserGatewayConfig) {
        configs.push(browserGatewayConfig);
      } else {
        logger.warn('Browser Gateway MCP bridge entrypoint not found — child sessions will not expose browser.* tools', {
          currentDir: __dirname,
          isPackaged: app.isPackaged,
        });
      }
    }

    // chrome-devtools attach (Claude consumes inline JSON via --mcp-config;
    // other providers receive it through UnifiedSpawnOptions.chromeDevtoolsMcp).
    const chromeDevtoolsOptions = this.getChromeDevtoolsMcpOptions(executionLocation);
    if (chromeDevtoolsOptions) {
      const chromeDevtoolsConfig = buildChromeDevtoolsMcpConfigJson(chromeDevtoolsOptions);
      if (chromeDevtoolsConfig) {
        configs.push(chromeDevtoolsConfig);
      }
    }

    configs.push(...this.getOrchestratorMcpConfigs(provider, instanceId));

    if (configs.length === 0) {
      logger.warn('No MCP configs resolved — spawned instances will not have custom MCP servers', {
        expectedPath: MCP_CONFIG_PATH,
        isPackaged: app.isPackaged,
      });
    }

    return configs;
  }

  private getOrchestratorMcpConfigs(provider?: string, instanceId?: string): string[] {
    if (!isOrchestratorRuntimeInjectionProvider(provider)) {
      return [];
    }

    try {
      const bundle = isSupportedProvider(provider) &&
        ORCHESTRATOR_INJECTION_PROVIDERS.includes(provider)
        ? getOrchestratorInjectionReader().buildBundle(provider)
        : { configPaths: [], inlineConfigs: [] };
      const orchestratorToolsOptions = this.getOrchestratorToolsMcpOptions(instanceId);
      const builtInToolsConfig = orchestratorToolsOptions
        ? buildOrchestratorToolsMcpConfig(orchestratorToolsOptions)
        : null;
      if (!builtInToolsConfig) {
        logger.warn(
          'Orchestrator-tools MCP not configured — aio-mcp SEA binary or orchestrator-tools RPC socket missing',
          { provider, instanceId, isPackaged: app.isPackaged },
        );
      }
      return [
        ...bundle.configPaths,
        ...bundle.inlineConfigs,
        ...(builtInToolsConfig ? [builtInToolsConfig] : []),
      ];
    } catch (error) {
      logger.warn('Failed to resolve Orchestrator MCP injection bundle', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build args for the codemem MCP config builder, or null if a prerequisite
   * (the SEA binary or the parent's RPC socket) is missing.
   */
  private getCodememMcpOptions(instanceId?: string): CodememMcpConfigOptions | null {
    if (!instanceId) return null;
    const aioMcpCliPath = resolveAioMcpCliPath();
    if (!aioMcpCliPath) return null;
    const socketPath = getCodememRpcSocketPath();
    if (!socketPath) return null;
    return { aioMcpCliPath, socketPath, instanceId };
  }

  /**
   * Build args for the orchestrator-tools MCP config builder, or null if a
   * prerequisite is missing.
   */
  private getOrchestratorToolsMcpOptions(
    instanceId?: string,
  ): OrchestratorToolsMcpConfigOptions | null {
    if (!instanceId) return null;
    const aioMcpCliPath = resolveAioMcpCliPath();
    if (!aioMcpCliPath) return null;
    const socketPath = getOrchestratorToolsRpcSocketPath();
    if (!socketPath) return null;
    return { aioMcpCliPath, socketPath, instanceId };
  }

  getBrowserGatewayMcpOptions(
    executionLocation?: ExecutionLocation,
    instanceId?: string,
    provider?: string,
  ): BrowserGatewayMcpConfigOptions | null {
    if (executionLocation?.type === 'remote' || !instanceId) {
      return null;
    }
    const socketPath = getBrowserGatewayRpcSocketPath();
    if (!socketPath) {
      return null;
    }
    const aioMcpCliPath = resolveAioMcpCliPath();
    if (!aioMcpCliPath) {
      return null;
    }
    return {
      aioMcpCliPath,
      socketPath,
      instanceId,
      ...(provider ? { provider } : {}),
    };
  }

  /**
   * Resolve chrome-devtools attach options from settings, or null when attach is
   * disabled, no profile is designated, or the instance runs on a remote node
   * (the managed Chrome and its CDP port are local to this machine).
   */
  getChromeDevtoolsMcpOptions(
    executionLocation?: ExecutionLocation,
  ): ChromeDevtoolsMcpConfigOptions | null {
    if (executionLocation?.type === 'remote') {
      return null;
    }
    const settings = this.settings.getAll();
    if (!settings.chromeDevtoolsAttachEnabled) {
      return null;
    }
    const profileId = settings.chromeDevtoolsAttachProfileId?.trim();
    if (!profileId) {
      return null;
    }
    return { browserUrl: resolveChromeDevtoolsBrowserUrl(profileId) };
  }

  /**
   * Returns the defer permission hook path for non-YOLO instances, undefined
   * for YOLO. The hook intercepts dangerous tools (Bash, etc.) and returns
   * `defer` so the orchestrator can surface approval UI instead of silently
   * denying.
   */
  getPermissionHookPath(yoloMode: boolean): string | undefined {
    if (yoloMode) return undefined;
    // When the RTK feature flag is on AND a usable rtk binary is available,
    // use the combined RTK + defer hook script. Otherwise, fall back to the
    // standard defer-only hook. Both scripts honor the same decision-file
    // resume protocol, so callers don't need to care which is in use.
    if (this.shouldUseRtkHook()) {
      try {
        return ensureRtkDeferHookScript();
      } catch (err) {
        logger.warn('Failed to resolve RTK defer hook path, falling back to defer-only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      return ensureHookScript();
    } catch (err) {
      logger.warn('Failed to resolve defer permission hook path, skipping', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Whether to use the RTK + defer combined hook for this orchestrator
   * process. Requires both the rtkEnabled setting AND a usable rtk binary
   * on disk. Result is computed lazily and cached for the process lifetime;
   * toggling the setting requires a restart to take effect.
   */
  private shouldUseRtkHook(): boolean {
    if (this.rtkHookEligibility !== null) return this.rtkHookEligibility;
    const enabled = this.settings.get('rtkEnabled');
    if (!enabled) {
      this.rtkHookEligibility = false;
      return false;
    }
    const bundledOnly = Boolean(this.settings.get('rtkBundledOnly'));
    const runtime = getRtkRuntime({ bundledOnly });
    this.rtkHookEligibility = runtime.isAvailable();
    return this.rtkHookEligibility;
  }

  /**
   * Resolved RTK config to pass to spawn options when the hook is in use.
   * Returns undefined when the RTK feature is disabled or unavailable.
   */
  getRtkSpawnConfig(): { enabled: boolean; binaryPath: string } | undefined {
    if (!this.shouldUseRtkHook()) return undefined;
    const bundledOnly = Boolean(this.settings.get('rtkBundledOnly'));
    const runtime = getRtkRuntime({ bundledOnly });
    if (!runtime.isAvailable()) return undefined;
    return { enabled: true, binaryPath: runtime.binaryPath() };
  }
}
