import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  FilePathSchema,
  SnapshotIdSchema,
  StoreIdSchema,
  WorkingDirectorySchema,
  DisplayNameSchema,
  FileAttachmentSchema,
} from './common.schemas';

// ============ Helper schemas ============

export const TaskIdSchema = z.string().min(1).max(200);
export const ScoreSchema = z.number().finite().min(-1).max(1);
const SessionOutcomeSchema = z.enum(['success', 'partial', 'failure']);

const MemoryTypeSchema = z.enum([
  'short_term',
  'long_term',
  'episodic',
  'semantic',
  'procedural',
  'skills',
]);

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

// IPC auth token used by some cost handlers for basic authentication
const IpcAuthTokenSchema = z.string().max(500).optional();

// ============ Memory R1 schemas ============

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

// ============ Unified Memory schemas ============

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

// ============ Snapshot schemas ============

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

// ============ Session & Archive schemas ============

export const SessionForkPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  atMessageIndex: z.number().int().min(0).optional(),
  atMessageId: z.string().min(1).max(200).optional(),
  sourceMessageId: z.string().min(1).max(200).optional(),
  forkAfterMessageId: z.string().min(1).max(200).optional(),
  displayName: DisplayNameSchema.optional(),
  initialPrompt: z.string().optional(),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  preserveRuntimeSettings: z.boolean().optional(),
  supersedeSource: z.boolean().optional(),
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

export const HistoryTimeRangeSchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
});

export const HistoryProjectScopeSchema = z.enum(['current', 'all', 'none']);

export const HistorySearchSourceSchema = z.enum([
  'history-transcript',
  'child_result',
  'child_diagnostic',
  'automation_run',
  'agent_tree',
  'archived_session',
]);

export const HistoryPageRequestSchema = z.object({
  pageSize: z.number().int().min(1).max(100),
  pageNumber: z.number().int().min(1),
});

export const HistorySearchAdvancedPayloadSchema = z.object({
  searchQuery: z.string().max(1000).optional(),
  snippetQuery: z.string().max(1000).optional(),
  workingDirectory: WorkingDirectorySchema.optional(),
  projectScope: HistoryProjectScopeSchema.optional(),
  source: z.union([
    HistorySearchSourceSchema,
    z.array(HistorySearchSourceSchema).max(10),
  ]).optional(),
  timeRange: HistoryTimeRangeSchema.optional(),
  page: HistoryPageRequestSchema.optional(),
});

export const HistoryExpandSnippetsPayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
  query: z.string().min(1).max(1000),
});

export const ResumeLatestPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema.optional(),
});

export const ResumeByIdPayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
});

export const ResumeSwitchToLivePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const ResumeForkNewPayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
});

export const ResumeRestoreFallbackPayloadSchema = z.object({
  entryId: z.string().min(1).max(200),
});

// ============ Stats schemas ============

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

// ============ Observation schemas ============

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

// ============ Learning / RLM schemas ============

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

// ============ Todo schemas ============

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

// ============ Cost schemas ============

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
