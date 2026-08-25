import { z } from 'zod';

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

export const PermissionRecordBatchDecisionPayloadSchema = z.object({
  action: z.enum(['allow_all', 'deny_all']),
  scope: z.enum(['once', 'session', 'always']),
});

export const PermissionRecordDecisionPayloadSchema = z.object({
  requestId: z.string().min(1).max(200),
  action: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session', 'always']),
});

export const PermissionPatternPayloadSchema = z.object({
  patternId: z.string().min(1).max(200),
});

export const PermissionGetAuditLogPayloadSchema = z.object({
  instanceId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const BashValidatePayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

export const PermissionScopeSchema = z.enum([
  'file_read',
  'file_write',
  'file_delete',
  'directory_read',
  'directory_create',
  'directory_delete',
  'bash_execute',
  'bash_dangerous',
  'tool_use',
  'network_access',
  'subprocess_spawn',
  'environment_access',
  'secret_access',
  'git_operation',
  'external_service',
]);

export const PermissionAnalyzeShadowedRulesPayloadSchema = z.object({
  scope: PermissionScopeSchema.optional(),
});

export const BashCommandPayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

// ============ Workspace Secret Card ============
//
// The submit payload is the one place a plaintext credential legitimately crosses
// the IPC boundary. Its handler must never forward it to an adapter, a logger, or
// conversation history — see `secret.channels.ts` for why this lives on its own
// channel rather than on INPUT_REQUIRED_RESPOND.

/** Slug identifying a secret within a workspace (`github-pat`). */
export const SecretNameSchema = z.string().min(1).max(64);

export const SecretCardSubmitPayloadSchema = z.object({
  instanceId: z.string().min(1),
  requestId: z.string().min(1),
  name: SecretNameSchema,
  label: z.string().max(200).optional(),
  purpose: z.string().max(500).optional(),
  /**
   * The credential. Bounded generously — an RSA private key is legitimately long —
   * but bounded, so a runaway paste cannot be used to exhaust memory.
   */
  value: z.string().min(1).max(20_000),
});

export const SecretCardDeclinePayloadSchema = z.object({
  instanceId: z.string().min(1),
  requestId: z.string().min(1),
  name: SecretNameSchema,
  /** Optional short reason surfaced to the agent. Never a credential. */
  reason: z.string().max(500).optional(),
});

export const SecretCardListPayloadSchema = z.object({
  workingDirectory: z.string().min(1),
});

export const SecretCardForgetPayloadSchema = z.object({
  workingDirectory: z.string().min(1),
  name: SecretNameSchema,
});

export const SecretCardAuditPayloadSchema = z.object({
  workingDirectory: z.string().min(1),
  limit: z.number().int().min(1).max(1000).optional(),
});
