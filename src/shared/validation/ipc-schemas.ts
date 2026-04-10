/**
 * IPC Payload Validation Schemas
 *
 * @deprecated Import from '@contracts/schemas' instead.
 * This file re-exports from @contracts for backward compatibility
 * during the Phase 1 migration.
 */

// Re-export from contracts (new source of truth for migrated schemas)
export {
  InstanceIdSchema,
  SessionIdSchema,
  DisplayNameSchema,
  WorkingDirectorySchema,
  FilePathSchema,
  DirectoryPathSchema,
  SnapshotIdSchema,
  StoreIdSchema,
  FileAttachmentSchema,
  validateIpcPayload,
  safeValidateIpcPayload,
  RemoteNodeSetTokenPayloadSchema,
  RemoteNodeRevokePayloadSchema,
} from '@contracts/schemas';

export type { ValidatedSetTokenPayload, ValidatedRevokePayload } from '@contracts/schemas';

import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  DisplayNameSchema,
  WorkingDirectorySchema,
  FilePathSchema,
  DirectoryPathSchema,
  SnapshotIdSchema,
  StoreIdSchema,
  FileAttachmentSchema,
} from '@contracts/schemas';

// ============ Instance Creation ============

export const InstanceCreatePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  sessionId: SessionIdSchema.optional(),
  parentInstanceId: InstanceIdSchema.optional(),
  displayName: DisplayNameSchema.optional(),
  initialPrompt: z.string().max(500000).optional(),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  yoloMode: z.boolean().optional(),
  agentId: z.string().max(100).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot']).optional(),
  model: z.string().max(100).optional(),
  forceNodeId: z.string().uuid().optional(),
});

export type ValidatedInstanceCreatePayload = z.infer<typeof InstanceCreatePayloadSchema>;

export const InstanceCreateWithMessagePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  message: z.string().min(0).max(500000),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot']).optional(),
  model: z.string().max(100).optional(),
  forceNodeId: z.string().uuid().optional(),
});

// ============ Instance Input ============

export const InstanceSendInputPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  message: z.string().max(500000),
  attachments: z.array(z.object({
    name: z.string().max(500),
    type: z.string().max(100),
    size: z.number().int().min(0).max(50 * 1024 * 1024),
    data: z.string().optional(),
  })).max(10).optional(),
  isRetry: z.boolean().optional(),
}).refine(
  (data) => data.message.trim().length > 0 || (data.attachments && data.attachments.length > 0),
  { message: 'Either message must be non-empty or attachments must be provided' }
);

export type InstanceSendInputPayload = z.infer<typeof InstanceSendInputPayloadSchema>;

// ============ Output History ============

export const InstanceLoadOlderMessagesPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  beforeChunk: z.number().int().min(0).optional(), // Load chunks before this index
  limit: z.number().int().min(1).max(500).optional().default(200),
});

export type InstanceLoadOlderMessagesPayload = z.infer<typeof InstanceLoadOlderMessagesPayloadSchema>;

// ============ Instance Operations ============

export const InstanceTerminatePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  graceful: z.boolean().optional().default(true),
});

export type InstanceTerminatePayload = z.infer<typeof InstanceTerminatePayloadSchema>;

export const InstanceRenamePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  displayName: DisplayNameSchema,
});

export type InstanceRenamePayload = z.infer<typeof InstanceRenamePayloadSchema>;

export const InstanceChangeAgentPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  agentId: z.string().min(1).max(100),
});

export type InstanceChangeAgentPayload = z.infer<typeof InstanceChangeAgentPayloadSchema>;

export const InstanceChangeModelPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  model: z.string().min(1).max(100),
});

export type InstanceChangeModelPayload = z.infer<typeof InstanceChangeModelPayloadSchema>;

// ============ Input Required Response ============

