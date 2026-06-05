import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { type McpServerToolDefinition } from './mcp-server-tools';

const logger = getLogger('McpServer');

type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Detect an image MIME type from the leading bytes of a base64 payload. */
function detectImageMimeType(base64: string): string {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  // Browser Gateway captures PNG (Puppeteer) or JPEG (extension); default to PNG.
  return 'image/png';
}

/**
 * Build MCP content for a tool result that may carry a base64 image in its
 * `data` field. Returns an `image` block (plus a text block with the remaining
 * metadata) when image bytes are present, otherwise `null` so the caller falls
 * back to plain text serialization (e.g. a failed/empty capture).
 */
function tryBuildImageContent(result: unknown): McpContentBlock[] | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const data = record['data'];
  if (typeof data !== 'string' || data.length === 0) return null;
  // Tolerate a data URI prefix even though the gateway normally strips it.
  const base64 = data.startsWith('data:')
    ? data.slice(data.indexOf(',') + 1)
    : data;
  if (base64.length === 0) return null;
  const mimeType = detectImageMimeType(base64);
  const metadata = { ...record, data: `[${mimeType} returned as image content]` };
  return [
    { type: 'image', data: base64, mimeType },
    { type: 'text', text: JSON.stringify(metadata) },
  ];
}

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
        if (tool.producesImage) {
          const imageContent = tryBuildImageContent(result);
          if (imageContent) {
            return { content: imageContent };
          }
        }
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
