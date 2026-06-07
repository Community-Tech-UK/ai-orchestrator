/**
 * Shared types for the CLI adapter factory.
 *
 * Extracted from adapter-factory.ts to keep the factory module focused on
 * adapter construction. `UnifiedSpawnOptions` is re-exported from
 * adapter-factory.ts for backward compatibility with existing import sites.
 */

import type { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CodexCliAdapter } from './codex-cli-adapter';
import type { GeminiCliAdapter } from './gemini-cli-adapter';
import type { OllamaCliAdapter } from './ollama-cli-adapter';
import type { AcpCliAdapter } from './acp-cli-adapter';
import type { RemoteCliAdapter } from './remote-cli-adapter';
import type { CliAdapterWorkerProxy } from '../spawn-worker/cli-adapter-worker-proxy';
import type { InstanceLaunchMode } from '../../../shared/types/instance.types';
import type { BrowserGatewayMcpConfigOptions } from '../../browser-gateway/browser-mcp-config';
import type { ChromeDevtoolsMcpConfigOptions } from '../../browser-gateway/chrome-devtools-mcp-config';
import type { AcpMcpServerConfig } from '../../../shared/types/cli.types';

/**
 * Unified spawn options that work across all adapters
 */
export interface UnifiedSpawnOptions {
  /** Run without persisting provider session/thread state (provider-specific). */
  ephemeral?: boolean;
  sessionId?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  launchMode?: InstanceLaunchMode;
  timeout?: number;
  env?: Record<string, string>;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: boolean;  // Resume an existing session (requires sessionId)
  forkSession?: boolean; // Fork a resumed session into a new session ID (Claude CLI)
  mcpConfig?: string[];  // MCP server config file paths or inline JSON strings
  /** ACP-native MCP server configs supplied by the caller. */
  mcpServers?: AcpMcpServerConfig[];
  /** Browser Gateway bridge options used to build provider-specific MCP config. */
  browserGatewayMcp?: BrowserGatewayMcpConfigOptions;
  /**
   * chrome-devtools attach options. When set, each provider gets a
   * `chrome-devtools` MCP server configured with `--browserUrl` pointing at a
   * managed profile's CDP endpoint (see chrome-devtools-mcp-config).
   */
  chromeDevtoolsMcp?: ChromeDevtoolsMcpConfigOptions;
  /** Enable Chrome extension integration (Claude CLI only).
   *  Defaults to false; managed browser access is exposed through Browser Gateway MCP. */
  chrome?: boolean;
  /** JSON Schema object for structured output (Codex app-server mode). */
  outputSchema?: Record<string, unknown>;
  /** Reasoning effort level for the model. Claude also accepts session-only max/workflow. */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow';
  /** Minimal mode (Claude CLI only): skip hooks, LSP, plugins for faster startup.
   *  Requires explicit API key — OAuth/keychain auth is skipped. Defaults to false. */
  bare?: boolean;
  /** Display name for this session (Claude CLI only). Shown in /resume picker. */
  name?: string;
  /** Improve prompt-cache hit rates by moving per-machine system prompt sections
   *  into the first user message (Claude CLI only). Defaults to true for orchestrated spawns. */
  excludeDynamicSystemPromptSections?: boolean;
  /** Path to a PreToolUse hook script for defer-based permission approval (Claude CLI only).
   *  When set, the adapter injects hook configuration via --settings to intercept dangerous
   *  tools and return `defer`, pausing execution for user approval. */
  permissionHookPath?: string;
  /** Optional RTK rewrite integration (Claude CLI only in v1).
   *  When set with `enabled: true` and a resolved `binaryPath`, the spawned CLI gets
   *  ORCHESTRATOR_RTK_ENABLED=1 / ORCHESTRATOR_RTK_PATH in its env so the
   *  combined rtk-defer-hook.mjs can call `rtk rewrite` on Bash tool input.
   *  See bigchange_rtk_integration.md. */
  rtk?: {
    enabled: boolean;
    binaryPath?: string;
  };
  /** Instance ID, used by ACP-backed adapters (Copilot, Cursor) to tag
   *  permission requests routed through `PermissionRegistry`. When omitted,
   *  the factory generates a synthetic ephemeral ID so the registry's
   *  auto-timeout still fires on unresponded `session/request_permission`
   *  RPCs (otherwise the ACP turn would hang indefinitely). */
  instanceId?: string;
  /** Child ID for nested / subagent instances (ACP permission context). */
  childId?: string;
}

/**
 * Adapter type union - the concrete adapter types
 */
export type CliAdapter =
  | ClaudeCliAdapter
  | CodexCliAdapter
  | GeminiCliAdapter
  | OllamaCliAdapter
  | AcpCliAdapter
  | RemoteCliAdapter
  | CliAdapterWorkerProxy;
