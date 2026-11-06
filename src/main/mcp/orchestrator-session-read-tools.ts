import { z } from 'zod/v4';
import type { SessionTranscriptReader } from '../session/session-transcript-reader';
import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import { READ_SESSION_DESCRIPTION } from './orchestrator-tool-copy';

export const ReadSessionArgsSchema = z.object({
  session: z.string().trim().min(1).max(200),
  view: z.enum(['messages', 'activity']).optional(),
  from: z.enum(['end', 'before-last-compaction']).optional(),
  before: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
const inputSchema = {
  type: 'object', properties: {
    session: { type: 'string', minLength: 1, maxLength: 200, description: 'self, an exact session id, or an exact title.' },
    view: { type: 'string', enum: ['messages', 'activity'] },
    from: { type: 'string', enum: ['end', 'before-last-compaction'] },
    before: { type: 'integer', minimum: 0, description: 'olderCursor from the previous page.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  }, required: ['session'], additionalProperties: false,
};
export const SESSION_READ_RPC_SPECS = [{ method: 'orchestrator_tools.read_session', toolName: 'read_session', schema: ReadSessionArgsSchema }];
export function createSessionReadToolDefinitions(context: {
  instanceId?: string | null; getReader: () => Pick<SessionTranscriptReader, 'read'>;
}): McpServerToolDefinition[] {
  if (!context.instanceId) return [];
  return [{ name: 'read_session', description: READ_SESSION_DESCRIPTION, inputSchema,
    handler: async (args) => {
      const parsed = ReadSessionArgsSchema.parse(args);
      let reader: Pick<SessionTranscriptReader, 'read'>;
      try { reader = context.getReader(); } catch {
        return { outcome: 'not-allowed', reason: 'The session reader is not ready yet.' };
      }
      return reader.read(context.instanceId!, parsed);
    },
  }];
}
export function createSessionReadForwarderTools(client: OrchestratorToolsRpcClientLike): McpServerToolDefinition[] {
  return [{ name: 'read_session', description: READ_SESSION_DESCRIPTION, inputSchema,
    handler: async (args) => client.call('orchestrator_tools.read_session', ReadSessionArgsSchema.parse(args)) }];
}
