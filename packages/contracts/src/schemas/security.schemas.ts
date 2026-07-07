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

export const BashCommandPayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});
