import { getLogger } from '../logging/logger';

const logger = getLogger('McpToolBridge');

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredMcpTool {
  id: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type CallToolFn = (request: { serverId: string; toolName: string; args: Record<string, unknown> }) => Promise<unknown>;

export class McpToolBridge {
  private static instance: McpToolBridge | null = null;
  private registeredTools = new Map<string, RegisteredMcpTool>();
  private callToolFn: CallToolFn | null = null;

  static getInstance(): McpToolBridge {
    if (!this.instance) this.instance = new McpToolBridge();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  setCallToolFn(fn: CallToolFn): void {
    this.callToolFn = fn;
  }

  registerServerTools(serverId: string, tools: McpToolDefinition[]): void {
    // Remove existing tools for this server
    for (const [id, tool] of this.registeredTools) {
      if (tool.serverId === serverId) this.registeredTools.delete(id);
    }

    for (const tool of tools) {
      const id = `mcp__${serverId}__${tool.name}`;
      this.registeredTools.set(id, {
        id,
        serverId,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    logger.info(`Registered ${tools.length} tools from MCP server '${serverId}'`);
  }

  unregisterServerTools(serverId: string): void {
    for (const [id, tool] of this.registeredTools) {
      if (tool.serverId === serverId) this.registeredTools.delete(id);
    }
  }

  getRegisteredTools(): RegisteredMcpTool[] {
    return [...this.registeredTools.values()];
  }

  async executeTool(qualifiedId: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.registeredTools.get(qualifiedId);
    if (!tool) throw new Error(`Unknown MCP tool: ${qualifiedId}`);
    if (!this.callToolFn) throw new Error('McpToolBridge: callToolFn not configured');

    return this.callToolFn({ serverId: tool.serverId, toolName: tool.toolName, args });
  }
}
