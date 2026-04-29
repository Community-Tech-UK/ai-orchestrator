/**
 * IPC transport types: message envelope, channel type union, and payload interfaces.
 * Moved from src/shared/types/ipc.types.ts as part of Phase 1 contracts extraction.
 */

import type { IpcChannel } from '../channels/index';
import type {
  ContextUsage,
  FileAttachment,
  InstanceRecoveryMethod,
  InstanceStatus,
  OutputMessage,
  InstanceProvider,
  SessionDiffStats,
} from '@shared/types/instance.types';
import type { RepoJobStatus, RepoJobType } from '@shared/types/repo-job.types';
import type { ExecutionLocation } from '@shared/types/worker-node.types';
import type { ChannelPlatform } from '@shared/types/channels';
import type { ActivityState } from '@shared/types/activity.types';

export type { IpcChannel };

/**
 * Message envelope for all IPC communication
 */
export interface IpcMessage<T = unknown> {
  id: string;
  channel: IpcChannel;
  timestamp: number;
  payload: T;
  replyChannel?: string;
}

// ============================================
// Orchestration Activity Payloads
// ============================================

export type OrchestrationActivityCategory = 'orchestration' | 'debate' | 'verification' | 'task';

export interface OrchestrationActivityPayload {
  instanceId: string;
  activity: string;
  category: OrchestrationActivityCategory;
  progress?: { current: number; total: number };
}

// ============================================
// Instance Management Payloads
// ============================================

export interface InstanceCreatePayload {
  workingDirectory: string;
  sessionId?: string;
  parentInstanceId?: string;
  displayName?: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
  agentId?: string; // Agent profile ID (defaults to 'build')
  provider?: InstanceProvider; // CLI provider (defaults to 'auto')
  model?: string; // Model override (e.g., for Copilot multi-model support)
}

export interface InstanceStateUpdatePayload {
  instanceId: string;
  status: InstanceStatus;
  activityState?: ActivityState;
  contextUsage?: ContextUsage;
  error?: ErrorInfo;
  diffStats?: SessionDiffStats | null;
  displayName?: string;
  /**
   * Resolved model identifier emitted from the main process after Phase 2 of
   * `createInstance` finishes resolving the model. The IPC response from
   * `INSTANCE_CREATE` returns at Phase 1 with `currentModel: undefined`,
   * so the renderer relies on this field to learn the resolved model.
   * Optional because most state updates don't change it.
   */
  currentModel?: string;
  executionLocation?: ExecutionLocation;
  providerSessionId?: string;
  restartEpoch?: number;
  adapterGeneration?: number;
  activeTurnId?: string;
  interruptRequestId?: string;
  interruptRequestedAt?: number;
  interruptPhase?: 'requested' | 'accepted' | 'completed' | 'timed-out' | 'escalated';
  lastTurnOutcome?: 'completed' | 'interrupted' | 'cancelled' | 'failed';
  supersededBy?: string;
  cancelledForEdit?: boolean;
  recoveryMethod?: InstanceRecoveryMethod;
  archivedUpToMessageId?: string;
  historyThreadId?: string;
}

export interface InstanceOutputPayload {
  instanceId: string;
  message: OutputMessage;
}

export interface BatchUpdatePayload {
  updates: InstanceStateUpdatePayload[];
  timestamp: number;
}

export interface InstanceSendInputPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
}

export interface InstanceTerminatePayload {
  instanceId: string;
  graceful?: boolean;
}

export interface InstanceInterruptPayload {
  instanceId: string;
}

export interface InstanceRestartPayload {
  instanceId: string;
}

export interface InstanceRestartFreshPayload {
  instanceId: string;
}

export interface InstanceRenamePayload {
  instanceId: string;
  displayName: string;
}

// ============================================
// Communication Payloads
// ============================================

export interface TokenRequestPayload {
  sourceInstanceId: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  ttlMs?: number;
}

export interface TokenResponsePayload {
  success: boolean;
  token?: string;
  error?: string;
}

export interface CrossInstanceMessagePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  message: string;
  asInput?: boolean;
}

export interface ControlInstancePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  command: 'restart' | 'terminate' | 'pause';
}

export interface SubscribePayload {
  subscriberId: string;
  targetId: string;
  token: string;
}

export interface CreateBridgePayload {
  sourceId: string;
  targetId: string;
  token: string;
}

