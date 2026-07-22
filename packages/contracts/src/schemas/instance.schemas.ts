import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  DisplayNameSchema,
  WorkingDirectorySchema,
  FileAttachmentSchema,
  ModelIdSchema,
  RequiredModelIdSchema,
} from './common.schemas';

const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow']);
export const InstanceLaunchModeSchema = z.enum(['orchestrated', 'interactive']);
export const InstanceStatusSchema = z.enum([
  'initializing',
  'ready',
  'idle',
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'cancelled',
  'superseded',
  'respawning',
  'hibernating',
  'hibernated',
  'waking',
  'degraded',
  'error',
  'failed',
  'terminated',
]);
const InstanceCreateProviderSchema = z.enum(['auto', 'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']);
const NodePlacementPrefsSchema = z.object({
  requiresBrowser: z.boolean().optional(),
  requiresAndroid: z.boolean().optional(),
  androidDeviceKind: z.enum(['emulator', 'physical', 'any']).optional(),
  requiresGpu: z.boolean().optional(),
  preferPlatform: z.enum(['darwin', 'win32', 'linux']).optional(),
  preferNodeId: z.string().optional(),
  requiresCli: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']).optional(),
  requiresWorkingDirectory: z.string().min(1).max(4096).optional(),
});
export const ModelRuntimeTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cli'),
    provider: InstanceCreateProviderSchema.optional(),
  }),
  z.object({
    kind: z.literal('local-model'),
    source: z.enum(['this-device', 'worker-node']),
    endpointProvider: z.enum(['ollama', 'openai-compatible']),
    endpointId: z.string().min(1).max(200),
    modelId: ModelIdSchema,
    selectorId: z.string().min(1).max(2048),
    nodeId: z.string().min(1).max(200).optional(),
    nodeName: z.string().min(1).max(200).optional(),
  }).superRefine((target, ctx) => {
    const decoded = decodeLocalModelSelectorForSchema(target.selectorId);
    if (!decoded) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectorId'],
        message: 'Invalid local model selector',
      });
      return;
    }

    if (
      decoded.source !== target.source ||
      decoded.endpointProvider !== target.endpointProvider ||
      decoded.endpointId !== target.endpointId ||
      decoded.modelId !== target.modelId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectorId'],
        message: 'local-model selector does not match target fields',
      });
    }

    const nodeId = target.nodeId?.trim();
    if (target.source === 'worker-node' && !nodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeId'],
        message: 'worker-node local-model runtime targets require nodeId',
      });
    }
    if (target.source === 'worker-node' && nodeId && decoded.nodeId !== nodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeId'],
        message: 'worker-node local-model nodeId must match selector',
      });
    }
    if (target.source === 'this-device' && target.nodeId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeId'],
        message: 'this-device local-model runtime targets cannot include nodeId',
      });
    }
  }),
]);

