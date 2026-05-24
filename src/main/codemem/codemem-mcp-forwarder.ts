/**
 * Codemem MCP Forwarder (stdio side, runs inside the `aio-mcp` SEA).
 *
 * Replaces the old `mcp-stdio-server.ts` that opened `codemem.sqlite`
 * directly. Registers the same 8 MCP tools but the handlers forward the
 * args to `CodememRpcServer` in the parent process via
 * `CodememRpcClient`. The forwarder has no `better-sqlite3` import path,
 * so it loads cleanly in a vanilla Node SEA — no native-module ABI
 * dependency, which is what unblocks re-disabling the `RunAsNode`
 * Electron fuse.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from '../mcp/mcp-server';
import type { McpServerToolDefinition } from '../mcp/mcp-server-tools';
import { CodememRpcClient, type CodememRpcClientLike } from './codemem-rpc-client';

const logger = getLogger('CodememMcpForwarder');

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function writeResponse(id: JsonRpcRequest['id'], payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required };
}

function ensureObject(args: unknown, toolName: string): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName} args must be an object`);
  }
  return args as Record<string, unknown>;
}

/**
 * Build the MCP tool definitions that proxy back to the parent process.
 * Exported (and built as a pure factory) so tests can exercise the
 * forward-and-proxy contract with a stub RPC client.
 */
export function createCodememForwarderTools(
  client: CodememRpcClientLike,
): McpServerToolDefinition[] {
  return [
    {
      name: 'find_symbol',
      description: 'Search the persistent codemem index for symbols by name and optional kind.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          limit: { type: 'number' },
        },
        ['name'],
      ),
      handler: async (args) =>
        client.call('codemem.find_symbol', ensureObject(args, 'find_symbol')),
    },
    {
      name: 'find_references',
      description: 'Resolve references for a codemem symbol identifier using the LSP worker.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
          limit: { type: 'number' },
        },
        ['symbolId'],
      ),
      handler: async (args) =>
        client.call('codemem.find_references', ensureObject(args, 'find_references')),
    },
    {
      name: 'document_symbols',
      description: 'Return document symbols for a single file through the codemem LSP worker.',
      inputSchema: schema(
        {
          path: { type: 'string' },
        },
        ['path'],
      ),
      handler: async (args) =>
        client.call('codemem.document_symbols', ensureObject(args, 'document_symbols')),
    },
    {
      name: 'workspace_symbols',
      description: 'Search workspace-wide symbols through the codemem index.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        ['query'],
      ),
      handler: async (args) =>
        client.call('codemem.workspace_symbols', ensureObject(args, 'workspace_symbols')),
    },
    {
      name: 'call_hierarchy',
      description: 'Traverse incoming or outgoing call hierarchy for a codemem symbol.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
          direction: { type: 'string', enum: ['incoming', 'outgoing'] },
          maxDepth: { type: 'number' },
        },
        ['symbolId', 'direction'],
      ),
      handler: async (args) =>
        client.call('codemem.call_hierarchy', ensureObject(args, 'call_hierarchy')),
    },
    {
      name: 'find_implementations',
      description: 'Find implementations for a codemem symbol through the LSP worker.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
        },
        ['symbolId'],
      ),
      handler: async (args) =>
        client.call('codemem.find_implementations', ensureObject(args, 'find_implementations')),
    },
    {
      name: 'hover',
      description: 'Return hover information for a codemem symbol.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
        },
        ['symbolId'],
      ),
      handler: async (args) => client.call('codemem.hover', ensureObject(args, 'hover')),
    },
    {
      name: 'diagnostics',
      description: 'Return paginated diagnostics for a file through the codemem LSP worker.',
      inputSchema: schema(
        {
          path: { type: 'string' },
          page: { type: 'number' },
          pageSize: { type: 'number' },
        },
        ['path'],
      ),
      handler: async (args) => client.call('codemem.diagnostics', ensureObject(args, 'diagnostics')),
    },
  ];
}

export async function runCodememForwarder(
  client: CodememRpcClientLike = new CodememRpcClient(),
): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  server.registerTools(createCodememForwarderTools(client));
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
