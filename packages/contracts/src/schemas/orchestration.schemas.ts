import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  DirectoryPathSchema,
  FilePathSchema,
  WorkingDirectorySchema,
} from './common.schemas';

// ============ Orchestration Commands ============

export const SpawnChildPayloadSchema = z.object({
  parentInstanceId: InstanceIdSchema,
  task: z.string().min(1).max(100000),
  name: z.string().max(200).optional(),
  agentId: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
});

export type SpawnChildPayload = z.infer<typeof SpawnChildPayloadSchema>;

export const MessageChildPayloadSchema = z.object({
  parentInstanceId: InstanceIdSchema,
  childId: InstanceIdSchema,
  message: z.string().min(1).max(100000),
});

export type MessageChildPayload = z.infer<typeof MessageChildPayloadSchema>;

export const GetChildDiagnosticBundlePayloadSchema = z.object({
  childInstanceId: InstanceIdSchema,
});

export const SummarizeChildrenPayloadSchema = z.object({
  parentInstanceId: InstanceIdSchema,
});

// ============ Debate Payloads ============

const DebateConfigSchema = z.object({
  agents: z.number().int().min(2).max(16),
  maxRounds: z.number().int().min(1).max(10),
  convergenceThreshold: z.number().min(0).max(1),
  synthesisModel: z.string().min(1).max(200),
  temperatureRange: z.tuple([z.number().min(0).max(2), z.number().min(0).max(2)]),
  timeout: z.number().int().min(1000).max(3_600_000),
});

const DebateIdSchema = z.string().min(1).max(200);

export const DebateStartPayloadSchema = z.object({
  query: z.string().min(1).max(1_000_000),
  context: z.string().max(1_000_000).optional(),
  config: DebateConfigSchema.partial().optional(),
  instanceId: z.string().max(500).optional(),
  provider: z.string().max(100).optional(),
});

export const DebateGetResultPayloadSchema = DebateIdSchema;
export const DebateCancelPayloadSchema = DebateIdSchema;

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

// ============ Workflow Payloads ============

export const WorkflowGetTemplatePayloadSchema = z.object({
  templateId: z.string().min(1).max(200),
});

export const WorkflowStartPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  templateId: z.string().min(1).max(200),
  source: z.enum(['slash-command', 'nl-suggestion', 'automation', 'manual-ui', 'restore']).optional(),
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

// ============ Consensus Payloads ============

export const ConsensusProviderSpecSchema = z.object({
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']),
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
