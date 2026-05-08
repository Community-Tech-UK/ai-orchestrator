/**
 * Codex App-Server Protocol Types
 *
 * JSON-RPC 2.0 types for the `codex app-server` persistent server protocol.
 * Derived from the codex-plugin-cc reference implementation.
 *
 * The app-server communicates over JSONL (newline-delimited JSON) via stdio
 * pipes or Unix sockets, using a turn-based execution model with streaming
 * notifications.
 */

// ─── JSON-RPC Base Types ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── Initialize ─────────────────────────────────────────────────────────────

export interface ClientInfo {
  title: string;
  name: string;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  /** Notification methods the client does NOT want to receive. */
  optOutNotificationMethods: string[];
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities;
}

export interface InitializeResponse {
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

// ─── Thread Management ──────────────────────────────────────────────────────

export type CodexApprovalPolicy = 'never' | 'unless-allow-listed' | 'always';
export type CodexAskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never' | { granular: Record<string, boolean> };
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown };
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type SortDirection = 'asc' | 'desc';
export type ThreadSortKey = 'created_at' | 'updated_at';
export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';
export type SessionSource = ThreadSourceKind | { custom: string } | { subAgent: unknown };
export type ThreadStatus = 'running' | 'ready' | 'idle' | 'failed' | 'closed' | 'archived' | string;

export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: CodexApprovalPolicy | CodexAskForApproval | null;
  approvalsReviewer?: unknown;
  sandbox?: CodexSandboxMode;
  serviceName?: string;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean;
  experimentalRawEvents?: boolean;
  /** Legacy name accepted by older Codex app-server builds. */
  reasoningEffort?: CodexReasoningEffort | null;
  /** Generated 0.128.x name for turn-level reasoning. */
  effort?: CodexReasoningEffort | null;
  sessionStartSource?: string | null;
  config?: Record<string, unknown> | null;
}

export interface ThreadStartResponse {
  threadId: string;
  thread?: ThreadInfo;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy | CodexAskForApproval | null;
  sandbox?: CodexSandboxMode;
}

