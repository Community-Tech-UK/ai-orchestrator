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
  'instance.output',
  'instance.stateChanged',
  'verification.started',
  'verification.completed',
  'verification.error',
  'orchestration.debate.round',
  'orchestration.consensus.vote',
  'tool.execute.before',
  'tool.execute.after',
  'session.created',
  'session.resumed',
  'session.compacting',
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
  'instance.output': HookInstanceOutputSchema,
  'instance.stateChanged': HookInstanceStateChangedSchema,
  'verification.started': HookVerificationStartedSchema,
  'verification.completed': HookVerificationCompletedSchema,
  'verification.error': HookVerificationErrorSchema,
  'tool.execute.before': HookToolExecuteBeforeSchema,
  'tool.execute.after': HookToolExecuteAfterSchema,
  'session.created': HookSessionCreatedSchema,
  'session.resumed': HookSessionResumedSchema,
  'session.compacting': HookSessionCompactingSchema,
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