// ============================================
// Supervisor Payloads
// ============================================

export interface SupervisorMetrics {
  totalNodes: number;
  totalInstances: number;
  nodeMetrics: SupervisorNodeMetrics[];
}

export interface SupervisorNodeMetrics {
  nodeId: string;
  name: string;
  childCount: number;
  maxChildren: number;
  load: number;
  childSupervisorCount: number;
}

// ============================================
// Error Types
// ============================================

export interface ErrorInfo {
  code: string;
  message: string;
  stack?: string;
  timestamp: number;
}

// ============================================
// Settings Payloads
// ============================================

export interface SettingsSetPayload {
  key: string;
  value: unknown;
}

export interface SettingsUpdatePayload {
  settings: Record<string, unknown>;
}

export interface SettingsResetOnePayload {
  key: string;
}

export interface SettingsChangedPayload {
  key: string;
  value: unknown;
}

// ============================================
// Memory Management Payloads
// ============================================

export interface MemoryStatsPayload {
  process: {
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rssMB: number;
    percentUsed: number;
  };
  storage: {
    totalInstances: number;
    totalMessages: number;
    totalSizeMB: number;
    maxSizeMB: number;
  };
  pressureLevel: 'normal' | 'warning' | 'critical';
}

export interface MemoryWarningPayload {
  heapUsedMB: number;
  heapTotalMB: number;
  message: string;
}

export interface LoadHistoryPayload {
  instanceId: string;
  limit?: number;
}

// ============================================
// History Payloads
// ============================================

export interface HistoryListPayload {
  limit?: number;
  searchQuery?: string;
  workingDirectory?: string;
}

export interface HistoryLoadPayload {
  entryId: string;
}

export interface HistoryDeletePayload {
  entryId: string;
}

export interface HistoryRestorePayload {
  entryId: string;
  workingDirectory?: string;
}

// ============================================
// Response Types
// ============================================

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorInfo;
}

// ============================================
// Provider Payloads
// ============================================

export interface ProviderStatusPayload {
  providerType: string;
  forceRefresh?: boolean;
}

export interface ProviderUpdateConfigPayload {
  providerType: string;
  config: Record<string, unknown>;
  ipcAuthToken?: string;
}

// ============================================
// Session Payloads
// ============================================

export interface SessionForkPayload {
  instanceId: string;
  atMessageIndex?: number; // Fork at specific message, defaults to latest
  atMessageId?: string;
  sourceMessageId?: string;
  forkAfterMessageId?: string;
  displayName?: string;
  initialPrompt?: string; // If set, sent to the new fork's CLI as its first user message
  attachments?: FileAttachment[];
  preserveRuntimeSettings?: boolean;
  supersedeSource?: boolean;
}

export interface SessionExportPayload {
  instanceId: string;
  format: 'json' | 'markdown';
  includeMetadata?: boolean;
}

export interface SessionImportPayload {
  filePath: string;
  workingDirectory?: string;
}

export interface SessionCopyToClipboardPayload {
  instanceId: string;
  format: 'json' | 'markdown';
}

export interface SessionSaveToFilePayload {
  instanceId: string;
  format: 'json' | 'markdown';
  filePath?: string; // If not provided, will show save dialog
}

export interface SessionRevealFilePayload {
  filePath: string;
}

// ============================================
// Command Payloads
// ============================================

export interface CommandExecutePayload {
  commandId: string;
  instanceId: string;
  args?: string[];
}

export interface CommandCreatePayload {
  name: string;
  description: string;
  template: string;
  hint?: string;
}

export interface CommandUpdatePayload {
  commandId: string;
  updates: Partial<CommandCreatePayload>;
}

export interface CommandDeletePayload {
  commandId: string;
}

// ============================================
// Config Payloads (Hierarchical Configuration)
// ============================================

export interface ConfigResolvePayload {
  workingDirectory?: string;
}

export interface ConfigGetProjectPayload {
  configPath: string;
}

export interface ConfigSaveProjectPayload {
  configPath: string;
  config: Record<string, unknown>;
}

export interface ConfigCreateProjectPayload {
  projectDir: string;
  config?: Record<string, unknown>;
}

export interface ConfigFindProjectPayload {
  startDir: string;
}

export interface InstructionsResolvePayload {
  workingDirectory: string;
  contextPaths?: string[];
}

