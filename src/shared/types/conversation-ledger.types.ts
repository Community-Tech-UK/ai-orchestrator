export type ConversationProvider =
  | 'orchestrator'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'copilot'
  | 'unknown';

export type ConversationSourceKind =
  | 'orchestrator'
  | 'provider-native'
  | 'imported-file'
  | 'history-archive';

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool' | 'event';

export type ConversationSyncStatus =
  | 'never-synced'
  | 'synced'
  | 'imported'
  | 'dirty'
  | 'conflict'
  | 'error';

export type ConversationConflictStatus =
  | 'none'
  | 'external-change'
  | 'local-change'
  | 'diverged';

export type ConversationNativeVisibilityMode =
  | 'none'
  | 'app-server-durable'
  | 'filesystem-visible'
  | 'best-effort';

export interface ConversationThreadRecord {
  id: string;
  provider: ConversationProvider;
  nativeThreadId: string | null;
  nativeSessionId: string | null;
  nativeSourceKind: string | null;
  sourceKind: ConversationSourceKind;
  sourcePath: string | null;
  workspacePath: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt: number | null;
  writable: boolean;
  nativeVisibilityMode: ConversationNativeVisibilityMode;
  syncStatus: ConversationSyncStatus;
  conflictStatus: ConversationConflictStatus;
  parentConversationId: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationMessageRecord {
  id: string;
  threadId: string;
  nativeMessageId: string | null;
  nativeTurnId: string | null;
  role: ConversationRole;
  phase: string | null;
  content: string;
  createdAt: number;
  tokenInput: number | null;
  tokenOutput: number | null;
  rawRef: string | null;
  rawJson: Record<string, unknown> | null;
  sourceChecksum: string | null;
  sequence: number;
}

export interface ConversationSyncCursorRecord {
  id: string;
  threadId: string;
  provider: ConversationProvider;
  cursorKind: string;
  cursorValue: string;
  sourcePath: string | null;
  sourceMtime: number | null;
  lastSeenChecksum: string | null;
  updatedAt: number;
}

export interface ConversationThreadUpsertInput {
  id?: string;
  provider: ConversationProvider;
  nativeThreadId?: string | null;
  nativeSessionId?: string | null;
  nativeSourceKind?: string | null;
  sourceKind: ConversationSourceKind;
  sourcePath?: string | null;
  workspacePath?: string | null;
  title?: string | null;
  createdAt?: number;
  updatedAt?: number;
  lastSyncedAt?: number | null;
  writable?: boolean;
  nativeVisibilityMode?: ConversationNativeVisibilityMode;
  syncStatus?: ConversationSyncStatus;
  conflictStatus?: ConversationConflictStatus;
  parentConversationId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessageUpsertInput {
  id?: string;
  nativeMessageId?: string | null;
  nativeTurnId?: string | null;
  role: ConversationRole;
  phase?: string | null;
  content: string;
  createdAt?: number;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  rawRef?: string | null;
  rawJson?: Record<string, unknown> | null;
  sourceChecksum?: string | null;
  sequence: number;
}

export interface ConversationSyncCursorUpsertInput {
  id?: string;
  threadId: string;
  provider: ConversationProvider;
  cursorKind: string;
  cursorValue: string;
  sourcePath?: string | null;
  sourceMtime?: number | null;
  lastSeenChecksum?: string | null;
  updatedAt?: number;
}

export interface ConversationListQuery {
  provider?: ConversationProvider;
  workspacePath?: string;
  sourceKind?: ConversationSourceKind;
  syncStatus?: ConversationSyncStatus;
  limit?: number;
}

export interface ConversationMessagesQuery {
  limit?: number;
  afterSequence?: number;
}

export interface ConversationDiscoveryScope {
  provider?: ConversationProvider;
  workspacePath?: string | null;
  sourceKinds?: string[];
  includeChildThreads?: boolean;
  limit?: number;
}

export interface NativeConversationCapabilities {
  provider: ConversationProvider;
  canDiscover: boolean;
  canRead: boolean;
  canCreate: boolean;
  canResume: boolean;
  canSendTurns: boolean;
  canReconcile: boolean;
  durableByDefault: boolean;
  nativeVisibilityMode: ConversationNativeVisibilityMode;
}

export interface NativeConversationRef {
  provider: ConversationProvider;
  nativeThreadId: string;
  threadId?: string;
  sourcePath?: string | null;
  workspacePath?: string | null;
}

export interface NativeConversationThread {
  provider: ConversationProvider;
  nativeThreadId: string;
  nativeSessionId?: string | null;
  nativeSourceKind?: string | null;
  sourcePath?: string | null;
  workspacePath?: string | null;
  title?: string | null;
  createdAt?: number;
  updatedAt?: number;
  writable?: boolean;
  nativeVisibilityMode?: ConversationNativeVisibilityMode;
  metadata?: Record<string, unknown>;
}

export interface NativeConversationSnapshot {
  thread: NativeConversationThread;
  messages: ConversationMessageUpsertInput[];
  cursor?: ConversationSyncCursorUpsertInput;
  tokenTotals?: {
    input: number;
    output: number;
    cached?: number;
    reasoning?: number;
  };
  warnings: string[];
  rawRefs: string[];
}

export interface NativeThreadStartRequest {
  provider: ConversationProvider;
  workspacePath: string;
  model?: string | null;
  title?: string | null;
  ephemeral?: boolean;
  approvalPolicy?: string | null;
  sandbox?: string | null;
  reasoningEffort?: string | null;
  personality?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NativeConversationHandle {
  provider: ConversationProvider;
  nativeThreadId: string;
  nativeSessionId?: string | null;
  workspacePath?: string | null;
  sourcePath?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NativeTurnRequest {
  text: string;
  inputItems?: NativeConversationInputItem[];
  model?: string | null;
  approvalPolicy?: string | null;
  sandbox?: string | null;
  reasoningEffort?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NativeConversationInputItem {
  type: 'text' | 'image' | 'localImage' | 'skill' | 'mention';
  text?: string;
  url?: string;
  path?: string;
  name?: string;
}

export interface NativeTurnResult {
  provider: ConversationProvider;
  nativeThreadId: string;
  nativeTurnId?: string | null;
  messages: ConversationMessageUpsertInput[];
  metadata?: Record<string, unknown>;
}

export interface ReconciliationResult {
  threadId?: string;
  provider: ConversationProvider;
  nativeThreadId?: string | null;
  addedMessages: number;
  updatedMessages: number;
  deletedMessages: number;
  cursor?: ConversationSyncCursorUpsertInput;
  syncStatus: ConversationSyncStatus;
  conflictStatus: ConversationConflictStatus;
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface ConversationLedgerConversation {
  thread: ConversationThreadRecord;
  messages: ConversationMessageRecord[];
}