function decodeLocalModelSelectorForSchema(value: string): {
  source: 'this-device' | 'worker-node';
  nodeId?: string;
  endpointProvider: 'ollama' | 'openai-compatible';
  endpointId: string;
  modelId: string;
} | null {
  try {
    const parts = value.split('/');
    if (parts[0] !== 'lm:' || parts[1] !== '') {
      return null;
    }
    if (parts[2] === 'worker-node' && parts.length === 7) {
      const nodeId = decodeURIComponent(parts[3]);
      const endpointProvider = parseLocalModelEndpointProvider(parts[4]);
      if (!nodeId || !endpointProvider) {
        return null;
      }
      return {
        source: 'worker-node',
        nodeId,
        endpointProvider,
        endpointId: decodeURIComponent(parts[5]),
        modelId: decodeURIComponent(parts[6]),
      };
    }
    if (parts[2] === 'this-device' && parts.length === 6) {
      const endpointProvider = parseLocalModelEndpointProvider(parts[3]);
      if (!endpointProvider) {
        return null;
      }
      return {
        source: 'this-device',
        endpointProvider,
        endpointId: decodeURIComponent(parts[4]),
        modelId: decodeURIComponent(parts[5]),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseLocalModelEndpointProvider(
  value: string,
): 'ollama' | 'openai-compatible' | null {
  return value === 'ollama' || value === 'openai-compatible' ? value : null;
}

// ============ Instance Creation ============

export const InstanceCreatePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  sessionId: SessionIdSchema.optional(),
  parentInstanceId: InstanceIdSchema.optional(),
  displayName: DisplayNameSchema.optional(),
  initialPrompt: z.string().max(500000).optional(),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  yoloMode: z.boolean().optional(),
  launchMode: InstanceLaunchModeSchema.optional(),
  agentId: z.string().max(100).optional(),
  provider: InstanceCreateProviderSchema.optional(),
  model: ModelIdSchema.optional(),
  modelRuntimeTarget: ModelRuntimeTargetSchema.optional(),
  bareMode: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  forceNodeId: z.string().uuid().optional(),
  nodePlacement: NodePlacementPrefsSchema.optional(),
  browserToolsMode: z.enum(['eager', 'deferred', 'off']).optional(),
  hardened: z.boolean().optional(),
});

export type ValidatedInstanceCreatePayload = z.infer<typeof InstanceCreatePayloadSchema>;

export const InstanceCreateWithMessagePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  message: z.string().min(0).max(500000),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  launchMode: InstanceLaunchModeSchema.optional(),
  agentId: z.string().max(100).optional(),
  provider: InstanceCreateProviderSchema.optional(),
  model: ModelIdSchema.optional(),
  modelRuntimeTarget: ModelRuntimeTargetSchema.optional(),
  yoloMode: z.boolean().optional(),
  bareMode: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  forceNodeId: z.string().uuid().optional(),
  nodePlacement: NodePlacementPrefsSchema.optional(),
  browserToolsMode: z.enum(['eager', 'deferred', 'off']).optional(),
  hardened: z.boolean().optional(),
});

// ============ Instance Input ============

const InstanceInputAttachmentSchema = z.object({
  name: z.string().max(500),
  type: z.string().max(100),
  size: z.number().int().min(0).max(50 * 1024 * 1024),
  data: z.string().optional(),
});

export const InstanceSendInputPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  message: z.string().max(500000),
  attachments: z.array(InstanceInputAttachmentSchema).max(10).optional(),
  isRetry: z.boolean().optional(),
  /**
   * Optional stable key for at-most-once delivery (B2). A retried send carrying
   * the same key is recognised as a duplicate and skipped instead of dispatching
   * the input twice.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
}).refine(
  (data) => data.message.trim().length > 0 || (data.attachments && data.attachments.length > 0),
  { message: 'Either message must be non-empty or attachments must be provided' }
);

export type InstanceSendInputPayload = z.infer<typeof InstanceSendInputPayloadSchema>;

export const InstanceSteerInputPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  message: z.string().max(500000),
  attachments: z.array(InstanceInputAttachmentSchema).max(10).optional(),
}).refine(
  (data) => data.message.trim().length > 0 || (data.attachments && data.attachments.length > 0),
  { message: 'Either message must be non-empty or attachments must be provided' }
);

export type InstanceSteerInputPayload = z.infer<typeof InstanceSteerInputPayloadSchema>;

// ============ Output History ============

export const InstanceLoadOlderMessagesPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  beforeChunk: z.number().int().min(0).optional(), // Load chunks before this index
  limit: z.number().int().min(1).max(500).optional().default(200),
});

export type InstanceLoadOlderMessagesPayload = z.infer<typeof InstanceLoadOlderMessagesPayloadSchema>;

export const InstanceGetPromptIndexPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export type InstanceGetPromptIndexPayload = z.infer<typeof InstanceGetPromptIndexPayloadSchema>;

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

/** Concrete provider targets for a cross-provider swap (no 'auto' sentinel). */
const InstanceChangeProviderSchema = z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']);

export const InstanceChangeModelPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  /**
   * Optional only when `provider` is set (cross-provider swap without an
   * explicit model falls back to the remembered per-provider default).
   */
  model: RequiredModelIdSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  modelRuntimeTarget: ModelRuntimeTargetSchema.optional(),
  /**
   * Target CLI provider for a cross-provider swap of an existing session.
   * Omitted (or equal to the instance's current provider) means a plain
   * model change within the current provider.
   */
  provider: InstanceChangeProviderSchema.optional(),
}).refine(
  (data) => data.model !== undefined || data.provider !== undefined,
  { message: 'model is required unless provider is provided', path: ['model'] },
);

