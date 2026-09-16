import { existsSync } from 'node:fs';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV } from './orchestrator-mcp-deferral';
import { ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';
import { INTER_SESSION_MESSAGING_ENABLED_ENV } from './orchestrator-session-messaging-tools';

/**
 * MCP config writer for the orchestrator-tools stdio forwarder.
 *
 * The forwarder is dispatched via the shared `aio-mcp` Node SEA binary:
 *
 *   command: <resources>/aio-mcp-cli/aio-mcp
 *   args:    ['orchestrator-tools']
 *   env:     {
 *     AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: <parent RPC socket path>,
 *     AI_ORCHESTRATOR_INSTANCE_ID:               <auth handle for the parent>,
 *     AI_ORCHESTRATOR_INTER_SESSION_MESSAGING_ENABLED: '1' // optional
 *   }
 *
 * The forwarder talks to `OrchestratorToolsRpcServer` running in the parent
 * over the Unix socket — so the spawned binary contains no `better-sqlite3`
 * dependency and works under the `RunAsNode=false` Electron hardening fuse.
 */
export interface OrchestratorToolsMcpConfigOptions {
  aioMcpCliPath: string;
  socketPath: string;
  instanceId: string;
  provider?: string;
  /**
   * Request a compact surface: Codex uses fixed search/describe/execute wrappers;
   * dynamic clients reveal tools on demand. Cursor stays eager until proven.
   */
  toolDeferral?: boolean;
  /** Advertise the cross-session messaging MCP tools for this spawned CLI. */
  sessionMessagingEnabled?: boolean;
  exists?: (candidatePath: string) => boolean;
}

export type OrchestratorToolMode = 'eager' | 'deferred' | 'stable';

/** Same provider policy as browser-gateway: Codex=stable, Cursor=eager. */
export function supportsDeferredOrchestratorTools(provider?: string): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized !== 'codex' && normalized !== 'cursor';
}

export function resolveOrchestratorToolMode(
  provider?: string,
  toolDeferral = false,
): OrchestratorToolMode {
  if (!toolDeferral) return 'eager';
  if (provider?.trim().toLowerCase() === 'codex') return 'stable';
  return supportsDeferredOrchestratorTools(provider) ? 'deferred' : 'eager';
}

interface OrchestratorToolsBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveOrchestratorToolsBridgeSpec(
  options: OrchestratorToolsMcpConfigOptions,
): OrchestratorToolsBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  if (!exists(options.aioMcpCliPath)) {
    return null;
  }

  const toolMode = resolveOrchestratorToolMode(options.provider, options.toolDeferral);
  return {
    command: options.aioMcpCliPath,
    args: ['orchestrator-tools'],
    env: {
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: options.socketPath,
      AI_ORCHESTRATOR_INSTANCE_ID: options.instanceId,
      ...(options.sessionMessagingEnabled
        ? { [INTER_SESSION_MESSAGING_ENABLED_ENV]: '1' }
        : {}),
      ...(toolMode === 'stable'
        ? { [ORCHESTRATOR_TOOL_STABLE_ENV]: '1' }
        : toolMode === 'deferred' ? { [ORCHESTRATOR_TOOL_DEFERRAL_ENV]: '1' } : {}),
    },
  };
}

export function buildOrchestratorToolsMcpConfig(
  options: OrchestratorToolsMcpConfigOptions,
): string | null {
  const bridge = resolveOrchestratorToolsBridgeSpec(options);
  if (!bridge) {
    return null;
  }

  return JSON.stringify({
    mcpServers: {
      orchestrator: bridge,
    },
  });
}
