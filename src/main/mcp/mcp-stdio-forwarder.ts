import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from './mcp-server';
import type { McpServerToolDefinition } from './mcp-server-tools';

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface StdioDispatchResult {
  response?: Record<string, unknown>;
  shouldShutdown: boolean;
}

export function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required };
}

export function ensureObject(args: unknown, toolName: string): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName} args must be an object`);
  }
  return args as Record<string, unknown>;
}

function writeResponse(id: JsonRpcRequest['id'], payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

export async function dispatchStdioMcpRequest(
  server: Pick<McpServer, 'handleRequest'>,
  request: JsonRpcRequest,
): Promise<StdioDispatchResult> {
  if (request.method === 'notifications/initialized') {
    return { shouldShutdown: false };
  }

  if (request.method === 'shutdown') {
    return {
      response: request.id !== undefined ? { result: {} } : undefined,
      shouldShutdown: true,
    };
  }

  try {
    const result = await server.handleRequest({
      method: request.method,
      params: request.params,
      id: typeof request.id === 'number' ? request.id : undefined,
    });
    return {
      response: request.id !== undefined ? { result } : undefined,
      shouldShutdown: false,
    };
  } catch (error) {
    return {
      response: request.id !== undefined
        ? {
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }
        : undefined,
      shouldShutdown: false,
    };
  }
}

export async function runStdioMcpForwarder(args: {
  loggerName: string;
  tools: McpServerToolDefinition[];
}): Promise<void> {
  const logger = getLogger(args.loggerName);
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  server.registerTools(args.tools);
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
    if (!line.trim()) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      logger.warn('Received invalid JSON-RPC request', {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const dispatch = await dispatchStdioMcpRequest(server, request);
    if (dispatch.response && request.id !== undefined) {
      writeResponse(request.id, dispatch.response);
    }
    if (dispatch.shouldShutdown) {
      shutdown();
      rl.close();
      return;
    }
  }

  shutdown();
}
