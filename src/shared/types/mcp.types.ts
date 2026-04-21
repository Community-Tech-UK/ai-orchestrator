/**
 * MCP Types - Model Context Protocol Integration
 *
 * MCP enables extending AI capabilities with external tools, resources, and prompts.
 * Reference: https://modelcontextprotocol.io/
 */

/**
 * MCP Server configuration
 */
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  // Server transport type
  transport: 'stdio' | 'http' | 'sse';
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For http/sse transport
  url?: string;
  headers?: Record<string, string>;
  // Authentication
  auth?: McpAuthConfig;
  // Auto-connect on startup
  autoConnect?: boolean;
  // Server capabilities (discovered after connection)
  capabilities?: McpServerCapabilities;
  // Connection status
  status?: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  lifecycle?: McpServerLifecycleReport;
}

/**
 * MCP authentication configuration
 */
export interface McpAuthConfig {
  type: 'none' | 'api-key' | 'oauth' | 'bearer';
  // For api-key auth
  apiKey?: string;
  apiKeyHeader?: string;
  // For oauth
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  scopes?: string[];
  // For bearer token
  token?: string;
}

/**
 * MCP Server capabilities (discovered via initialize)
 */
export interface McpServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
  // Experimental capabilities
  experimental?: Record<string, boolean>;
}

/**
 * MCP Tool definition
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpJsonSchema;
  // Server this tool belongs to
  serverId: string;
}

/**
 * MCP Resource definition
 */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  // Server this resource belongs to
  serverId: string;
}

/**
 * MCP Prompt definition
 */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
  // Server this prompt belongs to
  serverId: string;
}

/**
 * MCP Prompt argument
 */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * JSON Schema for MCP tool inputs
 */
export interface McpJsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  items?: McpJsonSchema;
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
}

/**
 * MCP Tool call request
 */
export interface McpToolCallRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * MCP Tool call response
 */
export interface McpToolCallResponse {
  success: boolean;
  content?: McpContent[];
  error?: string;
  isError?: boolean;
}

/**
 * MCP Content types
 */
export type McpContent =
  | McpTextContent
  | McpImageContent
  | McpResourceContent;

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;  // base64 encoded
  mimeType: string;
}

export interface McpResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    text?: string;
    blob?: string;  // base64 encoded
    mimeType?: string;
  };
}

/**
 * MCP Resource read request
 */
export interface McpResourceReadRequest {
  serverId: string;
  uri: string;
}

/**
 * MCP Resource read response
 */
export interface McpResourceReadResponse {
  success: boolean;
  contents?: McpContent[];
  error?: string;
}

/**
 * MCP Prompt get request
 */
export interface McpPromptGetRequest {
  serverId: string;
  promptName: string;
  arguments?: Record<string, string>;
}

/**
 * MCP Prompt message
 */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContent;
}

/**
 * MCP Prompt get response
 */
export interface McpPromptGetResponse {
  success: boolean;
  description?: string;
  messages?: McpPromptMessage[];
  error?: string;
}

/**
 * MCP Log level
 */
export type McpLogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * MCP Log entry
 */
export interface McpLogEntry {
  level: McpLogLevel;
  logger?: string;
  message: string;
  timestamp: number;
  serverId: string;
}

/**
 * MCP Manager state
 */
export interface McpManagerState {
  servers: McpServerConfig[];
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export type McpLifecyclePhase = 'transport' | 'initialize' | 'discover' | 'ready';

export type McpLifecyclePhaseState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface McpLifecyclePhaseReport {
  phase: McpLifecyclePhase;
  state: McpLifecyclePhaseState;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface McpServerLifecycleReport {
  serverId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error';
  retryCount: number;
  phases: McpLifecyclePhaseReport[];
  error?: string;
}

/**
 * Default MCP server presets
 */
export const MCP_SERVER_PRESETS: Partial<McpServerConfig>[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on the local filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Interact with GitHub repositories, issues, and pull requests',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Access and manage Google Drive files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation and web scraping',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages and interact with Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent memory storage for AI context',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
];
