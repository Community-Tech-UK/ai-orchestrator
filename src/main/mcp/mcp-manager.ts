/**
 * MCP Manager - Handle MCP server connections and tool execution
 *
 * Features:
 * - Manage multiple MCP server connections
 * - Execute tools, read resources, get prompts
 * - Handle server lifecycle (connect, disconnect, restart)
 * - Event-based communication for status updates
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { getLogger } from '../logging/logger';
import { getSafeEnvForTrustedProcess } from '../security/env-filter';
import { registerCleanup } from '../util/cleanup-registry';
import { SseTransport } from './transports/sse-transport';
import { HttpTransport } from './transports/http-transport';
import { getMCPToolSearchService } from './mcp-tool-search';

const logger = getLogger('McpManager');
import {
  McpServerConfig,
  McpLifecyclePhase,
  McpLifecyclePhaseState,
  McpTool,
  McpResource,
  McpPrompt,
  McpToolCallRequest,
  McpToolCallResponse,
  McpResourceReadRequest,
  McpResourceReadResponse,
  McpPromptGetRequest,
  McpPromptGetResponse,
  McpContent,
  McpLogEntry,
  McpManagerState,
  McpServerCapabilities,
} from '../../shared/types/mcp.types';

// JSON-RPC message types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// MCP Events
export interface McpManagerEvents {
  'server:connected': (serverId: string) => void;
  'server:disconnected': (serverId: string) => void;
  'server:error': (serverId: string, error: string) => void;
  'server:phase': (
    serverId: string,
    phase: McpLifecyclePhase,
    state: McpLifecyclePhaseState,
    error?: string,
  ) => void;
  'tools:updated': (tools: McpTool[]) => void;
  'resources:updated': (resources: McpResource[]) => void;
  'prompts:updated': (prompts: McpPrompt[]) => void;
  'log': (entry: McpLogEntry) => void;
}

interface ServerConnection {
  config: McpServerConfig;
  process?: ChildProcess;
  sseTransport?: SseTransport;
  httpTransport?: HttpTransport;
  requestId: number;
  pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>;
  buffer: string;
}

export class McpManager extends EventEmitter {
  private connections: Map<string, ServerConnection> = new Map();
  private tools: Map<string, McpTool> = new Map();
  private resources: Map<string, McpResource> = new Map();
  private prompts: Map<string, McpPrompt> = new Map();

  constructor() {
    super();
    registerCleanup(() => this.shutdown());
  }

  // ============================================
  // Server Management
  // ============================================

  /**
   * Add a server configuration.
   * Deduplicates servers with the same command+args to prevent double connections
   * when the same server is configured in multiple places (inspired by CC 2.1.84).
   */
  addServer(config: McpServerConfig): void {
    // Check for duplicate server by command + args + env signature.
    // Including env in the key prevents false dedup when the same binary
    // is configured with different API tokens or scopes (Codex review finding).
    // Local/explicit config wins over duplicates (first registration wins).
    if (config.command) {
      const argsKey = JSON.stringify(config.args || []);
      const envKey = config.env ? JSON.stringify(Object.keys(config.env).sort()) : '';
      for (const existing of this.connections.values()) {
        const existingEnvKey = existing.config.env
          ? JSON.stringify(Object.keys(existing.config.env).sort())
          : '';
        if (
          existing.config.command === config.command &&
          JSON.stringify(existing.config.args || []) === argsKey &&
          existingEnvKey === envKey &&
          existing.config.id !== config.id
        ) {
          logger.info('Skipping duplicate MCP server registration', {
            newId: config.id,
            existingId: existing.config.id,
            command: config.command,
          });
          return;
        }
      }
    }

    const connection: ServerConnection = {
      config: { ...config, status: 'disconnected' },
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
    };
    this.connections.set(config.id, connection);

    // Auto-connect if configured
    if (config.autoConnect) {
      this.connect(config.id).catch((err) => {
        logger.error('Failed to auto-connect to MCP server', err instanceof Error ? err : undefined, { serverId: config.id });
      });
    }
  }

  async upsertServer(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.id)) {
      await this.removeServer(config.id);
    }
    this.addServer(config);
  }

  /**
   * Remove a server
   */
  async removeServer(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    this.connections.delete(serverId);

    // Remove associated tools, resources, and prompts
    this.removeServerItems(serverId);
  }

  /**
   * Connect to a server
   */
  async connect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server not found: ${serverId}`);
    }

    if (connection.config.status === 'connected') {
      return;
    }

    connection.config.status = 'connecting';

    try {
      await this.runPhase(serverId, 'transport', async () => {
        if (connection.config.transport === 'stdio') {
          await this.connectStdio(connection);
        } else if (connection.config.transport === 'sse') {
          await this.connectSse(connection);
        } else if (connection.config.transport === 'http') {
          await this.connectHttp(connection);
        } else {
          throw new Error(`Transport ${connection.config.transport} not yet implemented`);
        }
      });

      await this.runPhase(serverId, 'initialize', async () => {
        await this.initializeServer(connection);
      });

      connection.config.status = 'connected';
      this.emit('server:connected', serverId);

      await this.runPhase(serverId, 'discover', async () => {
        await this.discoverCapabilities(connection);
      });
      this.emit('server:phase', serverId, 'ready', 'succeeded');
    } catch (error) {
      connection.config.status = 'error';
      connection.config.error = (error as Error).message;
      this.emit('server:error', serverId, (error as Error).message);
      throw error;
    }
  }

  /**
   * Disconnect from a server
   */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection || connection.config.status === 'disconnected') {
      return;
    }

    // Kill the process (stdio transport)
    if (connection.process) {
      connection.process.kill();
      connection.process = undefined;
    }

    // Disconnect SSE transport
    if (connection.sseTransport) {
      connection.sseTransport.disconnect();
      connection.sseTransport = undefined;
    }

    if (connection.httpTransport) {
      await connection.httpTransport.disconnect();
      connection.httpTransport = undefined;
    }

    // Reject pending requests
    for (const [, pending] of connection.pendingRequests) {
      pending.reject(new Error('Server disconnected'));
    }
    connection.pendingRequests.clear();

    connection.config.status = 'disconnected';
    this.emit('server:disconnected', serverId);

    // Remove associated items
    this.removeServerItems(serverId);
  }

  /**
   * Restart a server connection
   */
  async restart(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    await this.connect(serverId);
  }

  // ============================================
  // Tool Operations
  // ============================================

  /**
   * Call a tool
   */
  async callTool(request: McpToolCallRequest): Promise<McpToolCallResponse> {
    const connection = this.connections.get(request.serverId);
    if (!connection || connection.config.status !== 'connected') {
      return {
        success: false,
        error: 'Server not connected',
      };
    }

    try {
      const result = await this.sendRequest(connection, 'tools/call', {
        name: request.toolName,
        arguments: request.arguments,
      });

      const response = result as { content?: McpContent[]; isError?: boolean };
      return {
        success: !response.isError,
        content: response.content,
        isError: response.isError,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get all available tools
   */
  getTools(): McpTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools for a specific server
   */
  getServerTools(serverId: string): McpTool[] {
    return this.getTools().filter((t) => t.serverId === serverId);
  }

  // ============================================
  // Resource Operations
  // ============================================

  /**
   * Read a resource
   */
  async readResource(request: McpResourceReadRequest): Promise<McpResourceReadResponse> {
    const connection = this.connections.get(request.serverId);
    if (!connection || connection.config.status !== 'connected') {
      return {
        success: false,
        error: 'Server not connected',
      };
    }

    try {
      const result = await this.sendRequest(connection, 'resources/read', {
        uri: request.uri,
      });

      const response = result as { contents?: McpContent[] };
      return {
        success: true,
        contents: response.contents,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get all available resources
   */
  getResources(): McpResource[] {
    return Array.from(this.resources.values());
  }

  // ============================================
  // Prompt Operations
  // ============================================

  /**
   * Get a prompt
   */
  async getPrompt(request: McpPromptGetRequest): Promise<McpPromptGetResponse> {
    const connection = this.connections.get(request.serverId);
    if (!connection || connection.config.status !== 'connected') {
      return {
        success: false,
        error: 'Server not connected',
      };
    }

    try {
      const result = await this.sendRequest(connection, 'prompts/get', {
        name: request.promptName,
        arguments: request.arguments,
      });

      const response = result as McpPromptGetResponse;
      return {
        success: true,
        description: response.description,
        messages: response.messages,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get all available prompts
   */
  getPrompts(): McpPrompt[] {
    return Array.from(this.prompts.values());
  }

  // ============================================
  // State Management
  // ============================================

  /**
   * Get current state
   */
  getState(): McpManagerState {
    const servers = Array.from(this.connections.values()).map((c) => c.config);
    return {
      servers,
      tools: this.getTools(),
      resources: this.getResources(),
      prompts: this.getPrompts(),
    };
  }

  /**
   * Get server status
   */
  getServerStatus(serverId: string): McpServerConfig | undefined {
    return this.connections.get(serverId)?.config;
  }

  /**
   * Get all servers
   */
  getServers(): McpServerConfig[] {
    return Array.from(this.connections.values()).map((c) => c.config);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Connect via stdio transport
   */
  private async connectStdio(connection: ServerConnection): Promise<void> {
    const { command, args, env } = connection.config;
    if (!command) {
      throw new Error('No command specified for stdio transport');
    }

    // Use safe environment to prevent credential leakage to MCP server processes.
    // Server-specific env vars are applied on top of the filtered base.
    const safeEnv = getSafeEnvForTrustedProcess();
    const proc = spawn(command, args || [], {
      env: { ...safeEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    connection.process = proc;

    // Handle stdout (JSON-RPC messages)
    proc.stdout?.on('data', (data: Buffer) => {
      this.handleStdoutData(connection, data);
    });

    // Handle stderr (logging)
    proc.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      this.emit('log', {
        level: 'error',
        message,
        timestamp: Date.now(),
        serverId: connection.config.id,
      });
    });

    // Handle process exit
    proc.on('exit', (code) => {
      if (connection.config.status === 'connected') {
        connection.config.status = 'disconnected';
        this.emit('server:disconnected', connection.config.id);
      }
    });

    // Wait a bit for the process to start
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Connect via SSE transport
   */
  private async connectSse(connection: ServerConnection): Promise<void> {
    if (!connection.config.url) {
      throw new Error('SSE transport requires a url in the config');
    }

    const transport = new SseTransport({
      url: connection.config.url,
      headers: connection.config.headers,
    });

    transport.on('message', (msg: unknown) => {
      this.handleSseMessage(connection, msg);
    });

    transport.on('disconnected', () => {
      if (connection.config.status === 'connected') {
        connection.config.status = 'disconnected';
        this.emit('server:disconnected', connection.config.id);
      }
    });

    transport.on('error', (err: Error) => {
      connection.config.status = 'error';
      connection.config.error = err.message;
      this.emit('server:error', connection.config.id, err.message);
    });

    await transport.connect();
    connection.sseTransport = transport;
  }

  private async connectHttp(connection: ServerConnection): Promise<void> {
    if (!connection.config.url) {
      throw new Error('HTTP transport requires a url in the config');
    }

    const transport = new HttpTransport({
      url: connection.config.url,
      headers: connection.config.headers,
    });

    transport.on('message', (msg: unknown) => {
      this.handleMessage(connection, msg as JsonRpcResponse | JsonRpcNotification);
    });

    transport.on('disconnected', () => {
      if (connection.config.status === 'connected') {
        connection.config.status = 'disconnected';
        this.emit('server:disconnected', connection.config.id);
      }
    });

    transport.on('error', (err: Error) => {
      connection.config.status = 'error';
      connection.config.error = err.message;
      this.emit('server:error', connection.config.id, err.message);
    });

    await transport.connect();
    connection.httpTransport = transport;
  }

  /**
   * Handle a JSON-RPC message received via SSE transport
   */
  private handleSseMessage(connection: ServerConnection, msg: unknown): void {
    const message = msg as JsonRpcResponse | JsonRpcNotification;
    this.handleMessage(connection, message);
  }

  /**
   * Handle stdout data from stdio transport
   */
  private handleStdoutData(connection: ServerConnection, data: Buffer): void {
    connection.buffer += data.toString();

    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = connection.buffer.indexOf('\n')) !== -1) {
      const line = connection.buffer.slice(0, newlineIndex);
      connection.buffer = connection.buffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.handleMessage(connection, message);
      } catch {
        logger.error('Failed to parse MCP message', undefined, { line });
      }
    }
  }

  /**
   * Handle a JSON-RPC message
   */
  private handleMessage(
    connection: ServerConnection,
    message: JsonRpcResponse | JsonRpcNotification
  ): void {
    // Handle response
    if ('id' in message) {
      const pending = connection.pendingRequests.get(message.id);
      if (pending) {
        connection.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Handle notification
    if ('method' in message) {
      this.handleNotification(connection, message);
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private handleNotification(
    connection: ServerConnection,
    notification: JsonRpcNotification
  ): void {
    switch (notification.method) {
      case 'notifications/tools/list_changed':
        this.listTools(connection).catch((err) => logger.error('Failed to refresh tools list', err instanceof Error ? err : undefined));
        break;
      case 'notifications/resources/list_changed':
        this.listResources(connection).catch((err) => logger.error('Failed to refresh resources list', err instanceof Error ? err : undefined));
        break;
      case 'notifications/prompts/list_changed':
        this.listPrompts(connection).catch((err) => logger.error('Failed to refresh prompts list', err instanceof Error ? err : undefined));
        break;
      case 'notifications/message':
        const params = notification.params as { level: string; logger?: string; data: string };
        this.emit('log', {
          level: params.level as McpLogEntry['level'],
          logger: params.logger,
          message: params.data,
          timestamp: Date.now(),
          serverId: connection.config.id,
        });
        break;
    }
  }

  /**
   * Send a JSON-RPC request
   */
  private sendRequest(
    connection: ServerConnection,
    method: string,
    params?: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++connection.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      connection.pendingRequests.set(id, { resolve, reject });

      // Send via the appropriate transport
      if (connection.sseTransport) {
        connection.sseTransport.send(request).catch(err => {
          connection.pendingRequests.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      } else if (connection.httpTransport) {
        connection.httpTransport.send(request).catch(err => {
          connection.pendingRequests.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      } else if (connection.process?.stdin) {
        connection.process.stdin.write(JSON.stringify(request) + '\n');
      } else {
        reject(new Error('Process not connected'));
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (connection.pendingRequests.has(id)) {
          connection.pendingRequests.delete(id);
          reject(new Error('Request timed out'));
        }
      }, 30000);
    });
  }

  /**
   * Initialize the server
   */
  private async initializeServer(connection: ServerConnection): Promise<void> {
    const result = await this.sendRequest(connection, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: {
          listChanged: true,
        },
      },
      clientInfo: {
        name: 'claude-orchestrator',
        version: '0.1.0',
      },
    });

    const initResult = result as {
      protocolVersion: string;
      capabilities: McpServerCapabilities;
      serverInfo?: { name: string; version?: string };
    };

    connection.config.capabilities = initResult.capabilities;

    // Send initialized notification
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    if (connection.sseTransport) {
      await connection.sseTransport.send(notification);
    } else if (connection.httpTransport) {
      await connection.httpTransport.send(notification);
    } else if (connection.process?.stdin) {
      connection.process.stdin.write(JSON.stringify(notification) + '\n');
    }
  }

  /**
   * Discover server capabilities (tools, resources, prompts)
   */
  private async discoverCapabilities(connection: ServerConnection): Promise<void> {
    const caps = connection.config.capabilities;

    if (caps?.tools) {
      await this.listTools(connection);
    }
    if (caps?.resources) {
      await this.listResources(connection);
    }
    if (caps?.prompts) {
      await this.listPrompts(connection);
    }
  }

  private async runPhase(
    serverId: string,
    phase: McpLifecyclePhase,
    work: () => Promise<void>,
  ): Promise<void> {
    this.emit('server:phase', serverId, phase, 'running');
    try {
      await work();
      this.emit('server:phase', serverId, phase, 'succeeded');
    } catch (error) {
      this.emit(
        'server:phase',
        serverId,
        phase,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * List tools from a server
   */
  private async listTools(connection: ServerConnection): Promise<void> {
    try {
      const result = await this.sendRequest(connection, 'tools/list');
      const { tools } = result as { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
      const search = getMCPToolSearchService();
      search.registerServer({
        id: connection.config.id,
        name: connection.config.name,
        description: connection.config.description,
        uri: connection.config.url ?? connection.config.command ?? connection.config.id,
        status: 'connected',
        tools: [],
        resources: [],
        lastSeen: Date.now(),
        capabilities: {
          tools: Boolean(connection.config.capabilities?.tools),
          resources: Boolean(connection.config.capabilities?.resources),
          prompts: Boolean(connection.config.capabilities?.prompts),
          sampling: false,
        },
      });

      // Update tools map
      for (const tool of tools) {
        // Cap tool descriptions at 2KB to prevent context window bloat
        // when many MCP servers are connected (inspired by Claude Code 2.1.84)
        const description = tool.description && tool.description.length > 2048
          ? tool.description.slice(0, 2045) + '...'
          : tool.description;

        const mcpTool: McpTool = {
          name: tool.name,
          description,
          inputSchema: tool.inputSchema as McpTool['inputSchema'],
          serverId: connection.config.id,
        };
        this.tools.set(`${connection.config.id}:${tool.name}`, mcpTool);
        search.indexTool({
          id: `${connection.config.id}:${tool.name}`,
          name: tool.name,
          description: description ?? '',
          serverId: connection.config.id,
          serverName: connection.config.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          tags: [],
          metadata: {},
        });
      }

      this.emit('tools:updated', this.getTools());
    } catch (error) {
      logger.error('Failed to list tools', error instanceof Error ? error : undefined);
    }
  }

  /**
   * List resources from a server
   */
  private async listResources(connection: ServerConnection): Promise<void> {
    try {
      const result = await this.sendRequest(connection, 'resources/list');
      const { resources } = result as {
        resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
      };

      // Update resources map
      for (const resource of resources) {
        const mcpResource: McpResource = {
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
          serverId: connection.config.id,
        };
        this.resources.set(`${connection.config.id}:${resource.uri}`, mcpResource);
      }

      this.emit('resources:updated', this.getResources());
    } catch (error) {
      logger.error('Failed to list resources', error instanceof Error ? error : undefined);
    }
  }

  /**
   * List prompts from a server
   */
  private async listPrompts(connection: ServerConnection): Promise<void> {
    try {
      const result = await this.sendRequest(connection, 'prompts/list');
      const { prompts } = result as {
        prompts: Array<{ name: string; description?: string; arguments?: McpPrompt['arguments'] }>;
      };

      // Update prompts map
      for (const prompt of prompts) {
        const mcpPrompt: McpPrompt = {
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments,
          serverId: connection.config.id,
        };
        this.prompts.set(`${connection.config.id}:${prompt.name}`, mcpPrompt);
      }

      this.emit('prompts:updated', this.getPrompts());
    } catch (error) {
      logger.error('Failed to list prompts', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Remove tools, resources, and prompts for a server
   */
  private removeServerItems(serverId: string): void {
    const search = getMCPToolSearchService();
    for (const tool of search.getToolsByServer(serverId)) {
      search.removeTool(tool.id);
    }
    search.unregisterServer(serverId);
    // Remove tools
    for (const [key, tool] of this.tools) {
      if (tool.serverId === serverId) {
        this.tools.delete(key);
      }
    }
    this.emit('tools:updated', this.getTools());

    // Remove resources
    for (const [key, resource] of this.resources) {
      if (resource.serverId === serverId) {
        this.resources.delete(key);
      }
    }
    this.emit('resources:updated', this.getResources());

    // Remove prompts
    for (const [key, prompt] of this.prompts) {
      if (prompt.serverId === serverId) {
        this.prompts.delete(key);
      }
    }
    this.emit('prompts:updated', this.getPrompts());
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    const serverIds = Array.from(this.connections.keys());
    await Promise.all(serverIds.map((id) => this.disconnect(id)));
  }
}

// Singleton instance
let mcpManager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!mcpManager) {
    mcpManager = new McpManager();
  }
  return mcpManager;
}
