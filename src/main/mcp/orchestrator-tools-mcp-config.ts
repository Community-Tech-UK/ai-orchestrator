import { existsSync } from 'node:fs';

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
  exists?: (candidatePath: string) => boolean;
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

  return {
    command: options.aioMcpCliPath,
    args: ['orchestrator-tools'],
    env: {
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: options.socketPath,
      AI_ORCHESTRATOR_INSTANCE_ID: options.instanceId,
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
