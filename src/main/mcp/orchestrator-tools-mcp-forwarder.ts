/**
 * Orchestrator-Tools MCP Forwarder (stdio side, runs inside the `aio-mcp` SEA).
 *
 * Replaces the old `orchestrator-tools-mcp-server.ts` that opened the
 * operator database directly. The forwarder registers a parallel set of MCP
 * tools whose handlers serialize the args, hand them to
 * `OrchestratorToolsRpcClient.call()`, and return whatever the parent
 * process produces.
 *
 * No `better-sqlite3` import path means no native-module ABI dependency,
 * which is the whole reason the SEA dispatcher exists and the reason the
 * `RunAsNode` Electron fuse can go back to `false` for packaged builds.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from './mcp-server';
import type { McpServerToolDefinition } from './mcp-server-tools';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';

const logger = getLogger('OrchestratorToolsMcpForwarder');

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
 * Build the MCP tool definitions that proxy back to the parent process.
 * Kept as a factory taking an `OrchestratorToolsRpcClient` so tests can
 * drive it with a stub client without spinning up a real socket.
 */
export function createOrchestratorToolsForwarderTools(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition[] {
  return [
    {
      name: 'git_batch_pull',
      description:
        'Discover Git repositories below a root path and safely fetch plus fast-forward pull clean tracking branches. Dirty, detached, divergent, no-upstream, and no-remote repositories are skipped with reasons.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Root directory to scan for Git repositories.' },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ignore patterns passed to repository discovery.',
          },
          concurrency: {
            type: 'integer',
            minimum: 1,
            maximum: 16,
            description: 'Maximum repositories to process concurrently. Defaults to 6.',
          },
        },
        required: ['root'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('git_batch_pull args must be an object');
        }
        return client.call('orchestrator_tools.git_batch_pull', args as Record<string, unknown>);
      },
    },
  ];
}

export async function runOrchestratorToolsForwarder(
  client: OrchestratorToolsRpcClientLike = new OrchestratorToolsRpcClient(),
): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  server.registerTools(createOrchestratorToolsForwarderTools(client));
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
