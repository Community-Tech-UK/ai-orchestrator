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
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens';
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
  | CliInputRequiredMessage;

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
