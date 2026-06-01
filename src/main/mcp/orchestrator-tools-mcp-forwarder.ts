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

const REMOTE_NODE_DISCOVERY_HINT =
  'AIO can use connected remote worker nodes, including Windows PCs, other machines, remote machines, and another computer, through list_remote_nodes, run_on_node, and read_node_output. Call list_remote_nodes first when reachability matters.';

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
    {
      name: 'list_remote_nodes',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Lists currently registered remote worker nodes with status, platform, supported CLIs, browser/GPU/Docker capabilities, active capacity, working directories, heartbeat, and latency. Read-only; does not spawn work.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('list_remote_nodes args must be an object');
        }
        return client.call('orchestrator_tools.list_remote_nodes', args as Record<string, unknown>);
      },
    },
    {
      name: 'run_on_node',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Run a task on a connected remote worker node, such as a Windows PC, other machine, remote machine, or another computer, by spawning an AI agent there with the given prompt. The agent runs project-lessly using the node's default working directory unless one is provided. Returns immediately with the spawned instance id; output streams asynchronously and can be inspected from the app or read with read_node_output.`,
      inputSchema: {
        type: 'object',
        properties: {
          node: {
            type: 'string',
            description:
              'Target worker node by name (e.g. "windows-pc") or node id (UUID). Optional: when omitted and exactly one node is connected, that node is used.',
          },
          prompt: {
            type: 'string',
            description: 'Natural-language task / instruction for the agent on the node.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Working directory on the node. Optional — defaults to the node's first advertised working directory (project-less spawn).",
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'copilot', 'cursor'],
            description: 'CLI provider to use on the node (defaults to the node/app default).',
          },
          model: {
            type: 'string',
            description: 'Optional model override.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('run_on_node args must be an object');
        }
        return client.call('orchestrator_tools.run_on_node', args as Record<string, unknown>);
      },
    },
    {
      name: 'read_node_output',
      description:
        'Read the output produced by an instance previously started with run_on_node. Returns the most recent messages (assistant text, tool calls/results, errors), the instance status, and a `done` flag indicating whether the turn has completed. Optionally waits a bounded time for the turn to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: {
            type: 'string',
            description: 'Instance id returned by run_on_node.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Max number of most-recent messages to return (default 100).',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 120000,
            description:
              'Optionally block up to this many milliseconds, polling until the turn completes. 0/omitted returns immediately.',
          },
        },
        required: ['instanceId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('read_node_output args must be an object');
        }
        return client.call('orchestrator_tools.read_node_output', args as Record<string, unknown>);
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
