import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from '../mcp/mcp-server';
import {
  BrowserGatewayRpcClient,
  type BrowserGatewayRpcClientLike,
} from './browser-gateway-rpc-client';
import {
  BROWSER_TOOL_DEFERRAL_ENV,
  createDeferredBrowserMcpTools,
} from './browser-mcp-deferral';
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

export async function runBrowserMcpForwarder(
  client: BrowserGatewayRpcClientLike = new BrowserGatewayRpcClient(),
): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  const toolDeferral = process.env[BROWSER_TOOL_DEFERRAL_ENV] === '1';
  if (toolDeferral) {
    // WS9 deferral: list only the core set + search/describe; all tools stay
    // dispatchable. Reveals push a list_changed so the client re-lists.
    server.on('tools-list-changed', () => {
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`,
      );
    });
    server.registerTools(
      createDeferredBrowserMcpTools(client, {
        onReveal: (names) => server.revealTools(names),
      }),
    );
  } else {
    server.registerTools(createBrowserMcpTools(client));
  }
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

// No auto-run here. The aio-mcp SEA dispatcher is the only entrypoint —
// it imports `runBrowserMcpForwarder` and calls it under the `browser-gateway`
// subcommand. Re-adding a `require.main === module` guard would also fire
// from inside the dispatcher's esbuild bundle (esbuild rewrites all bundled
// modules to share the same outer `require.main`/`module`), causing the
// browser-gateway forwarder to start unconditionally whenever any other
// aio-mcp subcommand runs.
