import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { getLogManager, getLogger } from '../logging/logger';
import { createOperatorTables } from '../operator/operator-schema';
import { McpServer } from './mcp-server';
import {
  createLedgerForOrchestratorTools,
  createOrchestratorToolDefinitions,
} from './orchestrator-tools';

const logger = getLogger('OrchestratorToolsMcpServer');

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

  const operatorDbPath = process.env['AI_ORCHESTRATOR_OPERATOR_DB_PATH'];
  if (!operatorDbPath) {
    throw new Error('AI_ORCHESTRATOR_OPERATOR_DB_PATH is required');
  }

  const ledgerDbPath = process.env['AI_ORCHESTRATOR_CONVERSATION_LEDGER_DB_PATH'];
  const db = defaultDriverFactory(operatorDbPath);
  db.pragma('journal_mode = WAL');
  createOperatorTables(db);
  const ledger = ledgerDbPath ? createLedgerForOrchestratorTools(ledgerDbPath) : null;
  const server = McpServer.getInstance();
  server.registerTools(createOrchestratorToolDefinitions({
    db,
    ledger,
    instanceId: process.env['AI_ORCHESTRATOR_INSTANCE_ID'] ?? null,
  }));
  server.start();

  const shutdown = (): void => {
    ledger?.close();
    server.stop();
    db.close();
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
    'Orchestrator tools MCP stdio server failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
