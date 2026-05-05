import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  DisplayNameSchema,
  WorkingDirectorySchema,
  FileAttachmentSchema,
} from './common.schemas';

const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

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
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
  model: z.string().max(100).optional(),
  forceNodeId: z.string().uuid().optional(),
});

export type ValidatedInstanceCreatePayload = z.infer<typeof InstanceCreatePayloadSchema>;

export const InstanceCreateWithMessagePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  message: z.string().min(0).max(500000),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  agentId: z.string().max(100).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
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
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
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

// ============ Instance Additional Payloads ============

export const InstanceInterruptPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const InstanceRestartPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const InstanceRestartFreshPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

// ============ Context Compaction ============

export const InstanceCompactPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export type ValidatedInstanceCompactPayload = z.infer<typeof InstanceCompactPayloadSchema>;

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

// ============ User Action Request ============

export const UserActionRequestPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  action: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============ Commands ============

export {
  CommandCreatePayloadSchema,
  CommandDeletePayloadSchema,
  CommandExecutePayloadSchema,
  CommandListPayloadSchema,
  CommandResolvePayloadSchema,
  CommandUpdatePayloadSchema,
  UsageRecordPayloadSchema,
  UsageSnapshotPayloadSchema,
  WorkspaceIsGitRepoPayloadSchema,
} from './command.schemas';

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

// ============ Memory Load History ============

export const MemoryLoadHistoryPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

// ============ Queue Persistence ============

export const PersistedQueuedMessageSchema = z.object({
  message: z.string(),
  hadAttachmentsDropped: z.boolean(),
  retryCount: z.number().int().min(0).max(10).optional(),
  seededAlready: z.boolean().optional(),
  kind: z.enum(['queue', 'steer']).optional(),
});

export const InstanceQueueSavePayloadSchema = z.object({
  instanceId: z.string(),
  queue: z.array(PersistedQueuedMessageSchema),
});

export const InstanceQueueLoadAllResponseSchema = z.object({
  queues: z.record(z.string(), z.array(PersistedQueuedMessageSchema)),
});

export const InstanceQueueInitialPromptPayloadSchema = z.object({
  instanceId: z.string(),
  message: z.string(),
  attachments: z.array(FileAttachmentSchema).optional(),
  seededAlready: z.literal(true),
});

export type PersistedQueuedMessage = z.infer<typeof PersistedQueuedMessageSchema>;
export type InstanceQueueSavePayload = z.infer<typeof InstanceQueueSavePayloadSchema>;
export type InstanceQueueLoadAllResponse = z.infer<typeof InstanceQueueLoadAllResponseSchema>;
export type InstanceQueueInitialPromptPayload = z.infer<typeof InstanceQueueInitialPromptPayloadSchema>;
