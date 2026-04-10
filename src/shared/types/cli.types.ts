/**
 * CLI Types - Claude Code CLI stream message types
 */

/**
 * Base type for all CLI stream messages
 */
export interface CliStreamMessageBase {
  type: string;
  timestamp?: number;
}

/**
 * Assistant message - Claude's response text
 */
export interface CliAssistantMessage extends CliStreamMessageBase {
  type: 'assistant';
  content: string;
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'tool_deferred';
}

/**
 * User message echo
 */
export interface CliUserMessage extends CliStreamMessageBase {
  type: 'user';
  content: string;
}

/**
 * System message - context updates, session info, etc.
 */
export interface CliSystemMessage extends CliStreamMessageBase {
  type: 'system';
  subtype: 'init' | 'context_usage' | 'session' | 'info' | 'warning';
  content?: string;
  session_id?: string;
  usage?: CliContextUsage;
}

/**
 * Tool use message - when Claude wants to use a tool
 */
export interface CliToolUseMessage extends CliStreamMessageBase {
  type: 'tool_use';
  tool: {
    name: string;
    id: string;
    input: Record<string, unknown>;
  };
}

/**
 * Tool result message - result of tool execution
 */
export interface CliToolResultMessage extends CliStreamMessageBase {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Result message - final result of a conversation turn
 */
export interface CliResultMessage extends CliStreamMessageBase {
  type: 'result';
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'tool_deferred';
  deferred_tool_use?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}

/**
 * Error message from CLI
 */
export interface CliErrorMessage extends CliStreamMessageBase {
  type: 'error';
  error: {
    code: string;
    message: string;
  };
}

/**
 * Input required message - waiting for user input
 */
export interface CliInputRequiredMessage extends CliStreamMessageBase {
  type: 'input_required';
  prompt?: string;
}

/**
 * MCP elicitation message - an MCP server is requesting structured input
 * via an interactive dialog (e.g. OAuth consent, config form).
 * Claude Code emits these when an MCP server uses the elicitation protocol.
 */
export interface CliElicitationMessage extends CliStreamMessageBase {
  type: 'elicitation';
  /** The MCP server requesting input */
  server_name?: string;
  /** Human-readable message explaining what input is needed */
  message?: string;
  /** JSON Schema describing the expected input structure */
  schema?: Record<string, unknown>;
  /** Unique ID for this elicitation request (for responding) */
  request_id?: string;
}

/**
 * Context usage information
 */
export interface CliContextUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens: number;
  max_tokens: number;
  percentage: number;
}

/**
 * Union of all CLI stream message types
 */
export type CliStreamMessage =
  | CliAssistantMessage
  | CliUserMessage
  | CliSystemMessage
  | CliToolUseMessage
  | CliToolResultMessage
  | CliResultMessage
  | CliErrorMessage
  | CliInputRequiredMessage
  | CliElicitationMessage;

/**
 * Type guard functions
 */
export function isAssistantMessage(msg: CliStreamMessage): msg is CliAssistantMessage {
  return msg.type === 'assistant';
}

export function isSystemMessage(msg: CliStreamMessage): msg is CliSystemMessage {
  return msg.type === 'system';
}

export function isToolUseMessage(msg: CliStreamMessage): msg is CliToolUseMessage {
  return msg.type === 'tool_use';
}

export function isToolResultMessage(msg: CliStreamMessage): msg is CliToolResultMessage {
  return msg.type === 'tool_result';
}

export function isResultMessage(msg: CliStreamMessage): msg is CliResultMessage {
  return msg.type === 'result';
}

export function isErrorMessage(msg: CliStreamMessage): msg is CliErrorMessage {
  return msg.type === 'error';
}

export function isInputRequiredMessage(msg: CliStreamMessage): msg is CliInputRequiredMessage {
  return msg.type === 'input_required';
}

export function isElicitationMessage(msg: CliStreamMessage): msg is CliElicitationMessage {
  return msg.type === 'elicitation';
}

/**
 * CLI spawn options
 */
export interface CliSpawnOptions {
  workingDirectory: string;
  sessionId?: string;
  resume?: boolean;  // Resume a previous session (requires sessionId)
  model?: string;
  maxTokens?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  yoloMode?: boolean;  // Auto-approve all permissions
}

/**
 * CLI input message format (for stream-json input)
 */
export interface CliInputMessage {
  type: 'user';
  content: string;
  attachments?: CliAttachment[];
}

export interface CliAttachment {
  type: 'file' | 'image';
  name: string;
  data: string; // base64 for images, file path for files
  mime_type?: string;
}
