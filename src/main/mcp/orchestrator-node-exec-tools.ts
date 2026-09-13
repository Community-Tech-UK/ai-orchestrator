import type { McpServerToolDefinition } from './mcp-server-tools';
import { EXEC_ON_NODE_DESCRIPTION } from './orchestrator-tool-copy';
import {
  NODE_EXEC_MAX_TIMEOUT_MS,
  NodeExecParamsSchema,
  type NodeExecResult,
} from '../remote-node/node-control-rpc-schemas';
import { z } from 'zod/v4';

export const ExecOnNodeArgsSchema = NodeExecParamsSchema.safeExtend({
  node: z.string().trim().min(1),
}).strict();

export type ExecOnNodeArgs = z.infer<typeof ExecOnNodeArgsSchema>;

export interface ExecOnNodeResult extends NodeExecResult {
  nodeId: string;
  nodeName: string;
}

export type ExecOnNodeFn = (args: ExecOnNodeArgs) => Promise<ExecOnNodeResult>;

export interface NodeExecToolContext {
  execOnNode?: ExecOnNodeFn | null;
}

export function createNodeExecToolDefinitions(
  context: NodeExecToolContext,
): McpServerToolDefinition[] {
  return [{
    name: 'exec_on_node',
    description: EXEC_ON_NODE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Target connected worker node name or id.' },
        executable: { type: 'string', description: 'Executable filename or path; never a shell command string.' },
        args: {
          type: 'array',
          items: { type: 'string', maxLength: 4096 },
          maxItems: 256,
          description: 'Exact argv entries passed without shell interpretation.',
        },
        cwd: { type: 'string', description: 'Optional worker cwd inside an advertised working directory.' },
        scriptSha256: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
          description: 'Required for PowerShell -File; use the SHA-256 returned by upload_to_node.',
        },
        timeoutMs: {
          type: 'integer', minimum: 1, maximum: NODE_EXEC_MAX_TIMEOUT_MS,
          description: 'Bounded timeout in milliseconds; defaults to 30000.',
        },
      },
      required: ['node', 'executable', 'args'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = ExecOnNodeArgsSchema.parse(args);
      if (!context.execOnNode) {
        throw new Error('exec_on_node is unavailable: worker execution is not wired in this process');
      }
      return context.execOnNode(parsed);
    },
  }];
}
