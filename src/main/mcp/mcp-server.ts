import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { type McpServerToolDefinition } from './mcp-server-tools';

const logger = getLogger('McpServer');

export interface McpServerConfig {
  port?: number;
  tools: McpServerToolDefinition[];
}

export class McpServer extends EventEmitter {
  private static instance: McpServer | null = null;
  private tools = new Map<string, McpServerToolDefinition>();
  private started = false;

  static getInstance(): McpServer {
    if (!this.instance) this.instance = new McpServer();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  registerTools(tools: McpServerToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    logger.info(`Registered ${tools.length} MCP server tools`);
  }

  getRegisteredTools(): McpServerToolDefinition[] {
    return [...this.tools.values()];
  }

  async handleRequest(request: { method: string; params?: unknown; id?: number }): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-orchestrator', version: '1.0.0' },
        };

      case 'tools/list':
        return {
          tools: [...this.tools.values()].map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };

      case 'tools/call': {
        const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) throw new Error('Missing tool name');
        const tool = this.tools.get(params.name);
        if (!tool) throw new Error(`Unknown tool: ${params.name}`);
        const result = await tool.handler(params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): void {
    this.started = true;
    logger.info('MCP server started');
    this.emit('started');
  }

  stop(): void {
    this.started = false;
    logger.info('MCP server stopped');
    this.emit('stopped');
  }
}
