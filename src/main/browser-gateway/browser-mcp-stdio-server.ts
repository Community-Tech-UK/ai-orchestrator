import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from '../mcp/mcp-server';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';
import { createBrowserMcpTools } from './browser-mcp-tools';

const logger = getLogger('BrowserMcpStdioServer');

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function writeResponse(id: JsonRpcRequest['id'], payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

async function main(): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const client = new BrowserGatewayRpcClient();
  const server = McpServer.getInstance();
  server.registerTools(createBrowserMcpTools(client));
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

void main().catch((error) => {
  logger.error(
    'Browser MCP stdio server failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
