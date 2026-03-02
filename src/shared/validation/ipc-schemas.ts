/**
 * IPC Payload Validation Schemas
 *
 * Zod schemas for runtime validation of critical IPC payloads.
 * These schemas validate data crossing the main/renderer boundary.
 */

import { z } from 'zod';

// ============ Common Schemas ============

export const InstanceIdSchema = z.string().min(1).max(100);
export const SessionIdSchema = z.string().min(1).max(100);
export const DisplayNameSchema = z.string().min(1).max(200);
export const WorkingDirectorySchema = z.string().min(1).max(1000);
export const FilePathSchema = z.string().min(1).max(2000);
export const DirectoryPathSchema = z.string().min(1).max(2000);
export const SnapshotIdSchema = z.string().min(1).max(100);
export const StoreIdSchema = z.string().min(1).max(200);

// ============ File Attachment Schema ============

export const FileAttachmentSchema = z.object({
  name: z.string().max(500),
  type: z.string().max(100),
  size: z.number().int().min(0).max(50 * 1024 * 1024), // 50MB max
  data: z.string().optional(), // Base64 encoded
});

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
  provider: z.enum(['auto', 'claude', 'openai', 'codex', 'gemini', 'copilot']).optional(),
  model: z.string().max(100).optional(),
});

export type ValidatedInstanceCreatePayload = z.infer<typeof InstanceCreatePayloadSchema>;

// ============ Instance Input ============

export const InstanceSendInputPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  message: z.string().min(0).max(500000), // Allow empty string when attachments carry the content
  attachments: z.array(z.object({
    name: z.string().max(500),
    type: z.string().max(100),
    size: z.number().int().min(0).max(50 * 1024 * 1024),
    data: z.string().optional(),
  })).max(10).optional(),
});

export type InstanceSendInputPayload = z.infer<typeof InstanceSendInputPayloadSchema>;

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

// ============ User Action Response ============

export const UserActionResponsePayloadSchema = z.object({
  requestId: z.string().min(1).max(100),
  action: z.enum(['approve', 'reject', 'custom']),
  customValue: z.string().max(10000).optional(),
});

export type UserActionResponsePayload = z.infer<typeof UserActionResponsePayloadSchema>;

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
  sortBy: z.enum(['lastAccessed', 'frequency', 'alphabetical']).optional(),
  includePinned: z.boolean().optional(),
}).optional();

export const RecentDirsAddPayloadSchema = z.object({
  path: DirectoryPathSchema,
});

export const RecentDirsRemovePayloadSchema = z.object({
  path: DirectoryPathSchema,
});

export const RecentDirsPinPayloadSchema = z.object({
  path: DirectoryPathSchema,
  pinned: z.boolean(),
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

// ============ Validation Helper ============

/**
 * Validate an IPC payload against a schema.
 * Returns the validated data or throws a descriptive error.
 */
export function validateIpcPayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new Error(`IPC validation failed for ${context}: ${errors}`);
  }
  return result.data;
}

/**
 * Safe validation that returns null instead of throwing
 */
export function safeValidateIpcPayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