export const InputRequiredResponsePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  requestId: z.string().min(1).max(100),
  response: z.string().min(1).max(10000),
  permissionKey: z.string().max(200).optional(),
  decisionAction: z.enum(['allow', 'deny']).optional(),
  decisionScope: z.enum(['once', 'session', 'always']).optional(),
  /** Optional metadata for routing — e.g. type: 'deferred_permission' for defer flow. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type InputRequiredResponsePayload = z.infer<typeof InputRequiredResponsePayloadSchema>;

// ============ Settings ============

export const SettingsGetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

export const SettingsUpdatePayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(), // Settings can be various types
});

export const SettingsBulkUpdatePayloadSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
}).passthrough(); // Allow direct settings as well

export const SettingsResetOnePayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

export type SettingsUpdatePayload = z.infer<typeof SettingsUpdatePayloadSchema>;

// ============ Config ============

const ConfigPathSchema = z.string().min(1).max(2000);

export const ConfigResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const ConfigGetProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
});

export const ConfigSaveProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
  config: z.record(z.string(), z.unknown()), // ProjectConfig is complex, validate structure
});

export const ConfigCreateProjectPayloadSchema = z.object({
  projectDir: WorkingDirectorySchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigFindProjectPayloadSchema = z.object({
  startDir: WorkingDirectorySchema,
});

export const InstructionsResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

export const InstructionsCreateDraftPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

// ============ Remote Config ============

const UrlSchema = z.string().url().max(2000);
const DomainSchema = z.string().min(1).max(255);
const GitHubOwnerSchema = z.string().min(1).max(100);
const GitHubRepoSchema = z.string().min(1).max(100);

export const RemoteConfigFetchUrlPayloadSchema = z.object({
  url: UrlSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  useCache: z.boolean().optional(),
});

export const RemoteConfigFetchWellKnownPayloadSchema = z.object({
  domain: DomainSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
});

export const RemoteConfigFetchGitHubPayloadSchema = z.object({
  owner: GitHubOwnerSchema,
  repo: GitHubRepoSchema,
  branch: z.string().max(100).optional(),
});

export const RemoteConfigDiscoverGitPayloadSchema = z.object({
  gitRemoteUrl: UrlSchema,
});

export const RemoteConfigInvalidatePayloadSchema = z.object({
  url: UrlSchema,
});

export const RemoteObserverStartPayloadSchema = z.object({
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

// ============ User Action Response ============

export const UserActionResponsePayloadSchema = z.object({
  requestId: z.string().min(1).max(100),
  action: z.enum(['approve', 'reject', 'custom']),
  customValue: z.string().max(10000).optional(),
});

export type UserActionResponsePayload = z.infer<typeof UserActionResponsePayloadSchema>;

// Raw payload from renderer for USER_ACTION_RESPOND (uses approved boolean, not action enum)
export const UserActionRespondRawPayloadSchema = z.object({
  requestId: z.string().min(1).max(100),
  approved: z.boolean(),
  selectedOption: z.string().max(10000).optional(),
});

// ============ Orchestration Commands ============

export const SpawnChildPayloadSchema = z.object({
  parentInstanceId: InstanceIdSchema,
  task: z.string().min(1).max(100000),
  name: z.string().max(200).optional(),
  agentId: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot']).optional(),
});

export type SpawnChildPayload = z.infer<typeof SpawnChildPayloadSchema>;

export const MessageChildPayloadSchema = z.object({
  parentInstanceId: InstanceIdSchema,
  childId: InstanceIdSchema,
  message: z.string().min(1).max(100000),
});

export type MessageChildPayload = z.infer<typeof MessageChildPayloadSchema>;

// ============ Commands ============

const CommandIdSchema = z.string().min(1).max(100);

export const CommandExecutePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  commandId: CommandIdSchema,
  args: z.array(z.string().max(10000)).max(50).optional(),
});

export const CommandCreatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  template: z.string().min(1).max(100000),
  hint: z.string().max(500).optional(),
  shortcut: z.string().max(50).optional(),
});

export const CommandUpdatePayloadSchema = z.object({
  commandId: CommandIdSchema,
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(1000).optional(),
    template: z.string().min(1).max(100000).optional(),
    hint: z.string().max(500).optional(),
    shortcut: z.string().max(50).optional(),
  }),
});

export const CommandDeletePayloadSchema = z.object({
  commandId: CommandIdSchema,
});

// ============ Plan Mode ============

export const PlanModeEnterPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const PlanModeExitPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  force: z.boolean().optional(),
});

export const PlanModeApprovePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  planContent: z.string().max(500000),
});

export const PlanModeUpdatePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  planContent: z.string().max(500000),
});

export const PlanModeGetStatePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

// ============ Memory & Debate ============

const TaskIdSchema = z.string().min(1).max(200);
const DebateIdSchema = z.string().min(1).max(200);
const ScoreSchema = z.number().finite().min(-1).max(1);

const MemoryTypeSchema = z.enum([
  'short_term',
  'long_term',
  'episodic',
  'semantic',
  'procedural',
  'skills',
]);

const SessionOutcomeSchema = z.enum(['success', 'partial', 'failure']);
const MemoryOperationSchema = z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']);
const MemorySourceTypeSchema = z.enum([
  'user_input',
  'agent_output',
  'tool_result',
  'derived',
]);

const MemoryManagerConfigSchema = z.object({
  maxEntries: z.number().int().min(1).max(1_000_000).optional(),
  maxTokens: z.number().int().min(100).max(10_000_000).optional(),
  topK: z.number().int().min(1).max(200).optional(),
  similarityThreshold: z.number().min(0).max(1).optional(),
  enableLearning: z.boolean().optional(),
  learningRate: z.number().positive().max(1).optional(),
  rewardDiscount: z.number().min(0).max(1).optional(),
  batchSize: z.number().int().min(1).max(4096).optional(),
  embeddingModel: z.string().min(1).max(200).optional(),
  embeddingDimension: z.number().int().min(32).max(8192).optional(),
});

const MemoryManagerDecisionSchema = z.object({
  operation: MemoryOperationSchema,
  entryId: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(1_000_000).optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(10_000),
});

const MemoryEntrySchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(1_000_000),
  embedding: z.array(z.number().finite()).min(1).max(8192).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  accessCount: z.number().int().nonnegative(),
  lastAccessedAt: z.number().int().nonnegative(),
  sourceType: MemorySourceTypeSchema,
  sourceSessionId: z.string().max(200),
  sourceMessageId: z.string().max(200).optional(),
  relevanceScore: z.number().min(0).max(1),
  confidenceScore: z.number().min(0).max(1),
  linkedEntries: z.array(z.string().min(1).max(200)).max(200),
  tags: z.array(z.string().max(200)).max(200),
  expiresAt: z.number().int().nonnegative().optional(),
  isArchived: z.boolean(),
});

const MemoryOperationLogSchema = z.object({
  id: z.string().min(1).max(200),
  operation: MemoryOperationSchema,
  entryId: z.string().max(200),
  reason: z.string().max(10_000),
  timestamp: z.number().int().nonnegative(),
  taskId: TaskIdSchema,
  outcomeScore: ScoreSchema.optional(),
});

const RetrievalLogSchema = z.object({
  id: z.string().min(1).max(200),
  query: z.string().max(1_000_000),
  retrievedIds: z.array(z.string().min(1).max(200)).max(5000),
  selectedIds: z.array(z.string().min(1).max(200)).max(5000),
  timestamp: z.number().int().nonnegative(),
  taskId: TaskIdSchema,
  retrievalQuality: ScoreSchema.optional(),
});

export const MemoryR1DecideOperationPayloadSchema = z.object({
  context: z.string().max(1_000_000),
  candidateContent: z.string().min(1).max(1_000_000),
  taskId: TaskIdSchema,
});

export const MemoryR1ExecuteOperationPayloadSchema = MemoryManagerDecisionSchema;

export const MemoryR1AddEntryPayloadSchema = z.object({
  content: z.string().min(1).max(1_000_000),
  reason: z.string().min(1).max(10_000),
  sourceType: MemorySourceTypeSchema.optional(),
  sourceSessionId: SessionIdSchema.optional(),
});

export const MemoryR1DeleteEntryPayloadSchema = z.string().min(1).max(200);
export const MemoryR1GetEntryPayloadSchema = z.string().min(1).max(200);

export const MemoryR1RetrievePayloadSchema = z.object({
  query: z.string().min(1).max(1_000_000),
  taskId: TaskIdSchema,
});

export const MemoryR1RecordOutcomePayloadSchema = z.object({
  taskId: TaskIdSchema,
  success: z.boolean(),
  score: ScoreSchema,
});

export const MemoryR1LoadPayloadSchema = z.object({
  version: z.string().min(1).max(20),
  timestamp: z.number().int().nonnegative(),
  entries: z.array(z.tuple([z.string().min(1).max(200), MemoryEntrySchema])).max(100_000),
  operationHistory: z.array(MemoryOperationLogSchema).max(100_000),
  retrievalHistory: z.array(RetrievalLogSchema).max(100_000),
});

export const MemoryR1ConfigurePayloadSchema = MemoryManagerConfigSchema;

const ContextBudgetSplitSchema = z.object({
  shortTerm: z.number().min(0).max(1),
  longTerm: z.number().min(0).max(1),
  procedural: z.number().min(0).max(1),
}).superRefine((split, ctx) => {
  const total = split.shortTerm + split.longTerm + split.procedural;
  if (total <= 0 || total > 1.01) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'contextBudgetSplit values must have a total in the range (0, 1]',
    });
  }
});

const UnifiedMemoryConfigSchema = z.object({
  shortTermMaxTokens: z.number().int().min(100).max(1_000_000).optional(),
  shortTermSummarizeAt: z.number().int().min(50).max(1_000_000).optional(),
  longTermMaxEntries: z.number().int().min(1).max(1_000_000).optional(),
  longTermPersistPath: z.string().max(4000).optional(),
  retrievalBlend: z.number().min(0).max(1).optional(),
  contextBudgetSplit: ContextBudgetSplitSchema.optional(),
  qualityCostProfile: z.enum(['quality', 'balanced', 'cost']).optional(),
  diversityThreshold: z.number().min(0).max(1).optional(),
  rlmMaxResults: z.number().int().min(1).max(100).optional(),
  semanticCacheMaxEntries: z.number().int().min(0).max(10_000).optional(),
  semanticCacheTtlMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
  trainingStage: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enableGRPO: z.boolean().optional(),
});

export const UnifiedMemoryProcessInputPayloadSchema = z.object({
  input: z.string().min(1).max(1_000_000),
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});

export const UnifiedMemoryRetrievePayloadSchema = z.object({
  query: z.string().min(1).max(1_000_000),
  taskId: TaskIdSchema,
  options: z.object({
    types: z.array(MemoryTypeSchema).max(6).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    sessionId: SessionIdSchema.optional(),
    instanceId: InstanceIdSchema.optional(),
  }).optional(),
});

export const UnifiedMemoryRecordSessionEndPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  outcome: SessionOutcomeSchema,
  summary: z.string().min(1).max(1_000_000),
  lessons: z.array(z.string().min(1).max(20_000)).max(200),
});

export const UnifiedMemoryRecordWorkflowPayloadSchema = z.object({
  name: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(20_000)).min(1).max(200),
  applicableContexts: z.array(z.string().min(1).max(500)).max(200),
});

export const UnifiedMemoryRecordStrategyPayloadSchema = z.object({
  strategy: z.string().min(1).max(20_000),
  conditions: z.array(z.string().min(1).max(2_000)).max(200),
  taskId: TaskIdSchema,
  success: z.boolean(),
  score: ScoreSchema,
});

export const UnifiedMemoryRecordOutcomePayloadSchema = z.object({
  taskId: TaskIdSchema,
  success: z.boolean(),
  score: ScoreSchema,
});

export const UnifiedMemoryGetSessionsPayloadSchema = z.number().int().min(1).max(10_000).optional();
export const UnifiedMemoryGetPatternsPayloadSchema = z.number().min(0).max(1).optional();

export const UnifiedMemoryLoadPayloadSchema = z.object({
  version: z.string().min(1).max(20),
  timestamp: z.number().int().nonnegative(),
  shortTerm: z.object({
    buffer: z.array(z.string().max(1_000_000)).max(100_000),
    summaries: z.array(z.string().max(1_000_000)).max(100_000),
  }),
  episodic: z.object({
    sessions: z.array(z.object({
      sessionId: SessionIdSchema,
      summary: z.string().max(1_000_000),
      keyEvents: z.array(z.string().max(20_000)).max(1000),
      outcome: SessionOutcomeSchema,
      lessonsLearned: z.array(z.string().max(20_000)).max(1000),
      timestamp: z.number().int().nonnegative(),
    })).max(100_000),
    patterns: z.array(z.object({
      id: z.string().min(1).max(200),
      pattern: z.string().max(1_000_000),
      successRate: z.number().min(0).max(1),
      usageCount: z.number().int().nonnegative(),
      contexts: z.array(z.string().max(200)).max(5000),
    })).max(100_000),
  }),
  procedural: z.object({
    workflows: z.array(z.object({
      id: z.string().min(1).max(200),
      name: z.string().max(500),
      steps: z.array(z.string().max(20_000)).max(500),
      successRate: z.number().min(0).max(1),
      applicableContexts: z.array(z.string().max(500)).max(500),
    }).passthrough()).max(100_000),
    strategies: z.array(z.object({
      id: z.string().min(1).max(200),
      strategy: z.string().max(20_000),
      conditions: z.array(z.string().max(2000)).max(500),
      outcomes: z.array(z.object({
        taskId: TaskIdSchema,
        success: z.boolean(),
        score: ScoreSchema,
        timestamp: z.number().int().nonnegative(),
      })).max(5000),
    })).max(100_000),
  }),
});

export const UnifiedMemoryConfigurePayloadSchema = UnifiedMemoryConfigSchema;

const DebateConfigSchema = z.object({
  agents: z.number().int().min(2).max(16),
  maxRounds: z.number().int().min(1).max(10),
  convergenceThreshold: z.number().min(0).max(1),
  synthesisModel: z.string().min(1).max(200),
  temperatureRange: z.tuple([z.number().min(0).max(2), z.number().min(0).max(2)]),
  timeout: z.number().int().min(1000).max(3_600_000),
});

export const DebateStartPayloadSchema = z.object({
  query: z.string().min(1).max(1_000_000),
  context: z.string().max(1_000_000).optional(),
  config: DebateConfigSchema.partial().optional(),
  instanceId: z.string().max(500).optional(),
  provider: z.string().max(100).optional(),
});

export const DebateGetResultPayloadSchema = DebateIdSchema;
export const DebateCancelPayloadSchema = DebateIdSchema;

// ============ File Operations ============

// Editor operations
export const EditorOpenFilePayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).optional(),
  column: z.number().int().min(0).optional(),
  waitForClose: z.boolean().optional(),
  newWindow: z.boolean().optional(),
});

export const EditorOpenFileAtLinePayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0),
  column: z.number().int().min(0).optional(),
});

export const EditorOpenDirectoryPayloadSchema = z.object({
  dirPath: DirectoryPathSchema,
});

export const EditorSetPreferredPayloadSchema = z.object({
  type: z.string().min(1).max(50),
  path: z.string().max(2000).optional(),
  args: z.array(z.string().max(500)).max(20).optional(),
});

// Watcher operations
export const WatcherStartPayloadSchema = z.object({
  directory: DirectoryPathSchema,
  ignored: z.array(z.string().max(500)).max(100).optional(),
  useGitignore: z.boolean().optional(),
  depth: z.number().int().min(0).max(20).optional(),
  ignoreInitial: z.boolean().optional(),
  debounceMs: z.number().int().min(0).max(10000).optional(),
});

export const WatcherStopPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const WatcherGetChangesPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  limit: z.number().int().min(1).max(1000).optional(),
});

export const WatcherClearBufferPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

// Multi-edit operations
export const MultiEditOperationSchema = z.object({
  filePath: FilePathSchema,
  oldString: z.string().max(100000),
  newString: z.string().max(100000),
  mode: z.enum(['exact', 'regex']).optional(),
});

export const MultiEditPayloadSchema = z.object({
  edits: z.array(MultiEditOperationSchema).min(1).max(100),
  instanceId: InstanceIdSchema.optional(),
  takeSnapshots: z.boolean().optional(),
});

// ============ Snapshot Operations ============

export const SnapshotTakePayloadSchema = z.object({
  filePath: FilePathSchema,
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema.optional(),
  action: z.enum(['create', 'modify', 'delete']).optional(),
});

export const SnapshotStartSessionPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  description: z.string().max(500).optional(),
});

export const SnapshotEndSessionPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SnapshotGetForInstancePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const SnapshotGetForFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const SnapshotGetSessionsPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const SnapshotGetContentPayloadSchema = z.object({
  snapshotId: SnapshotIdSchema,
});

export const SnapshotRevertFilePayloadSchema = z.object({
  snapshotId: SnapshotIdSchema,
});

export const SnapshotRevertSessionPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SnapshotGetDiffPayloadSchema = z.object({
  snapshotId: SnapshotIdSchema,
});

export const SnapshotDeletePayloadSchema = z.object({
  snapshotId: SnapshotIdSchema,
});

export const SnapshotCleanupPayloadSchema = z.object({
  maxAgeDays: z.number().int().min(1).max(3650),
});

// ============ Codebase Operations ============

export const CodebaseIndexStorePayloadSchema = z.object({
  storeId: StoreIdSchema,
  rootPath: DirectoryPathSchema,
  options: z.object({
    force: z.boolean().optional(),
    filePatterns: z.array(z.string().max(500)).max(100).optional(),
  }).optional(),
});

export const CodebaseIndexFilePayloadSchema = z.object({
  storeId: StoreIdSchema,
  filePath: FilePathSchema,
});

export const CodebaseWatcherPayloadSchema = z.object({
  storeId: StoreIdSchema,
  rootPath: DirectoryPathSchema.optional(),
});

// ============ Security Payloads ============

export const SecurityDetectSecretsPayloadSchema = z.object({
  content: z.string().max(500_000),
  contentType: z.enum(['env', 'text', 'auto']).optional(),
});

export const SecurityRedactContentPayloadSchema = z.object({
  content: z.string().max(500_000),
  contentType: z.enum(['env', 'text', 'auto']).optional(),
  options: z.object({
    maskChar: z.string().max(1).optional(),
    showStart: z.number().int().min(0).max(10).optional(),
    showEnd: z.number().int().min(0).max(10).optional(),
    fullMask: z.boolean().optional(),
    label: z.string().max(100).optional(),
  }).optional(),
});

export const SecurityCheckFilePayloadSchema = z.object({
  filePath: z.string().min(1).max(4096),
});

export const SecurityGetAuditLogPayloadSchema = z.object({
  instanceId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const SecurityCheckEnvVarPayloadSchema = z.object({
  name: z.string().min(1).max(500),
  value: z.string().max(100_000),
});

export const SecuritySetPermissionPresetPayloadSchema = z.object({
  preset: z.enum(['allow', 'ask', 'deny']),
});

export const BashValidatePayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

export const BashCommandPayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

// ============ App / File Handler Payloads ============

export const AppOpenDocsPayloadSchema = z.object({
  filename: z.string().min(1).max(500),
});

export const DialogSelectFilesPayloadSchema = z.object({
  multiple: z.boolean().optional(),
  defaultPath: z.string().max(4096).optional(),
  filters: z.array(z.object({
    name: z.string().min(1).max(200),
    extensions: z.array(z.string().max(20)).max(50),
  })).max(20).optional(),
}).optional();

export const FileReadDirPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  includeHidden: z.boolean().optional(),
});

export const FileGetStatsPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const FileReadTextPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  maxBytes: z.number().int().min(1).max(5_242_880).optional(),
});

export const FileWriteTextPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(50_000_000),
  createDirs: z.boolean().optional(),
});

export const FileOpenPathPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

// ============ Provider & Plugin Payloads ============

export const ProviderStatusPayloadSchema = z.object({
  providerType: z.string().min(1).max(50),
  forceRefresh: z.boolean().optional(),
});

export const ProviderUpdateConfigPayloadSchema = z.object({
  providerType: z.string().min(1).max(50),
  config: z.record(z.string(), z.unknown()),
});

export const PluginsLoadPayloadSchema = z.object({
  idOrPath: z.string().min(1).max(2000),
  timeout: z.number().int().min(0).max(300000).optional(),
  sandbox: z.boolean().optional(),
});

export const PluginsUnloadPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsInstallPayloadSchema = z.object({
  sourcePath: z.string().min(1).max(2000),
});

export const PluginsUninstallPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsGetPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsGetMetaPayloadSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const PluginsCreateTemplatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
});

// ============ Session & Archive Payloads ============

export const SessionForkPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  atMessageIndex: z.number().int().min(0).optional(),
  displayName: DisplayNameSchema.optional(),
});

export const SessionExportPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  format: z.enum(['json', 'markdown']),
});

export const SessionImportPayloadSchema = z.object({
  filePath: FilePathSchema,
  workingDirectory: WorkingDirectorySchema,
});

export const SessionCopyToClipboardPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  format: z.enum(['json', 'markdown']),
});

export const SessionSaveToFilePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  format: z.enum(['json', 'markdown']),
  filePath: FilePathSchema.optional(),
});

export const SessionRevealFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

const SessionShareSourcePayloadShape = {
  instanceId: InstanceIdSchema.optional(),
  entryId: z.string().min(1).max(200).optional(),
};

export const SessionSharePreviewPayloadSchema = z.object(SessionShareSourcePayloadShape)
  .refine((value) => Boolean(value.instanceId) !== Boolean(value.entryId), {
    message: 'Provide either instanceId or entryId.',
  });

export const SessionShareSavePayloadSchema = z.object({
  ...SessionShareSourcePayloadShape,
  filePath: FilePathSchema.optional(),
}).refine((value) => Boolean(value.instanceId) !== Boolean(value.entryId), {
  message: 'Provide either instanceId or entryId.',
});

export const SessionShareLoadPayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const SessionShareReplayPayloadSchema = z.object({
  filePath: FilePathSchema,
  workingDirectory: WorkingDirectorySchema,
  displayName: DisplayNameSchema.optional(),
});

export const ArchiveSessionPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  tags: z.array(z.string().max(100)).max(50).optional(),
});

export const ArchiveListPayloadSchema = z.object({
  beforeDate: z.number().int().nonnegative().optional(),
  afterDate: z.number().int().nonnegative().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  searchTerm: z.string().max(500).optional(),
}).optional();

export const ArchiveRestorePayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const ArchiveDeletePayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const ArchiveGetMetaPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const ArchiveUpdateTagsPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  tags: z.array(z.string().max(100)).max(50),
});

export const ArchiveCleanupPayloadSchema = z.object({
  maxAgeDays: z.number().int().min(1).max(3650),
});

export const HistoryListPayloadSchema = z.object({
  limit: z.number().int().min(1).max(10000).optional(),
  offset: z.number().int().min(0).optional(),
  search: z.string().max(500).optional(),
}).optional();

export const HistoryLoadPayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
});

export const HistoryDeletePayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
});

export const HistoryRestorePayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
  workingDirectory: WorkingDirectorySchema.optional(),
});

// ============ Stats Payloads ============

export const StatsRecordSessionStartPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  instanceId: InstanceIdSchema,
  agentId: z.string().max(100).optional(),
  workingDirectory: WorkingDirectorySchema,
});

export const StatsRecordSessionEndPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const StatsRecordMessagePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
});

export const StatsRecordToolUsagePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  tool: z.string().min(1).max(200),
});

export const StatsGetPayloadSchema = z.object({
  period: z.enum(['day', 'week', 'month', 'all']).optional(),
});

export const StatsGetSessionPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const StatsExportPayloadSchema = z.object({
  filePath: FilePathSchema,
  period: z.enum(['day', 'week', 'month', 'all']).optional(),
});

// ============ Debug & Log Payloads ============

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

export const LogGetRecentPayloadSchema = z.object({
  limit: z.number().int().min(1).max(10000).optional(),
  level: LogLevelSchema.optional(),
  subsystem: z.string().max(100).optional(),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
}).optional();

export const LogSetLevelPayloadSchema = z.object({
  level: LogLevelSchema,
});

export const LogSetSubsystemLevelPayloadSchema = z.object({
  subsystem: z.string().min(1).max(100),
  level: LogLevelSchema,
});

export const LogExportPayloadSchema = z.object({
  filePath: FilePathSchema,
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
});

export const DebugAgentPayloadSchema = z.object({
  agentId: z.string().min(1).max(200),
});

export const DebugConfigPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const DebugFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const DebugAllPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

// ============ Search Payloads ============

export const SearchSemanticPayloadSchema = z.object({
  query: z.string().min(1).max(100000),
  directory: DirectoryPathSchema.optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
  searchType: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
});

export const SearchBuildIndexPayloadSchema = z.object({
  directory: DirectoryPathSchema,
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
});

export const SearchConfigureExaPayloadSchema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(2000).optional(),
});

// ============ Supervision Payloads ============

const SupervisionStrategySchema = z.enum(['one-for-one', 'one-for-all', 'rest-for-one']);
const SupervisionOnExhaustedSchema = z.enum(['stop', 'restart', 'escalate']);

const SupervisionBackoffSchema = z.object({
  minDelayMs: z.number().int().min(0).optional(),
  maxDelayMs: z.number().int().min(0).optional(),
  factor: z.number().min(1).optional(),
  jitter: z.boolean().optional(),
});

const SupervisionHealthCheckSchema = z.object({
  intervalMs: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  unhealthyThreshold: z.number().int().min(1).optional(),
});

const SupervisionConfigSchema = z.object({
  strategy: SupervisionStrategySchema.optional(),
  maxRestarts: z.number().int().min(0).max(1000).optional(),
  maxTime: z.number().int().min(0).optional(),
  onExhausted: SupervisionOnExhaustedSchema.optional(),
  backoff: SupervisionBackoffSchema.optional(),
  healthCheck: SupervisionHealthCheckSchema.optional(),
}).optional();

export const SupervisionCreateTreePayloadSchema = z.object({
  config: SupervisionConfigSchema,
});

export const SupervisionGetTreePayloadSchema = z.object({
  instanceId: InstanceIdSchema.optional(),
});

export const SupervisionGetHealthPayloadSchema = z.object({
  instanceId: InstanceIdSchema.optional(),
}).optional();

export const SupervisionHandleFailurePayloadSchema = z.object({
  childInstanceId: InstanceIdSchema,
  error: z.string().max(10000),
});

// ============ Recent Directories Payloads ============

export const RecentDirsGetPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  sortBy: z.enum(['lastAccessed', 'frequency', 'alphabetical', 'manual']).optional(),
  includePinned: z.boolean().optional(),
}).optional();

export const RecentDirsAddPayloadSchema = z.object({
  path: DirectoryPathSchema,
  nodeId: z.string().min(1).max(200).optional(),
  platform: z.enum(['darwin', 'win32', 'linux']).optional(),
});

export const RecentDirsRemovePayloadSchema = z.object({
  path: DirectoryPathSchema,
});

export const RecentDirsPinPayloadSchema = z.object({
  path: DirectoryPathSchema,
  pinned: z.boolean(),
});

export const RecentDirsReorderPayloadSchema = z.object({
  paths: z.array(DirectoryPathSchema).min(1).max(1000),
});

export const RecentDirsClearPayloadSchema = z.object({
  keepPinned: z.boolean().optional(),
}).optional();

// ============ MCP Payloads ============

export const McpServerPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
});

export const McpAddServerPayloadSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().max(2000).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().max(2000).optional(),
  autoConnect: z.boolean().optional(),
});

export const McpCallToolPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const McpReadResourcePayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  uri: z.string().min(1).max(2000),
});

export const McpGetPromptPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  promptName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.string()).optional(),
});

// ============ LSP Payloads ============

export const LspPositionPayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).max(1000000),
  character: z.number().int().min(0).max(100000),
});

export const LspFindReferencesPayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).max(1000000),
  character: z.number().int().min(0).max(100000),
  includeDeclaration: z.boolean().optional(),
});

export const LspFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const LspWorkspaceSymbolPayloadSchema = z.object({
  query: z.string().min(0).max(1000),
  rootPath: DirectoryPathSchema.optional(),
});

// ============ Codebase Search Payloads ============

export const CodebaseSearchPayloadSchema = z.object({
  options: z.object({
    query: z.string().min(1).max(100000),
    storeId: StoreIdSchema,
    topK: z.number().int().min(1).max(1000).optional(),
    bm25Weight: z.number().min(0).max(1).optional(),
    vectorWeight: z.number().min(0).max(1).optional(),
    useHyDE: z.boolean().optional(),
  }),
});

export const CodebaseSearchSymbolsPayloadSchema = z.object({
  storeId: StoreIdSchema,
  query: z.string().min(1).max(100000),
});

// ============ User Action Request Payloads ============

export const UserActionRequestPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  action: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MemoryLoadHistoryPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

// ============ Worktree & Verification Payloads ============

export const WorktreeCreatePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  taskDescription: z.string().min(1).max(10000),
  baseBranch: z.string().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const WorktreeSessionPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const WorktreeMergePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  strategy: z.string().max(50).optional(),
  commitMessage: z.string().max(1000).optional(),
});

export const WorktreeAbandonPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  reason: z.string().max(1000).optional(),
});

export const WorktreeDetectConflictsPayloadSchema = z.object({
  sessionIds: z.array(SessionIdSchema).min(1).max(50),
});

export const VerifyStartPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  prompt: z.string().min(1).max(500000),
  context: z.string().max(500000).optional(),
  taskType: z.string().max(100).optional(),
  config: z.object({
    minAgents: z.number().int().min(1).max(16).optional(),
    synthesisStrategy: z.string().max(50).optional(),
    personalities: z.array(z.string().max(100)).max(16).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    maxDebateRounds: z.number().int().min(1).max(10).optional(),
  }).optional(),
});

export const VerifyGetResultPayloadSchema = z.object({
  verificationId: z.string().min(1).max(200),
});

export const VerifyCancelPayloadSchema = z.object({
  verificationId: z.string().min(1).max(200),
});

export const VerifyConfigurePayloadSchema = z.object({
  config: z.object({
    minAgents: z.number().int().min(1).max(16).optional(),
    synthesisStrategy: z.string().max(50).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }),
});

// ============ Observation Payloads ============

export const ObservationConfigurePayloadSchema = z.object({
  maxObservations: z.number().int().min(1).max(1000000).optional(),
  decayRate: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  reflectionIntervalMs: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
}).optional();

export const ObservationGetReflectionsPayloadSchema = z.object({
  minConfidence: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
}).optional();

export const ObservationGetObservationsPayloadSchema = z.object({
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(10000).optional(),
}).optional();

// ============ LLM Payloads ============

export const LLMSummarizePayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
  content: z.string().min(1).max(10000000),
  targetTokens: z.number().int().min(1).max(1000000).optional(),
  preserveKeyPoints: z.boolean().optional(),
});

export const LLMSubQueryPayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(1000000),
  context: z.string().max(1000000).optional().default(''),
  depth: z.number().int().min(0).max(10).optional(),
});

export const LLMCancelStreamPayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
});

export const LLMCountTokensPayloadSchema = z.object({
  text: z.string().max(10000000),
  model: z.string().max(200).optional(),
});

export const LLMTruncateTokensPayloadSchema = z.object({
  text: z.string().max(10000000),
  maxTokens: z.number().int().min(1).max(1000000),
  model: z.string().max(200).optional(),
});

export const LLMSetConfigPayloadSchema = z.object({
  anthropicApiKey: z.string().max(500).optional(),
  openaiApiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  temperature: z.number().min(0).max(2).optional(),
}).passthrough();

// ============ CLI Verification Payloads ============

export const CliDetectAllPayloadSchema = z.object({
  force: z.boolean().optional(),
}).optional();

export const CliDetectOnePayloadSchema = z.object({
  command: z.string().min(1).max(200),
});

export const CliTestConnectionPayloadSchema = z.object({
  command: z.string().min(1).max(200),
});

export const ProviderListModelsPayloadSchema = z.object({
  provider: z.string().min(1).max(100),
});

export const CliVerificationStartPayloadSchema = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(500000),
  context: z.string().max(500000).optional(),
  attachments: z.array(z.object({
    name: z.string().max(500),
    mimeType: z.string().max(100),
    data: z.string().max(50 * 1024 * 1024), // base64 encoded, 50MB limit
  })).max(10).optional(),
  config: z.object({
    cliAgents: z.array(z.string().max(100)).max(20).optional(),
    agentCount: z.number().int().min(1).max(20).optional(),
    synthesisStrategy: z.string().max(50).optional(),
    personalities: z.array(z.string().max(100)).max(20).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    timeout: z.number().int().min(1000).max(3600000).optional(),
    maxDebateRounds: z.number().int().min(1).max(10).optional(),
    fallbackToApi: z.boolean().optional(),
    mixedMode: z.boolean().optional(),
  }),
});

export const CliVerificationCancelPayloadSchema = z.object({
  id: z.string().min(1).max(200),
});

// ============ Training Payloads ============

export const TrainingGetStrategiesPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
}).optional();

export const TrainingUpdateConfigPayloadSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

// ============ Workflow Payloads ============

export const WorkflowGetTemplatePayloadSchema = z.object({
  templateId: z.string().min(1).max(200),
});

export const WorkflowStartPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  templateId: z.string().min(1).max(200),
});

export const WorkflowGetExecutionPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const WorkflowGetByInstancePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const WorkflowCompletePhasePayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
  phaseData: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowSatisfyGatePayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
  response: z.object({
    approved: z.boolean().optional(),
    selection: z.string().max(1000).optional(),
    answer: z.string().max(10000).optional(),
  }),
});

export const WorkflowSkipPhasePayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const WorkflowCancelPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const WorkflowGetPromptAdditionPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

// ============ Review Agent Payloads ============

export const ReviewGetAgentPayloadSchema = z.object({
  agentId: z.string().min(1).max(200),
});

export const ReviewStartSessionPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(50),
  files: z.array(FilePathSchema).max(1000),
  diffOnly: z.boolean().optional(),
});

export const ReviewGetSessionPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const ReviewGetIssuesPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  severity: z.string().max(50).optional(),
  agentId: z.string().max(200).optional(),
});

export const ReviewAcknowledgeIssuePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  issueId: z.string().min(1).max(200),
  acknowledged: z.boolean(),
});

// ============ Hook Payloads ============

const HookConditionSchema = z.object({
  field: z.string().min(1).max(200),
  operator: z.string().min(1).max(50),
  pattern: z.string().max(10000),
});

const HookSourceSchema = z.enum(['built-in', 'project', 'user']);

export const HooksListPayloadSchema = z.object({
  event: z.string().max(200).optional(),
  source: HookSourceSchema.optional(),
}).optional();

export const HooksGetPayloadSchema = z.object({
  ruleId: z.string().min(1).max(200),
});

export const HooksCreatePayloadSchema = z.object({
  rule: z.object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    event: z.string().min(1).max(200),
    toolMatcher: z.string().max(500).optional(),
    conditions: z.array(HookConditionSchema).max(50),
    action: z.enum(['warn', 'block']),
    message: z.string().max(5000),
  }),
});

export const HooksUpdatePayloadSchema = z.object({
  ruleId: z.string().min(1).max(200),
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    conditions: z.array(HookConditionSchema).max(50).optional(),
    action: z.enum(['warn', 'block']).optional(),
    message: z.string().max(5000).optional(),
  }),
});

export const HooksDeletePayloadSchema = z.object({
  ruleId: z.string().min(1).max(200),
});

export const HooksEvaluatePayloadSchema = z.object({
  context: z.object({
    event: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    instanceId: InstanceIdSchema,
    toolName: z.string().max(200).optional(),
    toolInput: z.record(z.string(), z.unknown()).optional(),
    filePath: z.string().max(4096).optional(),
    newContent: z.string().max(10000000).optional(),
    command: z.string().max(100000).optional(),
    userPrompt: z.string().max(500000).optional(),
  }),
});

export const HooksImportPayloadSchema = z.object({
  rules: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    event: z.string().min(1).max(200),
    toolMatcher: z.string().max(500).optional(),
    conditions: z.array(HookConditionSchema).max(50),
    action: z.enum(['warn', 'block']),
    message: z.string().max(5000),
    source: HookSourceSchema,
    createdAt: z.number().int().nonnegative(),
  })).max(1000),
  overwrite: z.boolean().optional(),
});

export const HooksExportPayloadSchema = z.object({
  source: HookSourceSchema.optional(),
}).optional();

export const HookApprovalsListPayloadSchema = z.object({
  pendingOnly: z.boolean().optional(),
}).optional();

export const HookApprovalsUpdatePayloadSchema = z.object({
  hookId: z.string().min(1).max(200),
  approved: z.boolean(),
});

export const HookApprovalsClearPayloadSchema = z.object({
  hookIds: z.array(z.string().min(1).max(200)).max(1000).optional(),
}).optional();

// ============ Skill Payloads ============

export const SkillsDiscoverPayloadSchema = z.object({
  searchPaths: z.array(DirectoryPathSchema).min(1).max(100),
});

export const SkillsGetPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsLoadPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsUnloadPayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
});

export const SkillsLoadReferencePayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
  referencePath: FilePathSchema,
});

export const SkillsLoadExamplePayloadSchema = z.object({
  skillId: z.string().min(1).max(200),
  examplePath: FilePathSchema,
});

export const SkillsMatchPayloadSchema = z.object({
  text: z.string().min(1).max(1000000),
});

// ============ Specialist Payloads ============

const SpecialistConstraintsSchema = z.object({
  readOnlyMode: z.boolean().optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  allowedDirectories: z.array(DirectoryPathSchema).max(100).optional(),
  blockedDirectories: z.array(DirectoryPathSchema).max(100).optional(),
  requireApprovalFor: z.array(z.string().max(200)).max(100).optional(),
});

export const SpecialistGetPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
});

export const SpecialistGetByCategoryPayloadSchema = z.object({
  category: z.string().min(1).max(100),
});

export const SpecialistAddCustomPayloadSchema = z.object({
  profile: z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    description: z.string().max(1000),
    category: z.string().min(1).max(100),
    icon: z.string().max(200),
    color: z.string().max(50),
    systemPromptAddition: z.string().max(100000),
    restrictedTools: z.array(z.string().max(200)).max(100),
    constraints: SpecialistConstraintsSchema.optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  }),
});

export const SpecialistUpdateCustomPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    category: z.string().min(1).max(100).optional(),
    icon: z.string().max(200).optional(),
    color: z.string().max(50).optional(),
    systemPromptAddition: z.string().max(100000).optional(),
    restrictedTools: z.array(z.string().max(200)).max(100).optional(),
    constraints: SpecialistConstraintsSchema.optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  }),
});

export const SpecialistRemoveCustomPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
});

export const SpecialistRecommendPayloadSchema = z.object({
  context: z.object({
    taskDescription: z.string().max(10000).optional(),
    fileTypes: z.array(z.string().max(50)).max(100).optional(),
    userPreferences: z.array(z.string().max(200)).max(100).optional(),
  }),
});

export const SpecialistCreateInstancePayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
  orchestratorInstanceId: InstanceIdSchema,
});

export const SpecialistGetInstancePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const SpecialistUpdateStatusPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  status: z.enum(['active', 'paused', 'completed', 'failed']),
});

export const SpecialistAddFindingPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  finding: z.object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(100),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    title: z.string().min(1).max(500),
    description: z.string().max(10000),
    filePath: z.string().max(4096).optional(),
    lineRange: z.object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }).optional(),
    codeSnippet: z.string().max(100000).optional(),
    suggestion: z.string().max(10000).optional(),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string().max(100)).max(50).optional(),
  }),
});

export const SpecialistUpdateMetricsPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  updates: z.object({
    filesAnalyzed: z.number().int().min(0).optional(),
    linesAnalyzed: z.number().int().min(0).optional(),
    findingsCount: z.number().int().min(0).optional(),
    tokensUsed: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
  }),
});

export const SpecialistGetPromptAdditionPayloadSchema = z.object({
  profileId: z.string().min(1).max(200),
});

// ============ Learning / RLM Payloads ============

export const RlmAddSectionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  type: z.enum(['system', 'conversation', 'memory', 'tool', 'result', 'error', 'metadata']),
  name: z.string().min(1).max(200),
  content: z.string().max(10000000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const RlmRemoveSectionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  sectionId: z.string().min(1).max(200),
});

export const RlmStartSessionPayloadSchema = z.object({
  storeId: StoreIdSchema,
  instanceId: InstanceIdSchema,
});

export const RlmGetPatternsPayloadSchema = z.object({
  minSuccessRate: z.number().min(0).max(1).optional(),
}).optional();

export const RlmGetStrategySuggestionsPayloadSchema = z.object({
  context: z.string().min(1).max(1000000),
  maxSuggestions: z.number().int().min(1).max(100).optional(),
});

export const RlmTokenSavingsPayloadSchema = z.object({
  range: z.enum(['7d', '30d', '90d']),
});

export const RlmQueryStatsPayloadSchema = z.object({
  range: z.enum(['7d', '30d', '90d']),
});

export const LearningGetInsightsPayloadSchema = z.object({
  taskType: z.string().max(200).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
}).optional();

export const LearningGetRecommendationPayloadSchema = z.object({
  taskType: z.string().min(1).max(200),
  taskDescription: z.string().max(10000).optional(),
  context: z.string().max(1000000).optional(),
});

export const LearningEnhancePromptPayloadSchema = z.object({
  prompt: z.string().min(1).max(500000),
  taskType: z.string().max(200).optional(),
  context: z.string().max(1000000).optional(),
});

export const LearningRateOutcomePayloadSchema = z.object({
  outcomeId: z.string().min(1).max(200),
  satisfaction: z.number().min(0).max(1),
});

export const AbUpdateExperimentPayloadSchema = z.object({
  experimentId: z.string().min(1).max(200),
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    minSamples: z.number().int().min(1).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
  }),
});

export const AbGetVariantPayloadSchema = z.object({
  taskType: z.string().min(1).max(200),
  sessionId: SessionIdSchema.optional(),
});

export const AbRecordOutcomePayloadSchema = z.object({
  experimentId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200),
  outcome: z.object({
    success: z.boolean(),
    duration: z.number().int().min(0).optional(),
    tokens: z.number().int().min(0).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const AbListExperimentsPayloadSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'draft']).optional(),
  taskType: z.string().max(200).optional(),
}).optional();

// ============ VCS Payloads ============

export const VcsIsRepoPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetStatusPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetBranchesPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetCommitsPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

export const VcsGetDiffPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  type: z.enum(['staged', 'unstaged', 'between']),
  fromRef: z.string().max(500).optional(),
  toRef: z.string().max(500).optional(),
  filePath: FilePathSchema.optional(),
});

export const VcsGetFileHistoryPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

export const VcsGetFileAtCommitPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
  commitHash: z.string().min(1).max(500),
});

export const VcsGetBlamePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
});

// ============ Task Payloads ============

export const TaskGetStatusPayloadSchema = z.object({
  taskId: z.string().min(1).max(200),
});

export const TaskGetHistoryPayloadSchema = z.object({
  parentId: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const TaskGetByParentPayloadSchema = z.object({
  parentId: z.string().min(1).max(200),
});

export const TaskGetByChildPayloadSchema = z.object({
  childId: z.string().min(1).max(200),
});

export const TaskCancelPayloadSchema = z.object({
  taskId: z.string().min(1).max(200),
});

export const TaskGetPreflightPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  surface: z.enum(['repo-job', 'workflow', 'worktree', 'verification']),
  taskType: z.string().min(1).max(200).optional(),
  requiresWrite: z.boolean().optional(),
  requiresNetwork: z.boolean().optional(),
  requiresBrowser: z.boolean().optional(),
});

const RepoJobTypeSchema = z.enum(['pr-review', 'issue-implementation', 'repo-health-audit']);
const RepoJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const RepoJobSubmitPayloadSchema = z.object({
  type: RepoJobTypeSchema,
  workingDirectory: WorkingDirectorySchema,
  issueOrPrUrl: z.string().url().max(2000).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50000).optional(),
  baseBranch: z.string().max(500).optional(),
  branchRef: z.string().max(500).optional(),
  workflowTemplateId: z.string().max(200).optional(),
  useWorktree: z.boolean().optional(),
  browserEvidence: z.boolean().optional(),
});

export const RepoJobListPayloadSchema = z.object({
  status: RepoJobStatusSchema.optional(),
  type: RepoJobTypeSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).optional();

export const RepoJobGetPayloadSchema = z.object({
  jobId: z.string().min(1).max(200),
});

export const RepoJobCancelPayloadSchema = z.object({
  jobId: z.string().min(1).max(200),
});

export const RepoJobRerunPayloadSchema = z.object({
  jobId: z.string().min(1).max(200),
});

// ============ Reaction Engine Payloads ============

export const ReactionTrackInstancePayloadSchema = z.object({
  instanceId: z.string().min(1).max(200),
  prUrl: z.string().url().max(2000),
});

export const ReactionUntrackInstancePayloadSchema = z.object({
  instanceId: z.string().min(1).max(200),
});

export const ReactionGetStatePayloadSchema = z.object({
  instanceId: z.string().min(1).max(200),
});

export const ReactionUpdateConfigPayloadSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalMs: z.number().int().min(5000).max(600_000).optional(),
});

// ============ Todo Payloads ============

export const TodoGetListPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const TodoCreatePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  content: z.string().min(1).max(10000),
  activeForm: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  parentId: z.string().max(200).optional(),
});

export const TodoUpdatePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  todoId: z.string().min(1).max(200),
  content: z.string().min(1).max(10000).optional(),
  activeForm: z.string().max(100).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

export const TodoDeletePayloadSchema = z.object({
  sessionId: SessionIdSchema,
  todoId: z.string().min(1).max(200),
});

export const TodoWriteAllPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  todos: z.array(z.object({
    content: z.string().max(10000),
    status: z.string().max(50),
    activeForm: z.string().max(100).optional(),
  })).max(1000),
});

export const TodoClearPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const TodoGetCurrentPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

// ============ Cost Payloads ============

// IPC auth token used by some cost handlers for basic authentication
const IpcAuthTokenSchema = z.string().max(500).optional();

export const CostRecordUsagePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema,
  model: z.string().min(1).max(200),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  ipcAuthToken: IpcAuthTokenSchema,
});

export const CostGetSummaryPayloadSchema = z.object({
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
  ipcAuthToken: IpcAuthTokenSchema,
}).optional();

export const CostGetSessionCostPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  ipcAuthToken: IpcAuthTokenSchema,
});

export const CostSetBudgetPayloadSchema = z.object({
  enabled: z.boolean().optional(),
  dailyLimit: z.number().min(0).optional(),
  weeklyLimit: z.number().min(0).optional(),
  monthlyLimit: z.number().min(0).optional(),
  perSessionLimit: z.number().min(0).optional(),
  alertThresholds: z.array(z.number().min(0).max(1)).max(20).optional(),
  ipcAuthToken: IpcAuthTokenSchema,
});

export const CostGetBudgetPayloadSchema = z.object({
  ipcAuthToken: IpcAuthTokenSchema,
}).optional();

export const CostGetBudgetStatusPayloadSchema = z.object({
  ipcAuthToken: IpcAuthTokenSchema,
}).optional();

export const CostGetEntriesPayloadSchema = z.object({
  limit: z.number().int().min(1).max(100000).optional(),
  ipcAuthToken: IpcAuthTokenSchema,
}).optional();

export const CostClearEntriesPayloadSchema = z.object({
  ipcAuthToken: IpcAuthTokenSchema,
}).optional();

// ============ Ecosystem Payloads ============

export const EcosystemListPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

// ============ Instance Additional Payloads ============
// (InstanceInterruptPayload and InstanceRestartPayload)

export const InstanceInterruptPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const InstanceRestartPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

// ============ Settings Additional Payloads ============
// SettingsSetPayload (SettingsUpdatePayloadSchema already exists with key/value)

export const SettingsSetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

// ============ Context Compaction ============

export const InstanceCompactPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export type ValidatedInstanceCompactPayload = z.infer<typeof InstanceCompactPayloadSchema>;

// ============ Consensus Payloads ============

export const ConsensusProviderSpecSchema = z.object({
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot']),
  model: z.string().optional(),
  weight: z.number().optional(),
});

export const ConsensusQueryPayloadSchema = z.object({
  question: z.string().min(1).max(10000),
  context: z.string().max(50000).optional(),
  providers: z.array(ConsensusProviderSpecSchema).optional(),
  strategy: z.enum(['majority', 'weighted', 'all']).optional(),
  timeout: z.number().positive().optional(),
  workingDirectory: z.string().max(2000).optional(),
});

export const ConsensusAbortPayloadSchema = z.object({
  queryId: z.string().min(1).max(200),
});

export type ValidatedConsensusQueryPayload = z.infer<typeof ConsensusQueryPayloadSchema>;
export type ValidatedConsensusAbortPayload = z.infer<typeof ConsensusAbortPayloadSchema>;

// ============ Parallel Worktree Payloads ============

export const ParallelWorktreeTaskSchema = z.object({
  id: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  files: z.array(z.string().min(1).max(2000)).max(500).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  dependencies: z.array(z.string().min(1).max(200)).max(50).optional(),
});

export const ParallelWorktreeStartPayloadSchema = z.object({
  tasks: z.array(ParallelWorktreeTaskSchema).min(1).max(20),
  instanceId: InstanceIdSchema,
  repoPath: z.string().min(1).max(2000),
});

export const ParallelWorktreeGetStatusPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const ParallelWorktreeCancelPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const ParallelWorktreeGetResultsPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
});

export const ParallelWorktreeResolveConflictPayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  resolution: z.enum(['ours', 'theirs', 'manual']),
});

export const ParallelWorktreeMergePayloadSchema = z.object({
  executionId: z.string().min(1).max(200),
  strategy: z.enum(['auto', 'squash', 'rebase', 'manual']).optional(),
});

// ============ Knowledge Graph Schemas ============

export const KgAddFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceCloset: z.string().optional(),
  sourceFile: z.string().optional(),
});

export const KgInvalidateFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  ended: z.string().optional(),
});

export const KgQueryEntityPayloadSchema = z.object({
  entityName: z.string().min(1),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
  asOf: z.string().optional(),
});

export const KgQueryRelationshipPayloadSchema = z.object({
  predicate: z.string().min(1),
  asOf: z.string().optional(),
});

export const KgTimelinePayloadSchema = z.object({
  entityName: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const KgAddEntityPayloadSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

// ============ Conversation Mining Schemas ============

export const ConvoImportFilePayloadSchema = z.object({
  filePath: z.string().min(1),
  wing: z.string().min(1),
});

export const ConvoImportStringPayloadSchema = z.object({
  content: z.string().min(1),
  wing: z.string().min(1),
  sourceFile: z.string().min(1),
  format: z.enum([
    'claude-code-jsonl', 'codex-jsonl', 'claude-ai-json',
    'chatgpt-json', 'slack-json', 'plain-text',
  ]).optional(),
});

export const ConvoDetectFormatPayloadSchema = z.object({
  content: z.string().min(1),
});

// ============ Wake Context Schemas ============

export const WakeGeneratePayloadSchema = z.object({
  wing: z.string().optional(),
});

export const WakeAddHintPayloadSchema = z.object({
  content: z.string().min(1),
  importance: z.number().min(0).max(10).optional(),
  room: z.string().optional(),
  sourceReflectionId: z.string().optional(),
  sourceSessionId: z.string().optional(),
});

export const WakeRemoveHintPayloadSchema = z.object({
  id: z.string().min(1),
});

export const WakeSetIdentityPayloadSchema = z.object({
  text: z.string().min(1).max(500),
});

// Remote Node Schemas and Validation Helpers are re-exported from '@contracts/schemas' above.
