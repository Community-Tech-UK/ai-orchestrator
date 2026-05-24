import { existsSync } from 'node:fs';

/**
 * MCP config writer for the codemem stdio forwarder.
 *
 * The forwarder is dispatched via the shared `aio-mcp` Node SEA binary:
 *
 *   command: <resources>/aio-mcp-cli/aio-mcp
 *   args:    ['codemem']
 *   env:     {
 *     AI_ORCHESTRATOR_CODEMEM_SOCKET: <parent RPC socket path>,
 *     AI_ORCHESTRATOR_INSTANCE_ID:    <auth handle for the parent>,
 *   }
 *
 * The forwarder talks to `CodememRpcServer` running in the parent over the
 * Unix socket — so the spawned binary contains no `better-sqlite3`
 * dependency and works under the `RunAsNode=false` Electron hardening fuse.
 */
export interface CodememMcpConfigOptions {
  aioMcpCliPath: string;
  socketPath: string;
  instanceId: string;
  exists?: (candidatePath: string) => boolean;
}

interface CodememBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveCodememBridgeSpec(options: CodememMcpConfigOptions): CodememBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  if (!exists(options.aioMcpCliPath)) {
    return null;
  }

  return {
    command: options.aioMcpCliPath,
    args: ['codemem'],
    env: {
      AI_ORCHESTRATOR_CODEMEM_SOCKET: options.socketPath,
      AI_ORCHESTRATOR_INSTANCE_ID: options.instanceId,
    },
  };
}

export function buildCodememMcpConfig(options: CodememMcpConfigOptions): string | null {
  const bridge = resolveCodememBridgeSpec(options);
  if (!bridge) {
    return null;
  }

  return JSON.stringify({
    mcpServers: {
      codemem: bridge,
    },
  });
}
