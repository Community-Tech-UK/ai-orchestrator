/**
 * CLI Types
 *
 * Shared transport/message types used by the existing CLI adapters and the
 * optional ACP transport.
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
 * Control response from Claude CLI in resident streaming mode
 * (`--print --input-format stream-json`).
 * Emitted on stdout in response to a `control_request` message sent on stdin.
 *
 * The payload is nested under `response` and correlated to the originating
 * `control_request` via `request_id`. The legacy flat fields are kept optional
 * for defensive parsing of older CLI builds.
 */
export interface CliControlResponseMessage extends CliStreamMessageBase {
  type: 'control_response';
  response?: {
    subtype: 'success' | 'error' | string;
    request_id?: string;
    error?: string;
  };
  /** @deprecated legacy flat shape — prefer `response.subtype`. */
  subtype?: 'interrupt' | string;
  /** @deprecated legacy flat shape — prefer `response.subtype`. */
  status?: 'success' | 'error';
  error?: string;
}

/**
 * Rate-limit usage telemetry emitted by the Anthropic CLI. `status: 'allowed'`
 * is the steady state (no action needed); other statuses indicate active
 * throttling. `resetsAt` is a unix timestamp in SECONDS.
 */
export interface CliRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export interface CliRateLimitEventMessage extends CliStreamMessageBase {
  type: 'rate_limit_event';
  rate_limit_info?: CliRateLimitInfo;
  session_id?: string;
  uuid?: string;
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
  | CliElicitationMessage
  | CliRateLimitEventMessage
  | CliControlResponseMessage;

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

// ============================================================================
// Agent Client Protocol (ACP) types
// ============================================================================

export type AcpJsonRpcId = string | number;

export interface AcpJsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: AcpJsonRpcId;
  method: string;
  params?: TParams;
}

export interface AcpJsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

export interface AcpJsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: AcpJsonRpcId;
  result: TResult;
}

export interface AcpJsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpJsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: AcpJsonRpcId | null;
  error: AcpJsonRpcErrorObject;
}

export type AcpJsonRpcMessage =
  | AcpJsonRpcRequest
  | AcpJsonRpcNotification
  | AcpJsonRpcSuccessResponse
  | AcpJsonRpcErrorResponse;

export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version: string;
}

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
  elicitation?: {
    form?: Record<string, never>;
    url?: Record<string, never>;
  };
  _meta?: Record<string, unknown>;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  sessionCapabilities?: {
    list?: Record<string, never>;
    delete?: Record<string, never>;
    close?: Record<string, never>;
    fork?: Record<string, never>;
  };
  _meta?: Record<string, unknown>;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: AcpImplementationInfo;
  authMethods?: Array<Record<string, unknown>>;
}

export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
}

export interface AcpSessionModeDescriptor {
  id: string;
  name: string;
  description?: string;
}

export interface AcpSessionModes {
  currentModeId?: string;
  availableModes?: AcpSessionModeDescriptor[];
}

export interface AcpSessionModelDescriptor {
  modelId: string;
  name?: string;
}

/**
 * Model metadata returned by `session/new` (Cursor populates this). Note the
 * `currentModelId` is in attribute form — e.g. `composer-2.5[fast=true]` or
 * `claude-opus-4-8[thinking=true,effort=high]` — which differs from the
 * `cursor-agent --list-models` id scheme used by the catalog/UI.
 */
export interface AcpSessionModels {
  currentModelId?: string;
  availableModels?: AcpSessionModelDescriptor[];
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: AcpMcpServerConfig[];
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: AcpSessionConfigOption[];
  modes?: AcpSessionModes;
  models?: AcpSessionModels;
}

export interface AcpSessionLoadParams extends AcpSessionNewParams {
  sessionId: string;
}

export interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

export interface AcpImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string;
}

export interface AcpResourceContentBlock {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    title?: string;
  };
}

