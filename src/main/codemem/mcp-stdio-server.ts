import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { AgentLspFacade } from './agent-lsp-facade';
import { migrate } from './cas-schema';
import { CasStore } from './cas-store';
import { createCodememMcpTools } from './mcp-tools';
import { McpServer } from '../mcp/mcp-server';
import { LspWorkerGateway } from '../lsp-worker/gateway-rpc';
import { getLogManager, getLogger } from '../logging/logger';

const logger = getLogger('CodememMcpStdioServer');

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

  const dbPath = process.env['AI_ORCHESTRATOR_CODEMEM_DB_PATH'];
  if (!dbPath) {
    throw new Error('AI_ORCHESTRATOR_CODEMEM_DB_PATH is required');
  }

  const db = defaultDriverFactory(dbPath);
  migrate(db);

  const store = new CasStore(db);
  const gateway = new LspWorkerGateway();
  const facade = new AgentLspFacade({ store, gateway });
  const server = McpServer.getInstance();
  server.registerTools(createCodememMcpTools(() => facade));
  server.start();

  const shutdown = async (): Promise<void> => {
    await gateway.stop();
    server.stop();
    db.close();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
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
        await shutdown();
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

  await shutdown();
}

void main().catch((error) => {
  logger.error('Codemem MCP stdio server failed', error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