export interface ThreadResumeResponse {
  threadId: string;
  thread?: ThreadInfo;
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export interface ThreadSetNameResponse {
  success: boolean;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number;
  sortKey?: ThreadSortKey | null;
  sortDirection?: SortDirection | null;
  modelProviders?: string[] | null;
  sourceKinds?: ThreadSourceKind[] | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
}

export interface ThreadListResponse {
  data: ThreadInfo[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadInfo {
  id: string;
  forkedFromId?: string | null;
  preview?: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  status?: ThreadStatus;
  path?: string | null;
  cwd?: string;
  cliVersion?: string;
  source?: SessionSource;
  agentNickname?: string | null;
  agentRole?: string | null;
  gitInfo?: Record<string, unknown> | null;
  name?: string | null;
  turns?: Turn[];
  [key: string]: unknown;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface ThreadReadResponse {
  thread: ThreadInfo;
}

export interface ThreadTurnsListParams {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: SortDirection | null;
}

export interface ThreadTurnsListResponse {
  data: Turn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

// ─── Thread Compaction ──────────────────────────────────────────────────────

export interface ThreadCompactStartParams {
  threadId: string;
}

export interface ThreadCompactStartResponse {
  success: boolean;
}

// ─── Turn Management ────────────────────────────────────────────────────────

export interface TextUserInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export interface ImageUserInput {
  type: 'image';
  url: string;
}

export interface LocalImageUserInput {
  type: 'localImage';
  path: string;
}

export interface SkillUserInput {
  type: 'skill';
  name: string;
  path: string;
}

export interface MentionUserInput {
  type: 'mention';
  name: string;
  path: string;
}

export type UserInput =
  | TextUserInput
  | ImageUserInput
  | LocalImageUserInput
  | SkillUserInput
  | MentionUserInput;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | CodexAskForApproval | null;
  approvalsReviewer?: unknown;
  sandboxPolicy?: CodexSandboxPolicy | null;
  model?: string | null;
  serviceTier?: string | null;
  /** JSON Schema for structured output. */
  outputSchema?: Record<string, unknown>;
  /** Legacy name accepted by older Codex app-server builds. */
  reasoningEffort?: CodexReasoningEffort | null;
  /** Generated 0.128.x reasoning field names. */
  effort?: CodexReasoningEffort | null;
  summary?: unknown;
  personality?: string | null;
}

export interface TurnStartResponse {
  turn?: Turn;
  threadId?: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptResponse {
  success: boolean;
}

export interface Turn {
  id: string;
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed' | string;
  items?: ThreadItem[];
  error?: unknown;
  usage?: TurnUsage;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

// ─── Review ─────────────────────────────────────────────────────────────────

export interface ReviewTarget {
  uncommittedChanges?: boolean;
  baseBranch?: string;
}

export interface ReviewStartParams {
  threadId: string;
  target: ReviewTarget;
  outputSchema?: Record<string, unknown>;
}

export interface ReviewStartResponse {
  turn?: Turn;
}

// ─── Thread Items (from Notifications) ──────────────────────────────────────

export interface ThreadItem {
  id?: string;
  type: string;
  // Command execution fields
  command?: string;
  aggregated_output?: string;
  aggregatedOutput?: string | null;
  exit_code?: number;
  exitCode?: number | null;
  status?: string;
  // Agent message fields
  text?: string;
  message?: { content?: string; role?: string };
  content?: string;
  phase?: string;
  // File change fields
  path?: string;
  changeType?: string;
  changes?: { path?: string }[];
  description?: string;
  // Tool call fields
  toolId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  // Collaboration / subagent fields
  tool?: string;
  receiverThreadIds?: string[];
  senderThreadId?: string;
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  agentsStates?: Record<string, unknown>;
  // Review mode fields
  review?: string;
  // MCP tool call fields
  server?: string;
  // Web search fields
  query?: string;
  // Reasoning fields
  summary?: unknown;
  summaryText?: string;
  // Generated 0.128.x escape hatch for version-specific item fields.
  [key: string]: unknown;
}

// ─── Notification Types ─────────────────────────────────────────────────────

export type AppServerNotification = JsonRpcNotification & {
  method: AppServerNotificationMethod;
  params: Record<string, unknown>;
};

export type AppServerNotificationMethod =
  | 'thread/started'
  | 'thread/name/updated'
  | 'thread/tokenUsage/updated'
  | 'thread/compacted'
  | 'turn/started'
  | 'turn/completed'
  | 'item/started'
  | 'item/completed'
  | 'item/agentMessage/delta'
  | 'item/reasoning/summaryTextDelta'
  | 'item/reasoning/summaryPartAdded'
  | 'item/reasoning/textDelta'
  | 'error';

// ─── Method Map (for typed request/response) ────────────────────────────────

export interface AppServerMethodMap {
  'initialize': { params: InitializeParams; result: InitializeResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  'thread/list': { params: ThreadListParams; result: ThreadListResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse };
  'thread/compact/start': { params: ThreadCompactStartParams; result: ThreadCompactStartResponse };
  'review/start': { params: ReviewStartParams; result: ReviewStartResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]['params'];
export type AppServerResponseResult<M extends AppServerMethod> = AppServerMethodMap[M]['result'];

export type AppServerNotificationHandler = (message: AppServerNotification) => void;

// ─── Turn Capture State ─────────────────────────────────────────────────────

/** Progress phase for UI feedback during turn execution. */
export type TurnPhase =
  | 'starting'
  | 'running'
  | 'verifying'
  | 'editing'
  | 'investigating'
  | 'reviewing'
  | 'finalizing'
  | 'failed';

export interface TurnProgressUpdate {
  message: string;
  phase: TurnPhase | null;
  threadId?: string | null;
  turnId?: string | null;
}

export type ProgressReporter = (update: string | TurnProgressUpdate) => void;

/**
 * Accumulates state from streaming notifications during a single turn.
 * Modeled after the codex-plugin-cc `TurnCaptureState` pattern.
 */
export interface TurnCaptureState {
  /** Root thread ID for this turn. */
  threadId: string;
  /** All thread IDs observed (root + subagents). */
  threadIds: Set<string>;
  /** Maps thread ID → active turn ID for that thread. */
  threadTurnIds: Map<string, string>;
  /** Maps thread ID → human-readable label. */
  threadLabels: Map<string, string>;
  /** The root-level turn ID (set once `turn/started` fires). */
  turnId: string | null;
  /** Notifications received before turnId was known. */
  bufferedNotifications: AppServerNotification[];
  /** Resolves when the turn completes. */
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (state: TurnCaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  /** The final Turn object from turn/completed. */
  finalTurn: Turn | null;
  /** Whether the turn has completed. */
  completed: boolean;
  /** Whether we've seen a final-answer-phase agent message. */
  finalAnswerSeen: boolean;
  /** Pending collaboration tool calls (subagent spawning). */
  pendingCollaborations: Set<string>;
  /** Active turns in subagent threads. */
  activeSubagentTurns: Set<string>;
  /** Timer for inferred completion after final answer + subagent drain. */
  completionTimer: ReturnType<typeof setTimeout> | null;
  /** Last agent message text. */
  lastAgentMessage: string;
  /** Review text captured from exitedReviewMode items. */
  reviewText: string;
  /** Reasoning summary parts (deduplicated). */
  reasoningSummary: string[];
  /** Error captured during the turn. */
  error: unknown;
  /** All agent messages with lifecycle/phase metadata. */
  messages: { lifecycle: string; phase: string | null; text: string }[];
  /** Streaming assistant messages keyed by Codex item id. */
  streamingAgentMessages: Map<string, {
    outputId: string;
    content: string;
    deltaSeen: boolean;
  }>;
  /** Output id used for the final root assistant message, if streamed. */
  finalAgentOutputId: string | null;
  /** File changes from item/completed notifications. */
  fileChanges: ThreadItem[];
  /** Command executions from item/completed notifications. */
  commandExecutions: ThreadItem[];
  /** Progress callback. */
  onProgress: ProgressReporter | null;
}

// ─── Client Options ─────────────────────────────────────────────────────────

export interface CodexAppServerClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Env var pointing to a running broker endpoint. */
export const BROKER_ENDPOINT_ENV = 'CODEX_COMPANION_APP_SERVER_ENDPOINT';

/** JSON-RPC error code when the broker is processing another stream. */
export const BROKER_BUSY_RPC_CODE = -32001;

/** Methods that claim the streaming session on the broker. */
export const STREAMING_METHODS = new Set([
  'turn/start',
  'review/start',
  'thread/compact/start',
]);

/**
 * Notification methods we opt out of to simplify processing.
 *
 * Keep assistant message deltas enabled so the UI can stream visible Codex
 * responses instead of waiting for the final item/completed event.
 */
export const DEFAULT_OPT_OUT_NOTIFICATIONS = [
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
];

/** Service name identifying the orchestrator to the Codex server. */
export const SERVICE_NAME = 'ai-orchestrator';

/** Prefix for persistent task thread names. */
export const TASK_THREAD_PREFIX = 'AI Orchestrator Task';
