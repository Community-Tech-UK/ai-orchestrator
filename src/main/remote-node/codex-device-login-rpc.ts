import { z } from 'zod/v4';
import { PROVIDER_ACCOUNT_PROFILE_ID_PATTERN, LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';

const id = z.string().min(1).max(200);
export const CodexDeviceLoginPolicySchema = z.object({ enabled: z.literal(true), expectedIdentity: z.email().max(320) }).strict();
export const CodexDeviceLoginOwnerSchema = z.object({ sessionId: id, generation: id }).strict();
export const CodexDeviceLoginBindingSchema = z.object({
  browserNodeId: id, profileId: id, targetId: id, origin: z.literal('https://auth.openai.com'),
  documentId: id, extensionInstanceId: id, extensionGeneration: id, approvalId: id, expectedIdentity: z.email().max(320),
}).strict();
export const CodexDeviceLoginStartParamsSchema = z.object({
  profileId: z.string().regex(PROVIDER_ACCOUNT_PROFILE_ID_PATTERN).refine(value => value !== LEGACY_ACCOUNT_PROFILE_ID),
  owner: CodexDeviceLoginOwnerSchema,
}).strict();
export const CodexDeviceLoginOwnedParamsSchema = z.object({ handle: z.uuid(), owner: CodexDeviceLoginOwnerSchema }).strict();
export const CodexDeviceLoginHandoffParamsSchema = CodexDeviceLoginOwnedParamsSchema.extend({
  binding: CodexDeviceLoginBindingSchema, transferId: z.uuid(),
}).strict();
/** Private socket route only. Never format validation issues or expose this object through a tool. */
export const CodexDeviceLoginDeliverParamsSchema = CodexDeviceLoginHandoffParamsSchema.extend({
  expiresAt: z.number().int().positive(), code: z.string().regex(/^[A-Z0-9-]{4,64}$/),
}).strict();
export const CodexDeviceLoginDeliverAckSchema = z.object({ delivered: z.literal(true) }).strict();
export const CodexDeviceLoginViewSchema = z.object({
  handle: z.uuid(), profileId: id, provider: z.literal('codex'), nodeId: id, expectedIdentity: z.email().max(320),
  expiresAt: z.number().int().positive(),
  state: z.enum(['starting', 'awaiting_handoff', 'reserved', 'delivering', 'awaiting_login', 'verifying', 'authenticated', 'failed', 'cancelled', 'expired']),
  error: z.enum(['operation_expired', 'unsupported_login_output', 'login_stream_failed', 'login_process_failed',
    'unapproved_completion', 'handoff_failed', 'login_output_limit', 'identity_mismatch', 'identity_probe_failed', 'login_cleanup_failed']).optional(),
}).strict();
export type CodexDeviceLoginPolicy = z.infer<typeof CodexDeviceLoginPolicySchema>;
export type CodexDeviceLoginOwner = z.infer<typeof CodexDeviceLoginOwnerSchema>;
export type CodexDeviceLoginBinding = z.infer<typeof CodexDeviceLoginBindingSchema>;
export type CodexDeviceLoginStartParams = z.infer<typeof CodexDeviceLoginStartParamsSchema>;
export type CodexDeviceLoginOwnedParams = z.infer<typeof CodexDeviceLoginOwnedParamsSchema>;
export type CodexDeviceLoginHandoffParams = z.infer<typeof CodexDeviceLoginHandoffParamsSchema>;
export type CodexDeviceLoginDeliverParams = z.infer<typeof CodexDeviceLoginDeliverParamsSchema>;
export type CodexDeviceLoginDeliverAck = z.infer<typeof CodexDeviceLoginDeliverAckSchema>;
export type CodexDeviceLoginView = z.infer<typeof CodexDeviceLoginViewSchema>;
