import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import { z } from 'zod/v4';

const RESET_NODE_CONNECTION_DESCRIPTION =
  'Close a connected worker node\'s coordinator WebSocket WITHOUT revoking it; the worker reconnects on its own backoff. '
  + 'Use when a node is connected but its traffic is not flowing, e.g. browser_health shows relay_not_forwarding or the '
  + 'node has an active flap storm (repeated "Replacing existing socket"). Running instances on the node keep running. '
  + 'Target must be an exact node name or id from list_remote_nodes.';

export const ResetNodeConnectionArgsSchema = z.object({
  node: z.string().trim().min(1).max(200),
}).strict();

export type ResetNodeConnectionArgs = z.infer<typeof ResetNodeConnectionArgsSchema>;

export interface ResetNodeConnectionResult {
  nodeId: string;
  nodeName: string;
  /** False when the node had no open socket at the moment of the call. */
  reset: boolean;
}

export type ResetNodeConnectionFn = (args: ResetNodeConnectionArgs) => Promise<ResetNodeConnectionResult>;

export interface NodeConnectionToolContext {
  resetNodeConnection?: ResetNodeConnectionFn | null;
}

const inputSchema = {
  type: 'object',
  properties: {
    node: { type: 'string', description: 'Exact connected worker node name or id.' },
  },
  required: ['node'],
  additionalProperties: false,
};

export function createNodeConnectionToolDefinitions(
  context: NodeConnectionToolContext,
): McpServerToolDefinition[] {
  return [{
    name: 'reset_node_connection',
    description: RESET_NODE_CONNECTION_DESCRIPTION,
    inputSchema,
    handler: async (args) => {
      const parsed = ResetNodeConnectionArgsSchema.parse(args);
      if (!context.resetNodeConnection) {
        throw new Error('reset_node_connection is unavailable: node connection control is not wired in this process');
      }
      return context.resetNodeConnection(parsed);
    },
  }];
}

export function createNodeConnectionForwarderTool(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition {
  return {
    name: 'reset_node_connection',
    description: RESET_NODE_CONNECTION_DESCRIPTION,
    inputSchema,
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('reset_node_connection args must be an object');
      }
      return client.call('orchestrator_tools.reset_node_connection', args as Record<string, unknown>);
    },
  };
}