export type InstanceChangeModelPayload = z.infer<typeof InstanceChangeModelPayloadSchema>;

export const InstanceToggleFastModePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  /** Explicit target state. Omit to flip the current value. */
  fastMode: z.boolean().optional(),
});

export type InstanceToggleFastModePayload = z.infer<typeof InstanceToggleFastModePayloadSchema>;

// ============ Input Required Response ============

export const InputRequiredResponsePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  requestId: z.string().min(1).max(100),
  response: z.string().min(1).max(10000),
  permissionKey: z.string().max(200).optional(),
  /**
   * 'modify' indicates the user approves the tool call but wants to replace the
   * tool input with `updatedInput`.  When action is 'modify', `updatedInput` MUST
   * be present and non-empty; the handler will reject the payload with an explicit
   * error rather than silently falling back to a plain allow of the original input.
   *
   * NOTE: whether the installed Claude CLI actually honours `updatedInput` in a
   * PreToolUse hook reply is version-dependent.  The orchestrator writes the field
   * into the decision file and the hook emits it, but end-to-end modify support
   * requires live-CLI validation before it can be considered reliable.
   */
  decisionAction: z.enum(['allow', 'deny', 'modify']).optional(),
  decisionScope: z.enum(['once', 'session', 'always']).optional(),
  /**
   * Replacement tool input for a 'modify' decision.  Must be a non-empty plain
   * object (at least one key).  Ignored when decisionAction is 'allow' or 'deny'.
   */
  updatedInput: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).length > 0,
    { message: 'updatedInput must be a non-empty object' },
  ).optional(),
  /** Optional metadata for routing — e.g. type: 'deferred_permission' for defer flow. */
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => {
    // If decisionAction is 'modify', updatedInput must be present and non-empty.
    if (data.decisionAction === 'modify') {
      return data.updatedInput !== undefined && Object.keys(data.updatedInput).length > 0;
    }
    return true;
  },
  {
    message: "updatedInput (non-empty object) is required when decisionAction is 'modify'",
    path: ['updatedInput'],
  },
);

export type InputRequiredResponsePayload = z.infer<typeof InputRequiredResponsePayloadSchema>;

// ============ Instance Additional Payloads ============

export const InstanceInterruptPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const InstanceFailoverNowPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

/** WS13 slice 3 — session-scoped Seatbelt grant: allow a path and restart into the rebuilt jail. */
export const InstanceHardenedAllowPathPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  path: z.string().min(1).max(4096),
});

export const InstanceProviderLimitResumeNowPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export const InstanceProviderLimitCancelPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

/** In-session auth repair: re-probe the provider and resume if signed back in. */
export const InstanceAuthRepairRetryPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

/** In-session auth repair: dismiss the banner and stop watching for sign-in. */
export const InstanceAuthRepairCancelPayloadSchema = z.object({
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

export const InstanceRecoverCompactionContextPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  markerId: z.string().min(1).max(200),
});

export type InstanceRecoverCompactionContextPayload = z.infer<typeof InstanceRecoverCompactionContextPayloadSchema>;

const ContextUsageEventSchema = z.object({
  used: z.number().nonnegative().finite(),
  total: z.number().nonnegative().finite(),
  percentage: z.number().min(0).max(100).finite(),
  cumulativeTokens: z.number().nonnegative().finite().optional(),
  inputTokens: z.number().nonnegative().finite().optional(),
  outputTokens: z.number().nonnegative().finite().optional(),
  source: z.string().min(1).max(200).optional(),
  promptWeight: z.number().nonnegative().finite().optional(),
  promptWeightBreakdown: z.object({
    systemPrompt: z.number().nonnegative().finite().optional(),
    mcpToolDescriptions: z.number().nonnegative().finite().optional(),
    skills: z.number().nonnegative().finite().optional(),
    plugins: z.number().nonnegative().finite().optional(),
    userPrompt: z.number().nonnegative().finite().optional(),
    other: z.number().nonnegative().finite().optional(),
  }).strict().optional(),
  costEstimate: z.number().nonnegative().finite().optional(),
  isEstimated: z.boolean().optional(),
}).strict();

