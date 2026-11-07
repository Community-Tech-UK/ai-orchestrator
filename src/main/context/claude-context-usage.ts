import { z } from 'zod';
import type { ProviderMeasuredContext } from '../../shared/types/provider-measured-context.types';

const tokens = z.number().finite().nonnegative();
const named = z.object({ name: z.string(), tokens });
const schema = z.object({
  categories: z.array(named.extend({ isDeferred: z.boolean().optional() })), totalTokens: tokens, maxTokens: tokens.positive(),
  autoCompactThreshold: tokens.optional(), isAutoCompactEnabled: z.boolean().optional(),
  memoryFiles: z.array(z.object({ path: z.string().optional(), name: z.string().optional(), tokens })).optional().default([]),
  mcpTools: z.array(z.object({ name: z.string(), serverName: z.string().optional(), server: z.string().optional(),
    tokens, isDeferred: z.boolean().optional(), deferred: z.boolean().optional() })).optional().default([]),
  messageBreakdown: z.object({ toolResultTokens: tokens.optional(), toolCallsByType: z.array(z.object({
    name: z.string().optional(), toolName: z.string().optional(), resultTokens: tokens.optional(), toolResultTokens: tokens.optional(),
  })).optional().default([]) }).optional(),
});
export function mapClaudeContextUsage(raw: unknown): ProviderMeasuredContext | undefined {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const servers = new Map<string, { server: string; loadedTokens: number; deferredTokens: number }>();
  for (const tool of data.mcpTools) {
    const server = tool.serverName ?? tool.server ?? tool.name.match(/^mcp__(.*?)__/)?.[1] ?? 'Other';
    const group = servers.get(server) ?? { server, loadedTokens: 0, deferredTokens: 0 };
    if (tool.isDeferred ?? tool.deferred) group.deferredTokens += tool.tokens; else group.loadedTokens += tool.tokens;
    servers.set(server, group);
  }
  return { categories: data.categories, totalTokens: data.totalTokens, maxTokens: data.maxTokens,
    autoCompactThreshold: data.autoCompactThreshold, isAutoCompactEnabled: data.isAutoCompactEnabled,
    memoryFiles: data.memoryFiles.map(file => ({ name: (file.path ?? file.name ?? 'Memory file').split(/[/\\]/).at(-1)!, tokens: file.tokens })),
    connectorTools: [...servers.values()], toolResultTokens: data.messageBreakdown?.toolResultTokens,
    topTools: (data.messageBreakdown?.toolCallsByType ?? []).map(tool => ({ name: tool.name ?? tool.toolName ?? 'Tool',
      tokens: tool.resultTokens ?? tool.toolResultTokens ?? 0 })).sort((a, b) => b.tokens - a.tokens).slice(0, 8) };
}