export interface InstructionsCreateDraftPayload {
  workingDirectory: string;
  contextPaths?: string[];
}

// ============================================
// Plan Mode Payloads
// ============================================

export interface PlanModeEnterPayload {
  instanceId: string;
}

export interface PlanModeExitPayload {
  instanceId: string;
  force?: boolean; // Force exit without approval
}

export interface PlanModeApprovePayload {
  instanceId: string;
  planContent?: string;
}

export interface PlanModeUpdatePayload {
  instanceId: string;
  planContent: string;
}

export interface PlanModeGetStatePayload {
  instanceId: string;
}

// ============================================
// VCS Payloads (Git)
// ============================================

export interface VcsIsRepoPayload {
  workingDirectory: string;
}

export interface VcsGetStatusPayload {
  workingDirectory: string;
}

export interface VcsGetBranchesPayload {
  workingDirectory: string;
}

export interface VcsGetCommitsPayload {
  workingDirectory: string;
  limit?: number;
}

export interface VcsGetDiffPayload {
  workingDirectory: string;
  type: 'staged' | 'unstaged' | 'between';
  fromRef?: string; // For 'between' type
  toRef?: string; // For 'between' type
  filePath?: string; // For single file diff
}

export interface VcsGetFileHistoryPayload {
  workingDirectory: string;
  filePath: string;
  limit?: number;
}

export interface VcsGetFileAtCommitPayload {
  workingDirectory: string;
  filePath: string;
  commitHash: string;
}

export interface VcsGetBlamePayload {
  workingDirectory: string;
  filePath: string;
}

// ============================================
// Snapshot Payloads (File Revert)
// ============================================

export interface SnapshotTakePayload {
  filePath: string;
  instanceId: string;
  sessionId?: string;
  action?: 'create' | 'modify' | 'delete';
}

export interface SnapshotStartSessionPayload {
  instanceId: string;
  description?: string;
}

export interface SnapshotEndSessionPayload {
  sessionId: string;
}

export interface SnapshotGetForInstancePayload {
  instanceId: string;
}

export interface SnapshotGetForFilePayload {
  filePath: string;
}

export interface SnapshotGetSessionsPayload {
  instanceId: string;
}

export interface SnapshotGetContentPayload {
  snapshotId: string;
}

export interface SnapshotRevertFilePayload {
  snapshotId: string;
}

export interface SnapshotRevertSessionPayload {
  sessionId: string;
}

export interface SnapshotGetDiffPayload {
  snapshotId: string;
}

export interface SnapshotDeletePayload {
  snapshotId: string;
}

export interface SnapshotCleanupPayload {
  maxAgeDays?: number;
}

// ============================================
// TODO Payloads
// ============================================

export interface TodoGetListPayload {
  sessionId: string;
}

export interface TodoCreatePayload {
  sessionId: string;
  content: string;
  activeForm?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  parentId?: string;
}