export const ContextWarningEventSchema = z.union([
  z.object({
    instanceId: InstanceIdSchema,
    percentage: z.number().min(0).max(100).finite(),
    level: z.enum(['warning', 'critical', 'emergency']),
    deprecated: z.boolean().optional(),
    legacyThreshold: z.union([z.literal(75), z.literal(80), z.literal(95)]).optional(),
    decisionOwner: z.literal('ContextSafetyPolicy').optional(),
  }).strict(),
  z.object({
    instanceId: InstanceIdSchema,
    allowed: z.boolean(),
    shouldWarn: z.boolean(),
    remainingTokens: z.number().finite(),
    source: z.enum(['config', 'model', 'default']),
    message: z.string().min(1).max(10_000).optional(),
  }).strict(),
]);

export const InstanceCompactStatusEventSchema = z.discriminatedUnion('status', [
  z.object({
    instanceId: InstanceIdSchema,
    status: z.literal('started'),
  }).strict(),
  z.object({
    instanceId: InstanceIdSchema,
    status: z.literal('completed'),
    success: z.boolean(),
    method: z.enum(['native', 'restart-with-summary']),
    blocking: z.boolean(),
    previousUsage: ContextUsageEventSchema.optional(),
    newUsage: ContextUsageEventSchema.optional(),
    summary: z.string().max(500_000).optional(),
    error: z.string().max(10_000).optional(),
  }).strict(),
  z.object({
    instanceId: InstanceIdSchema,
    status: z.literal('error'),
    error: z.string().min(1).max(10_000),
  }).strict(),
]);

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

// ============ Main → Renderer Lifecycle Events ============

export const InstanceCreatedEventPayloadSchema = z.object({
  id: InstanceIdSchema,
  status: InstanceStatusSchema,
  workingDirectory: WorkingDirectorySchema,
}).passthrough();

export const InstanceRemovedEventPayloadSchema = InstanceIdSchema;

export const InstanceStateUpdateEventPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  status: InstanceStatusSchema,
}).passthrough();

export const InstanceBatchUpdateEventPayloadSchema = z.object({
  updates: z.array(InstanceStateUpdateEventPayloadSchema),
  timestamp: z.number().int().nonnegative(),
}).passthrough();

export const InstanceYoloToggledEventPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  yoloMode: z.boolean(),
  pendingYoloMode: z.boolean().optional(),
}).strict();

export const InstanceFastToggledEventPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  fastMode: z.boolean(),
  reason: z.enum(['user', 'unavailable']).optional(),
}).strict();

// ─────────────────────────────────────────────────────────────────────────────
// Cross-model review + doom-loop + input-required renderer events
// ─────────────────────────────────────────────────────────────────────────────

export const CrossModelReviewStartedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
}).strict();

/** `cross-model-review:result` — AggregatedReview. The envelope is pinned;
 *  individual reviewer results are deep, versioned structures validated at
 *  parse time in the service, so they pass through loosely here. */
export const CrossModelReviewResultEventSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  outputType: z.enum(['code', 'plan', 'architecture']),
  reviewDepth: z.enum(['structured', 'tiered']),
  reviews: z.array(z.object({ reviewerId: z.string() }).passthrough()),
  localReviewer: z.unknown().optional(),
  hasDisagreement: z.boolean(),
  reviewStartedAt: z.number().optional(),
  timestamp: z.number(),
}).strict();

export const CrossModelReviewDiscardedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
  reason: z.string(),
}).strict();

export const CrossModelReviewAllUnavailableEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
}).strict();

export const CrossModelReviewReviewerUnavailableEventSchema = z.object({
  dropped: z.array(z.object({
    cli: z.string(),
    error: z.string().optional(),
  })),
}).strict();

export const CrossModelReviewReviewerRateLimitedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  cliType: z.string(),
}).strict();

export const CrossModelReviewReviewerRateLimitClearedEventSchema = z.object({
  cliType: z.string(),
}).strict();

export const InstanceDoomLoopEventSchema = z.object({
  instanceId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
  consecutiveCount: z.number().int(),
}).strict();

export const InstanceInputRequiredEventSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
  prompt: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
