export interface EstimatedMcpTool { name: string; description?: string; inputSchema?: unknown }
/** An upper estimate; providers that defer schemas normally pay only for names. */
export function estimateServerCost(tools: readonly EstimatedMcpTool[]) {
  return {
    toolCount: tools.length,
    fullTokens: tools.reduce((sum, { name, description, inputSchema }) => sum + Math.ceil(JSON.stringify({ name, description, inputSchema }).length / 4), 0),
    nameTokens: Math.ceil(tools.reduce((sum, tool) => sum + tool.name.length + 1, 0) / 4),
  };
}