export interface TodoUpdatePayload {
  sessionId: string;
  todoId: string;
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface TodoDeletePayload {
  sessionId: string;
  todoId: string;
}

export interface TodoWriteAllPayload {
  sessionId: string;
  todos: {
    content: string;
    status: string;
    activeForm?: string;
  }[];
}

export interface TodoClearPayload {
  sessionId: string;
}

export interface TodoGetCurrentPayload {
  sessionId: string;
}

// ============================================
// MCP Payloads
// ============================================

export interface McpServerPayload {
  serverId: string;
}

export interface McpAddServerPayload {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect?: boolean;
}

export interface McpCallToolPayload {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface McpReadResourcePayload {
  serverId: string;
  uri: string;
}

export interface McpGetPromptPayload {
  serverId: string;
  promptName: string;
  arguments?: Record<string, string>;
}

export interface McpStateChangedPayload {
  type: 'server' | 'tools' | 'resources' | 'prompts';
  serverId?: string;
}

export interface McpServerStatusChangedPayload {
  serverId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

// ============================================
// LSP Payloads
// ============================================

export interface LspPositionPayload {
  filePath: string;
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspFindReferencesPayload extends LspPositionPayload {
  includeDeclaration?: boolean;
}

export interface LspFilePayload {
  filePath: string;
}

export interface LspWorkspaceSymbolPayload {
  query: string;
  rootPath: string;
}

// ============================================
// Multi-Edit Payloads
// ============================================

export interface MultiEditOperation {
  filePath: string; // Absolute path to the file
  oldString: string; // Text to find and replace
  newString: string; // Replacement text
  replaceAll?: boolean; // Replace all occurrences (default: false)
}

export interface MultiEditPayload {
  edits: MultiEditOperation[];
  instanceId?: string;
  takeSnapshots?: boolean;
}

// ============================================
// Task Management Payloads (Subagent Spawning)
// ============================================

export interface TaskGetStatusPayload {
  taskId: string;
}

export interface TaskGetHistoryPayload {
  parentId?: string; // If provided, get history for this parent only
  limit?: number;
}

export interface TaskGetByParentPayload {
  parentId: string;
}

export interface TaskGetByChildPayload {
  childId: string;
}

export interface TaskCancelPayload {
  taskId: string;
}

export interface TaskGetPreflightPayload {
  workingDirectory: string;
  surface: 'repo-job' | 'workflow' | 'worktree' | 'verification';
  taskType?: string;
  requiresWrite?: boolean;
  requiresNetwork?: boolean;
  requiresBrowser?: boolean;
}

export interface RepoJobSubmitPayload {
  type: RepoJobType;
  workingDirectory: string;
  issueOrPrUrl?: string;
  title?: string;
  description?: string;
  baseBranch?: string;
  branchRef?: string;
  workflowTemplateId?: string;
  useWorktree?: boolean;
}

export interface RepoJobListPayload {
  status?: RepoJobStatus;
  type?: RepoJobType;
  limit?: number;
}

export interface RepoJobGetPayload {
  jobId: string;
}

export interface RepoJobCancelPayload {
  jobId: string;
}

export interface RepoJobRerunPayload {
  jobId: string;
}

// ============================================
// Security Payloads (Secret Detection & Environment Filtering)
// ============================================

export interface SecurityDetectSecretsPayload {
  content: string;
  contentType?: 'env' | 'text' | 'auto'; // auto = detect based on content
}

export interface SecurityRedactContentPayload {
  content: string;
  contentType?: 'env' | 'text' | 'auto';
  options?: {
    maskChar?: string;
    showStart?: number;
    showEnd?: number;
    fullMask?: boolean;
    label?: string;
  };
}

export interface SecurityCheckFilePayload {
  filePath: string;
}

export interface SecurityGetAuditLogPayload {
  instanceId?: string; // If provided, filter by instance
  limit?: number;
}

export interface SecurityCheckEnvVarPayload {
  name: string;
  value: string;
}

export interface SecurityUpdateEnvFilterConfigPayload {
  blocklist?: string[];
  allowlist?: string[];
  blockPatterns?: string[]; // Regex patterns as strings
  allowPatterns?: string[]; // Regex patterns as strings
  blockAllSecrets?: boolean;
}

export interface SecuritySetPermissionPresetPayload {
  preset: 'allow' | 'ask' | 'deny';
}

// ============================================
// Cost Tracking Payloads (5.3)
// ============================================

export interface CostRecordUsagePayload {
  instanceId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  ipcAuthToken?: string;
}

export interface CostGetSummaryPayload {
  startTime?: number;
  endTime?: number;
  ipcAuthToken?: string;
}

export interface CostGetSessionCostPayload {
  sessionId: string;
  ipcAuthToken?: string;
}

export interface CostSetBudgetPayload {
  enabled?: boolean;
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  perSessionLimit?: number;
  alertThresholds?: number[];
  ipcAuthToken?: string;
}

export interface CostGetBudgetPayload {
  ipcAuthToken?: string;
}

export interface CostGetBudgetStatusPayload {
  ipcAuthToken?: string;
}

export interface CostGetEntriesPayload {
  limit?: number;
  ipcAuthToken?: string;
}

export interface CostClearEntriesPayload {
  ipcAuthToken?: string;
}

// ============================================
// Session Archiving Payloads (1.3)
// ============================================

export interface ArchiveSessionPayload {
  instanceId: string;
  tags?: string[];
}

export interface ArchiveRestorePayload {
  sessionId: string;
}

export interface ArchiveDeletePayload {
  sessionId: string;
}

export interface ArchiveListPayload {
  beforeDate?: number;
  afterDate?: number;
  tags?: string[];
  searchTerm?: string;
}

export interface ArchiveGetMetaPayload {
  sessionId: string;
}

export interface ArchiveUpdateTagsPayload {
  sessionId: string;
  tags: string[];
}

export interface ArchiveCleanupPayload {
  maxAgeDays: number;
}

// ============================================
// Remote Configuration Payloads (6.2)
// ============================================

export interface RemoteConfigFetchUrlPayload {
  url: string;
  timeout?: number;
  cacheTTL?: number;
  maxRetries?: number;
  useCache?: boolean;
}

export interface RemoteConfigFetchWellKnownPayload {
  domain: string;
  timeout?: number;
  cacheTTL?: number;
}

export interface RemoteConfigFetchGitHubPayload {
  owner: string;
  repo: string;
  branch?: string;
}

export interface RemoteConfigDiscoverGitPayload {
  gitRemoteUrl: string;
}

export interface RemoteConfigInvalidatePayload {
  url: string;
}

export interface RemoteObserverStartPayload {
  host?: string;
  port?: number;
}

// ============================================
// External Editor Payloads (9.2)
// ============================================

export interface EditorOpenFilePayload {
  filePath: string;
  line?: number;
  column?: number;
  waitForClose?: boolean;
  newWindow?: boolean;
}

export interface EditorOpenFileAtLinePayload {
  filePath: string;
  line: number;
  column?: number;
}

export interface EditorOpenDirectoryPayload {
  dirPath: string;
}

export interface EditorSetPreferredPayload {
  type: string;
  path?: string;
  args?: string[];
}

// ============================================
// File Watcher Payloads (10.1)
// ============================================

export interface WatcherStartPayload {
  directory: string;
  ignored?: string[];
  useGitignore?: boolean;
  depth?: number;
  ignoreInitial?: boolean;
  debounceMs?: number;
}

export interface WatcherStopPayload {
  sessionId: string;
}

export interface WatcherGetChangesPayload {
  sessionId: string;
  limit?: number;
}

export interface WatcherClearBufferPayload {
  sessionId: string;
}

// ============================================
// File Explorer Payloads
// ============================================

export interface FileReadDirPayload {
  path: string;
  includeHidden?: boolean;
}

export interface FileReadDirResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  extension?: string;
}

export interface FileGetStatsPayload {
  path: string;
}

export interface FileReadTextPayload {
  path: string;
  /** Safety limit to prevent the renderer from loading huge files (default applied in main). */
  maxBytes?: number;
}

export interface FileReadTextResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

export interface FileWriteTextPayload {
  path: string;
  content: string;
  createDirs?: boolean;
}

export interface FileWriteTextResult {
  path: string;
  bytesWritten: number;
}

// ============================================
// Structured Logging Payloads (13.1)
// ============================================

export interface LogGetRecentPayload {
  limit?: number;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  subsystem?: string;
  startTime?: number;
  endTime?: number;
}

export interface LogSetLevelPayload {
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export interface LogSetSubsystemLevelPayload {
  subsystem: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export interface LogExportPayload {
  filePath: string;
  startTime?: number;
  endTime?: number;
}

// ============================================
// Debug Commands Payloads (13.2)
// ============================================

export interface DebugAgentPayload {
  agentId?: string;
}

export interface DebugConfigPayload {
  workingDirectory?: string;
}

export interface DebugFilePayload {
  filePath: string;
}

export interface DebugAllPayload {
  workingDirectory?: string;
}

// ============================================
// Usage Statistics Payloads (14.1)
// ============================================

export interface StatsGetPayload {
  period: 'day' | 'week' | 'month' | 'year' | 'all';
}

export interface StatsGetSessionPayload {
  sessionId: string;
}

export interface StatsRecordSessionStartPayload {
  sessionId: string;
  instanceId: string;
  agentId: string;
  workingDirectory: string;
}

export interface StatsRecordSessionEndPayload {
  sessionId: string;
}

export interface StatsRecordMessagePayload {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface StatsRecordToolUsagePayload {
  sessionId: string;
  tool: string;
}

export interface StatsExportPayload {
  filePath: string;
  period?: 'day' | 'week' | 'month' | 'year' | 'all';
}

// ============================================
// Context Compaction Payloads
// ============================================

export interface InstanceCompactPayload {
  instanceId: string;
}

export interface InstanceCompactResultPayload {
  instanceId: string;
  success: boolean;
  method: 'native' | 'restart-with-summary';
  previousUsage?: ContextUsage;
  newUsage?: ContextUsage;
  summary?: string;
  error?: string;
}

export interface ContextWarningPayload {
  instanceId: string;
  percentage: number;
  level: 'warning' | 'critical' | 'emergency';
}

// ============================================
// Semantic Search Payloads (4.7)
// ============================================

export interface SearchSemanticPayload {
  query: string;
  directory: string;
  maxResults?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  searchType?: 'semantic' | 'hybrid' | 'keyword';
  minScore?: number;
}

export interface SearchBuildIndexPayload {
  directory: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface SearchConfigureExaPayload {
  apiKey: string;
  baseUrl?: string;
}

// ============================================
// Provider Plugins Payloads (12.2)
// ============================================

export interface PluginsLoadPayload {
  idOrPath: string;
  timeout?: number;
  sandbox?: boolean;
}

export interface PluginsUnloadPayload {
  pluginId: string;
}

export interface PluginsGetPayload {
  pluginId: string;
}

export interface PluginsGetMetaPayload {
  pluginId: string;
}

export interface PluginsInstallPayload {
  sourcePath: string;
}

export interface PluginsUninstallPayload {
  pluginId: string;
}

export interface PluginsCreateTemplatePayload {
  name: string;
}

// ============================================
// Workflow Payloads (6.1)
// ============================================

export interface WorkflowGetTemplatePayload {
  templateId: string;
}

export interface WorkflowStartPayload {
  instanceId: string;
  templateId: string;
}

export interface WorkflowGetExecutionPayload {
  executionId: string;
}

export interface WorkflowGetByInstancePayload {
  instanceId: string;
}

export interface WorkflowCompletePhasePayload {
  executionId: string;
  phaseData?: Record<string, unknown>;
}

export interface WorkflowSatisfyGatePayload {
  executionId: string;
  response: {
    approved?: boolean;
    selection?: string;
    answer?: string;
  };
}

export interface WorkflowSkipPhasePayload {
  executionId: string;
}

export interface WorkflowCancelPayload {
  executionId: string;
}

export interface WorkflowGetPromptAdditionPayload {
  executionId: string;
}

// ============================================
// Review Agent Payloads (6.2)
// ============================================

export interface ReviewGetAgentPayload {
  agentId: string;
}

export interface ReviewStartSessionPayload {
  instanceId: string;
  agentIds: string[];
  files: string[];
  diffOnly?: boolean;
}

export interface ReviewGetSessionPayload {
  sessionId: string;
}

export interface ReviewGetIssuesPayload {
  sessionId: string;
  severity?: string;
  agentId?: string;
}

export interface ReviewAcknowledgeIssuePayload {
  sessionId: string;
  issueId: string;
  acknowledged: boolean;
}

// ============================================
// Ecosystem Payloads (Commands/Agents/Tools/Plugins)
// ============================================

export interface EcosystemListPayload {
  workingDirectory: string;
}

export interface EcosystemWatchStartPayload {
  workingDirectory: string;
}

export interface EcosystemWatchStopPayload {
  workingDirectory: string;
}

// ============================================
// Hook Payloads (6.3)
// ============================================

export interface HooksListPayload {
  event?: string;
  source?: 'built-in' | 'project' | 'user';
}

export interface HooksGetPayload {
  ruleId: string;
}

export interface HooksCreatePayload {
  rule: {
    name: string;
    enabled: boolean;
    event: string;
    toolMatcher?: string;
    conditions: {
      field: string;
      operator: string;
      pattern: string;
    }[];
    action: 'warn' | 'block';
    message: string;
  };
}

export interface HooksUpdatePayload {
  ruleId: string;
  updates: {
    name?: string;
    enabled?: boolean;
    conditions?: {
      field: string;
      operator: string;
      pattern: string;
    }[];
    action?: 'warn' | 'block';
    message?: string;
  };
}

export interface HooksDeletePayload {
  ruleId: string;
}

export interface HooksEvaluatePayload {
  context: {
    event: string;
    sessionId: string;
    instanceId: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    filePath?: string;
    newContent?: string;
    command?: string;
    userPrompt?: string;
  };
}

export interface HooksImportPayload {
  rules: {
    id: string;
    name: string;
    enabled: boolean;
    event: string;
    toolMatcher?: string;
    conditions: {
      field: string;
      operator: string;
      pattern: string;
    }[];
    action: 'warn' | 'block';
    message: string;
    source: 'built-in' | 'project' | 'user';
    createdAt: number;
  }[];
  overwrite?: boolean;
}

export interface HooksExportPayload {
  source?: 'built-in' | 'project' | 'user';
}

export interface HookApprovalsListPayload {
  pendingOnly?: boolean;
}

export interface HookApprovalsUpdatePayload {
  hookId: string;
  approved: boolean;
}

export interface HookApprovalsClearPayload {
  hookIds?: string[];
}

// ============================================
// Skill Payloads (6.4)
// ============================================

export interface SkillsDiscoverPayload {
  searchPaths: string[];
}

export interface SkillsGetPayload {
  skillId: string;
}

export interface SkillsLoadPayload {
  skillId: string;
}

export interface SkillsUnloadPayload {
  skillId: string;
}

export interface SkillsLoadReferencePayload {
  skillId: string;
  referencePath: string;
}

export interface SkillsLoadExamplePayload {
  skillId: string;
  examplePath: string;
}

export interface SkillsMatchPayload {
  text: string;
}

// ============================================
// Git Worktree Payloads (7.1)
// ============================================

export interface WorktreeCreatePayload {
  instanceId: string;
  basePath: string;
  taskDescription: string;
  baseBranch?: string;
  config?: {
    prefix?: string;
    cleanupOnComplete?: boolean;
    syncIntervalMs?: number;
    conflictStrategy?: 'merge' | 'rebase' | 'manual';
    trackRemote?: boolean;
  };
}

export interface WorktreeCompletePayload {
  sessionId: string;
}

export interface WorktreePreviewMergePayload {
  sessionId: string;
}

export interface WorktreeMergePayload {
  sessionId: string;
  strategy?: 'merge' | 'squash' | 'rebase';
  commitMessage?: string;
}

export interface WorktreeCleanupPayload {
  sessionId: string;
}

export interface WorktreeAbandonPayload {
  sessionId: string;
  reason?: string;
}

export interface WorktreeGetSessionPayload {
  sessionId: string;
}

export interface WorktreeDetectConflictsPayload {
  sessionIds: string[];
}

export interface WorktreeSyncPayload {
  sessionId: string;
}

// ============================================
// Multi-Agent Verification Payloads (7.2)
// ============================================

export interface VerifyStartPayload {
  instanceId: string;
  prompt: string;
  context?: string;
  taskType?: string;
  config?: {
    minAgents?: number;
    synthesisStrategy?:
      | 'consensus'
      | 'best-of'
      | 'merge'
      | 'majority-vote'
      | 'debate'
      | 'hierarchical';
    personalities?: string[];
    confidenceThreshold?: number;
    timeoutMs?: number;
    maxDebateRounds?: number;
  };
}

export interface VerifyGetResultPayload {
  verificationId: string;
}

export interface VerifyGetActivePayload {
  instanceId?: string;
}

export interface VerifyCancelPayload {
  verificationId: string;
}

export interface VerifyConfigurePayload {
  config: {
    minAgents?: number;
    synthesisStrategy?:
      | 'consensus'
      | 'best-of'
      | 'merge'
      | 'majority-vote'
      | 'debate'
      | 'hierarchical';
    confidenceThreshold?: number;
    timeoutMs?: number;
    enableByDefault?: boolean;
  };
}

// ============================================
// Cascade Supervision Payloads (7.3)
// ============================================

export interface SupervisionCreateTreePayload {
  instanceId: string;
  config?: {
    strategy?: 'one-for-one' | 'one-for-all' | 'rest-for-one' | 'simple-one';
    maxRestarts?: number;
    maxTime?: number;
    onExhausted?: 'restart' | 'escalate' | 'ignore' | 'stop';
    backoff?: {
      minDelayMs?: number;
      maxDelayMs?: number;
      factor?: number;
      jitter?: boolean;
    };
    healthCheck?: {
      intervalMs?: number;
      timeoutMs?: number;
      unhealthyThreshold?: number;
    };
  };
}

export interface SupervisionAddWorkerPayload {
  instanceId: string;
  spec: {
    id: string;
    name: string;
    restartType: 'permanent' | 'transient' | 'temporary';
    startFuncId: string;
    stopFuncId?: string;
    dependencies?: string[];
    order?: number;
  };
  parentId?: string;
}

export interface SupervisionStartWorkerPayload {
  instanceId: string;
  workerId: string;
}

export interface SupervisionStopWorkerPayload {
  instanceId: string;
  workerId: string;
}

export interface SupervisionHandleFailurePayload {
  instanceId: string;
  childInstanceId: string;
  error: string;
}

export interface SupervisionGetTreePayload {
  instanceId: string;
}

export interface SupervisionGetHealthPayload {
  instanceId: string;
}

// ============================================
// Specialist Payloads (7.4)
// ============================================

export interface SpecialistGetPayload {
  profileId: string;
}

export interface SpecialistGetByCategoryPayload {
  category: string;
}

export interface SpecialistAddCustomPayload {
  profile: {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    color: string;
    systemPromptAddition: string;
    restrictedTools: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  };
}

export interface SpecialistUpdateCustomPayload {
  profileId: string;
  updates: {
    name?: string;
    description?: string;
    category?: string;
    icon?: string;
    color?: string;
    systemPromptAddition?: string;
    restrictedTools?: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  };
}

export interface SpecialistRemoveCustomPayload {
  profileId: string;
}

export interface SpecialistRecommendPayload {
  context: {
    taskDescription?: string;
    fileTypes?: string[];
    userPreferences?: string[];
  };
}

export interface SpecialistCreateInstancePayload {
  profileId: string;
  orchestratorInstanceId: string;
}

export interface SpecialistGetInstancePayload {
  instanceId: string;
}

export interface SpecialistUpdateStatusPayload {
  instanceId: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
}

export interface SpecialistAddFindingPayload {
  instanceId: string;
  finding: {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    filePath?: string;
    lineRange?: {
      start: number;
      end: number;
    };
    codeSnippet?: string;
    suggestion?: string;
    confidence: number;
    tags?: string[];
  };
}

export interface SpecialistUpdateMetricsPayload {
  instanceId: string;
  updates: {
    filesAnalyzed?: number;
    linesAnalyzed?: number;
    findingsCount?: number;
    tokensUsed?: number;
    durationMs?: number;
  };
}

export interface SpecialistGetPromptAdditionPayload {
  profileId: string;
}

// ============================================
// LLM Service Payloads
// ============================================

export interface LLMSummarizePayload {
  requestId: string;
  content: string;
  targetTokens: number;
  preserveKeyPoints?: boolean;
}

export interface LLMSubQueryPayload {
  requestId: string;
  prompt: string;
  context: string;
  depth: number;
}

export interface LLMCancelStreamPayload {
  requestId: string;
}

export interface LLMCountTokensPayload {
  text: string;
  model?: string;
}

export interface LLMTruncateTokensPayload {
  text: string;
  maxTokens: number;
  model?: string;
}

export interface LLMSetConfigPayload {
  provider?: 'anthropic' | 'ollama' | 'openai' | 'local';
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaHost?: string;
}

export interface LLMStreamChunkPayload {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string;
}

// ============================================
// Recent Directories Payloads
// ============================================

export interface RecentDirsGetPayload {
  limit?: number;
  sortBy?: 'lastAccessed' | 'frequency' | 'alphabetical';
  includePinned?: boolean;
}

export interface RecentDirsAddPayload {
  path: string;
}

export interface RecentDirsRemovePayload {
  path: string;
}

export interface RecentDirsPinPayload {
  path: string;
  pinned: boolean;
}

export interface RecentDirsClearPayload {
  keepPinned?: boolean;
}

// ============ Channel Payloads ============

export interface ChannelConnectPayload {
  platform: ChannelPlatform;
  token?: string;
}

export interface ChannelDisconnectPayload {
  platform: ChannelPlatform;
}

export interface ChannelGetMessagesPayload {
  platform: ChannelPlatform;
  chatId: string;
  limit?: number;
  before?: number;
}

export interface ChannelSendMessagePayload {
  platform: ChannelPlatform;
  chatId: string;
  content: string;
  replyTo?: string;
}

export interface ChannelPairSenderPayload {
  platform: ChannelPlatform;
  code: string;
}

export interface ChannelSetAccessPolicyPayload {
  platform: ChannelPlatform;
  mode: 'pairing' | 'allowlist' | 'disabled';
}

export interface ChannelGetAccessPolicyPayload {
  platform: ChannelPlatform;
}