export type AcpContentBlock =
  | AcpTextContentBlock
  | AcpImageContentBlock
  | AcpResourceContentBlock;

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface AcpSessionPromptResult {
  stopReason: AcpStopReason;
  usage?: AcpPromptUsage;
}

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export type AcpToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AcpToolCallOutputContentItem {
  type: 'content';
  content: AcpContentBlock;
}

export type AcpToolCallOutputItem = AcpToolCallOutputContentItem;

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
  messageId?: string;
}

export interface AcpUserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: AcpContentBlock;
  messageId?: string;
}

export interface AcpToolCallCreatedUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: AcpToolCallOutputItem[];
}

export interface AcpToolCallDeltaUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: AcpToolCallOutputItem[];
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan';
  entries: Array<{
    content: string;
    priority?: string;
    status?: string;
  }>;
}

export interface AcpSessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string;
  summary?: string;
}

export interface AcpConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: AcpSessionConfigOption[];
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  /**
   * Slash-command catalog the agent advertises. The current ACP spec uses
   * `availableCommands` (camelCase, plural). Earlier drafts and a handful of
   * implementations used the bare `commands` key; the runtime normalizer
   * accepts either, but new code should use `availableCommands`.
   */
  availableCommands?: AcpAvailableCommand[];
  /** @deprecated Legacy alias for `availableCommands` from older ACP drafts. */
  commands?: AcpAvailableCommand[];
}

/**
 * Provider-side retry ladder progress. Observed from Grok, which wraps it in
 * an `_x.ai/session_notification` whose params match `session/update`:
 * `type: 'retrying'` while the agent backs off after an API error (rate
 * limit, 5xx), `type: 'exhausted'` when it gives up and fails the turn.
 * Field names are snake_case as emitted on the wire.
 */
export interface AcpRetryStateUpdate {
  sessionUpdate: 'retry_state';
  type?: string;
  attempt?: number;
  max_retries?: number;
  attempts?: number;
  reason?: string;
}

export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpUserMessageChunkUpdate
  | AcpToolCallCreatedUpdate
  | AcpToolCallDeltaUpdate
  | AcpPlanUpdate
  | AcpSessionInfoUpdate
  | AcpConfigOptionUpdate
  | AcpAvailableCommandsUpdate
  | AcpRetryStateUpdate;

export interface AcpSessionUpdateNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other';
}

export interface AcpPermissionToolCallReference {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: Record<string, unknown>;
}

export interface AcpSessionRequestPermissionParams {
  sessionId: string;
  toolCall: AcpPermissionToolCallReference;
  options: AcpPermissionOption[];
}

export interface AcpPermissionSelectedOutcome {
  outcome: 'selected';
  optionId: string;
}

export interface AcpPermissionCancelledOutcome {
  outcome: 'cancelled';
}

export type AcpSessionRequestPermissionOutcome =
  | AcpPermissionSelectedOutcome
  | AcpPermissionCancelledOutcome;

export interface AcpSessionRequestPermissionResult {
  outcome: AcpSessionRequestPermissionOutcome;
}

export interface AcpElicitationCreateParams {
  sessionId?: string;
  requestId?: AcpJsonRpcId;
  toolCallId?: string;
  elicitationId?: string;
  mode?: 'form' | 'url';
  message?: string;
  title?: string;
  description?: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

export interface AcpElicitationCompleteParams {
  elicitationId: string;
}

export function isAcpJsonRpcRequest(message: AcpJsonRpcMessage): message is AcpJsonRpcRequest {
  return 'id' in message && 'method' in message;
}

export function isAcpJsonRpcNotification(message: AcpJsonRpcMessage): message is AcpJsonRpcNotification {
  return !('id' in message) && 'method' in message;
}

export function isAcpJsonRpcSuccessResponse(message: AcpJsonRpcMessage): message is AcpJsonRpcSuccessResponse {
  return 'id' in message && 'result' in message;
}

export function isAcpJsonRpcErrorResponse(message: AcpJsonRpcMessage): message is AcpJsonRpcErrorResponse {
  return 'error' in message;
}
