/**
 * Plugin & Skill Contract Schemas
 *
 * Zod schemas for plugin manifests, skill frontmatter, and hook payloads.
 * Replaces hand-rolled validation in plugin-manager.ts and skill-loader.ts
 * with schema-based parsing that provides actionable error messages.
 *
 * @module @contracts/schemas/plugin
 */

import { z } from 'zod';

// ============================================
// Plugin Manifest Schema
// ============================================

/**
 * All valid plugin hook event names.
 */
export const PluginHookEventSchema = z.enum([
  'instance.created',
  'instance.removed',
  'instance.spawn.before',
  'instance.spawn.after',
  'instance.input.before',
  'instance.input.after',
  'instance.output',
  'instance.stateChanged',
  'verification.started',
  'verification.completed',
  'verification.error',
  'orchestration.debate.round',
  'orchestration.consensus.vote',
  'orchestration.command.received',
  'orchestration.command.completed',
  'orchestration.command.failed',
  'orchestration.child.started',
  'orchestration.child.progress',
  'orchestration.child.completed',
  'orchestration.child.failed',
  'orchestration.child.result.reported',
  'orchestration.consensus.started',
  'orchestration.consensus.completed',
  'orchestration.consensus.failed',
  'tool.execute.before',
  'tool.execute.after',
  'session.created',
  'session.resumed',
  'session.compacting',
  'session.archived',
  'session.terminated',
  'automation.run.started',
  'automation.run.completed',
  'automation.run.failed',
  'cleanup.candidate.before',
  'cleanup.candidate.after',
  'permission.ask',
  'config.loaded',
]);

export type PluginHookEvent = z.infer<typeof PluginHookEventSchema>;

export const PluginSlotSchema = z.enum([
  'provider',
  'channel',
  'mcp',
  'skill',
  'hook',
  'tracker',
  'notifier',
  'telemetry_exporter',
]);

export type PluginSlot = z.infer<typeof PluginSlotSchema>;

/**
 * Plugin manifest schema — validates plugin.json files.
 */
export const PluginManifestSchema = z.object({
  name: z.string()
    .min(1, 'Plugin name is required')
    .max(200, 'Plugin name must be 200 characters or fewer'),
  version: z.string()
    .min(1, 'Plugin version is required')
    .regex(/^\d+\.\d+\.\d+/, 'Plugin version must be semver (e.g., 1.0.0)'),
  description: z.string().max(2000).optional(),
  author: z.string().max(200).optional(),
  slot: PluginSlotSchema.optional(),
  hooks: z.array(PluginHookEventSchema).optional(),
  config: z.object({
    schema: z.record(z.string(), z.unknown()),
  }).optional(),
});

export type ValidatedPluginManifest = z.infer<typeof PluginManifestSchema>;

// ============================================
// Skill Frontmatter Schema
// ============================================

/**
 * Skill frontmatter schema — validates YAML frontmatter in skill files.
 * Replaces the hand-rolled parseSkillFrontmatter() in skill.types.ts.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string()
    .min(1, 'Skill name is required')
    .max(200, 'Skill name must be 200 characters or fewer'),
  description: z.string()
    .min(1, 'Skill description is required')
    .max(5000, 'Skill description must be 5000 characters or fewer'),
  version: z.string().max(50).optional(),
  author: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(50).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  preferredModel: z.string().max(100).optional(),
  triggers: z.array(z.string().max(200)).max(50).optional(),
});

export type ValidatedSkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ============================================
// Hook Payload Schemas
// ============================================

/** Base payload with instanceId — shared by most hooks. */
const InstanceIdPayload = z.object({
  instanceId: z.string().min(1).max(200),
});

export const HookInstanceCreatedSchema = InstanceIdPayload.extend({
  id: z.string().min(1).max(200),
  workingDirectory: z.string().max(2000),
  provider: z.string().max(100).optional(),
});

export const HookInstanceRemovedSchema = InstanceIdPayload;

const HookRoutingAuditSchema = z.object({
  requestedProvider: z.string().max(100).optional(),
  requestedModel: z.string().max(200).optional(),
  actualProvider: z.string().max(100).optional(),
  actualModel: z.string().max(200).optional(),
  routingSource: z.enum(['explicit', 'parent', 'agent', 'settings', 'auto']),
  reason: z.string().max(2000).optional(),
});

