import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from '../mcp/mcp-server';
import {
  DesktopGatewayRpcClient,
  type DesktopGatewayRpcClientLike,
} from './desktop-gateway-rpc-client';
import { createDesktopMcpTools } from './desktop-mcp-tools';

const logger = getLogger('DesktopMcpStdioServer');

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function writeResponse(id: JsonRpcRequest['id'], payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

/**
 * Health-gated tool set. The parent process sets
 * `AI_ORCHESTRATOR_DESKTOP_TOOLS` to a comma-separated allowlist when the
 * driver is degraded (missing TCC), so the agent only sees health / list /
 * escalation tools rather than action tools that would just fail.
 */
function resolveAllowedToolNames(): string[] | undefined {
  const raw = process.env['AI_ORCHESTRATOR_DESKTOP_TOOLS'];
  if (!raw || !raw.trim()) {
    return undefined;
  }
  return raw.split(',').map((name) => name.trim()).filter(Boolean);
}

export async function runDesktopMcpForwarder(
  client: DesktopGatewayRpcClientLike = new DesktopGatewayRpcClient(),
): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  server.registerTools(createDesktopMcpTools(client, resolveAllowedToolNames()));
  server.start();

  const shutdown = (): void => {
    server.stop();
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      logger.warn('Received invalid JSON-RPC request', {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (request.method === 'notifications/initialized') {
      continue;
    }
    try {
      const result = await server.handleRequest({
        method: request.method,
        params: request.params,
        id: typeof request.id === 'number' ? request.id : undefined,
      });
      if (request.id !== undefined) {
        writeResponse(request.id, { result });
      }
      if (request.method === 'shutdown') {
        shutdown();
        process.exit(0);
      }
    } catch (error) {
      if (request.id !== undefined) {
        writeResponse(request.id, {
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  shutdown();
}
