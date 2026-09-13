import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import { EXEC_ON_NODE_DESCRIPTION } from './orchestrator-tool-copy';

export function createNodeExecForwarderTool(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition {
  return {
    name: 'exec_on_node',
    description: EXEC_ON_NODE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Target connected worker node name or id.' },
        executable: { type: 'string', description: 'Executable filename or path.' },
        args: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 256 },
        cwd: { type: 'string', description: 'Optional worker cwd inside an advertised root.' },
        scriptSha256: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
          description: 'Required for PowerShell -File; use upload_to_node.sha256.',
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      },
      required: ['node', 'executable', 'args'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('exec_on_node args must be an object');
      }
      return client.call('orchestrator_tools.exec_on_node', args as Record<string, unknown>);
    },
  };
}
