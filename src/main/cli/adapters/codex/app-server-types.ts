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
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ThreadStartParams {
  cwd: string;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  serviceName?: string;
  ephemeral?: boolean;
  experimentalRawEvents?: boolean;
  reasoningEffort?: CodexReasoningEffort | null;
}

export interface ThreadStartResponse {
  threadId: string;
  thread?: {
    id: string;
    name?: string;
  };
}

export interface ThreadResumeParams {
  threadId: string;
  cwd: string;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
}

export interface ThreadResumeResponse {
  threadId: string;
  thread?: {
    id: string;
    name?: string;
  };
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export interface ThreadSetNameResponse {
  success: boolean;
}

export interface ThreadListParams {
  searchTerm?: string;
  limit?: number;
}

export interface ThreadListResponse {
  threads: ThreadInfo[];
}

export interface ThreadInfo {
  id: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Thread Compaction ──────────────────────────────────────────────────────

export interface ThreadCompactStartParams {
  threadId: string;
}

export interface ThreadCompactStartResponse {
  success: boolean;
}

// ─── Turn Management ────────────────────────────────────────────────────────

export interface UserInput {
  type: 'text';
  text: string;
  text_elements?: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  /** JSON Schema for structured output. */
  outputSchema?: Record<string, unknown>;
  reasoningEffort?: CodexReasoningEffort | null;
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
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  usage?: TurnUsage;
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
  exit_code?: number;
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
  // Review mode fields
  review?: string;
  // MCP tool call fields
  server?: string;
  // Web search fields
  query?: string;
  // Reasoning fields
  summary?: unknown;
  summaryText?: string;
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

/** Notification methods we opt out of to simplify processing. */
export const DEFAULT_OPT_OUT_NOTIFICATIONS = [
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
];

/** Service name identifying the orchestrator to the Codex server. */
export const SERVICE_NAME = 'ai-orchestrator';

/** Prefix for persistent task thread names. */
export const TASK_THREAD_PREFIX = 'AI Orchestrator Task';