export const HookInstanceSpawnBeforeSchema = z.object({
  instanceId: z.string().min(1).max(200).optional(),
  parentId: z.string().max(200).nullable().optional(),
  displayName: z.string().max(200).optional(),
  workingDirectory: z.string().max(2000),
  requestedProvider: z.string().max(100).optional(),
  requestedModel: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  config: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

export const HookInstanceSpawnAfterSchema = InstanceIdPayload.extend({
  parentId: z.string().max(200).nullable(),
  displayName: z.string().max(200),
  workingDirectory: z.string().max(2000),
  requestedProvider: z.string().max(100).optional(),
  requestedModel: z.string().max(200).optional(),
  actualProvider: z.string().max(100).optional(),
  actualModel: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  success: z.boolean(),
  error: z.string().max(5000).optional(),
  timestamp: z.number(),
});

export const HookInstanceInputBeforeSchema = InstanceIdPayload.extend({
  messageLength: z.number().int().min(0),
  messagePreview: z.string().max(500),
  attachmentCount: z.number().int().min(0),
  isRetry: z.boolean().optional(),
  autoContinuation: z.boolean().optional(),
  timestamp: z.number(),
});

export const HookInstanceInputAfterSchema = InstanceIdPayload.extend({
  messageLength: z.number().int().min(0),
  attachmentCount: z.number().int().min(0),
  success: z.boolean(),
  error: z.string().max(5000).optional(),
  timestamp: z.number(),
});

export const HookInstanceOutputSchema = InstanceIdPayload.extend({
  message: z.object({
    id: z.string(),
    timestamp: z.number(),
    type: z.enum(['assistant', 'user', 'system', 'tool_use', 'tool_result', 'error']),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const HookInstanceStateChangedSchema = InstanceIdPayload.extend({
  previousState: z.string(),
  newState: z.string(),
  timestamp: z.number(),
});

export const HookVerificationStartedSchema = InstanceIdPayload.extend({
  id: z.string(),
  verificationId: z.string(),
});

export const HookVerificationCompletedSchema = InstanceIdPayload.extend({
  id: z.string(),
  verificationId: z.string(),
  fromCache: z.boolean().optional(),
});

export const HookVerificationErrorSchema = z.object({
  request: z.object({
    id: z.string().optional(),
    instanceId: z.string().optional(),
  }).passthrough(),
  error: z.unknown(),
  verificationId: z.string(),
  instanceId: z.string(),
});

export const HookToolExecuteBeforeSchema = InstanceIdPayload.extend({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  skip: z.boolean().optional(),
});

export const HookToolExecuteAfterSchema = InstanceIdPayload.extend({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  durationMs: z.number(),
});

export const HookOrchestrationCommandSchema = InstanceIdPayload.extend({
  action: z.string().min(1).max(100),
  command: z.record(z.string(), z.unknown()).optional(),
  data: z.unknown().optional(),
  error: z.string().max(5000).optional(),
  timestamp: z.number(),
});

const HookChildResultSchema = z.object({
  parentId: z.string().min(1).max(200),
  childId: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  success: z.boolean().optional(),
  summary: z.string().max(20000).optional(),
  resultId: z.string().max(200).optional(),
  exitCode: z.number().nullable().optional(),
  error: z.string().max(5000).optional(),
  artifactCount: z.number().int().min(0).optional(),
  timestamp: z.number(),
});

export const HookChildStartedSchema = z.object({
  parentId: z.string().min(1).max(200),
  childId: z.string().min(1).max(200),
  task: z.string().min(1).max(100000),
  name: z.string().max(200).optional(),
  routing: HookRoutingAuditSchema.optional(),
  timestamp: z.number(),
});

export const HookChildProgressSchema = z.object({
  parentId: z.string().min(1).max(200),
  childId: z.string().min(1).max(200),
  percentage: z.number().min(0).max(100),
  currentStep: z.string().max(2000),
  timestamp: z.number(),
});

export const HookConsensusStartedSchema = InstanceIdPayload.extend({
  question: z.string().min(1).max(100000),
  providers: z.array(z.string().max(100)).optional(),
  strategy: z.string().max(50).optional(),
  timestamp: z.number(),
});

export const HookConsensusCompletedSchema = InstanceIdPayload.extend({
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  totalDurationMs: z.number().min(0),
  timestamp: z.number(),
});

export const HookConsensusFailedSchema = InstanceIdPayload.extend({
  error: z.string().max(5000),
  timestamp: z.number(),
});

export const HookSessionCreatedSchema = InstanceIdPayload.extend({
  sessionId: z.string(),
});

export const HookSessionResumedSchema = InstanceIdPayload.extend({
  sessionId: z.string(),
});

export const HookSessionCompactingSchema = InstanceIdPayload.extend({
  messageCount: z.number().int(),
  tokenCount: z.number().int(),
});

export const HookSessionArchivedSchema = InstanceIdPayload.extend({
  historyThreadId: z.string().max(200).optional(),
  providerSessionId: z.string().max(500).optional(),
  messageCount: z.number().int().min(0),
  timestamp: z.number(),
});

export const HookSessionTerminatedSchema = InstanceIdPayload.extend({
  parentId: z.string().max(200).nullable().optional(),
  graceful: z.boolean(),
  timestamp: z.number(),
});

const HookAutomationRunSchema = z.object({
  automationId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  trigger: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  deliveryMode: z.enum(['notify', 'silent', 'localOnly']).optional(),
  outputSummary: z.string().max(10000).optional(),
  outputFullRef: z.string().max(2000).optional(),
  error: z.string().max(5000).optional(),
  timestamp: z.number(),
});

const HookCleanupCandidateSchema = z.object({
  artifactId: z.string().min(1).max(200),
  path: z.string().min(1).max(4000),
  reason: z.string().min(1).max(2000),
  removed: z.boolean().optional(),
  error: z.string().max(5000).optional(),
  dryRun: z.boolean(),
  timestamp: z.number(),
});

export const HookPermissionAskSchema = InstanceIdPayload.extend({
  toolName: z.string(),
  command: z.string().optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});

export const HookConfigLoadedSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

/**
 * Map of hook event name to its Zod schema.
 * Use this for runtime validation of plugin hook payloads.
 */
export const HookPayloadSchemas = {
  'instance.created': HookInstanceCreatedSchema,
  'instance.removed': HookInstanceRemovedSchema,
  'instance.spawn.before': HookInstanceSpawnBeforeSchema,
  'instance.spawn.after': HookInstanceSpawnAfterSchema,
  'instance.input.before': HookInstanceInputBeforeSchema,
  'instance.input.after': HookInstanceInputAfterSchema,
  'instance.output': HookInstanceOutputSchema,
  'instance.stateChanged': HookInstanceStateChangedSchema,
  'verification.started': HookVerificationStartedSchema,
  'verification.completed': HookVerificationCompletedSchema,
  'verification.error': HookVerificationErrorSchema,
  'orchestration.debate.round': z.object({
    debateId: z.string(),
    round: z.number(),
    totalRounds: z.number(),
    participantId: z.string(),
    response: z.string(),
  }),
  'orchestration.consensus.vote': z.object({
    consensusId: z.string(),
    voterId: z.string(),
    vote: z.string(),
    confidence: z.number(),
  }),
  'orchestration.command.received': HookOrchestrationCommandSchema.required({ command: true }),
  'orchestration.command.completed': HookOrchestrationCommandSchema.omit({ command: true, error: true }),
  'orchestration.command.failed': HookOrchestrationCommandSchema.omit({ command: true }),
  'orchestration.child.started': HookChildStartedSchema,
  'orchestration.child.progress': HookChildProgressSchema,
  'orchestration.child.completed': HookChildResultSchema,
  'orchestration.child.failed': HookChildResultSchema,
  'orchestration.child.result.reported': HookChildResultSchema,
  'orchestration.consensus.started': HookConsensusStartedSchema,
  'orchestration.consensus.completed': HookConsensusCompletedSchema,
  'orchestration.consensus.failed': HookConsensusFailedSchema,
  'tool.execute.before': HookToolExecuteBeforeSchema,
  'tool.execute.after': HookToolExecuteAfterSchema,
  'session.created': HookSessionCreatedSchema,
  'session.resumed': HookSessionResumedSchema,
  'session.compacting': HookSessionCompactingSchema,
  'session.archived': HookSessionArchivedSchema,
  'session.terminated': HookSessionTerminatedSchema,
  'automation.run.started': HookAutomationRunSchema.required({ trigger: true }),
  'automation.run.completed': HookAutomationRunSchema.required({ status: true }),
  'automation.run.failed': HookAutomationRunSchema.required({ error: true }),
  'cleanup.candidate.before': HookCleanupCandidateSchema.omit({ removed: true, error: true }),
  'cleanup.candidate.after': HookCleanupCandidateSchema.required({ removed: true }),
  'permission.ask': HookPermissionAskSchema,
  'config.loaded': HookConfigLoadedSchema,
} as const;

export type HookEventName = keyof typeof HookPayloadSchemas;

/**
 * Validate a hook payload against its schema.
 * Returns the validated payload or throws a ZodError with actionable messages.
 */
export function validateHookPayload(
  event: HookEventName,
  payload: unknown,
): unknown {
  const schema = HookPayloadSchemas[event];
  return schema.parse(payload);
}
