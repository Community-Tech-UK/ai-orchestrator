import { z } from 'zod';

export const RemoteNodeSetTokenPayloadSchema = z.object({
  token: z.string().min(16).max(256),
});

export const RemoteNodeIssuePairingPayloadSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  ttlMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000).optional(),
});

export const RemoteNodeRevokePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeRevokePairingPayloadSchema = z.object({
  token: z.string().min(1).max(256),
});

export const RemoteNodeGetPayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeStartServerPayloadSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).optional(),
    host: z.string().min(1).max(255).optional(),
  })
  .optional();

export const RemoteNodeServiceActionPayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeProviderDiagnosePayloadSchema = z.object({
  nodeId: z.string().uuid(),
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']),
});

export const RemoteNodeBrowserAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  profileDir: z.string().trim().min(1).max(1024).optional(),
  headless: z.boolean().optional(),
  chromePath: z.string().trim().min(1).max(1024).optional(),
  remoteDebuggingPort: z.number().int().min(1).max(65535).optional(),
});

export const RemoteNodeUpdateBrowserAutomationPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  browserAutomation: RemoteNodeBrowserAutomationConfigSchema,
});

export const RemoteNodeRunBrowserLoginPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  url: z.string().trim().max(2048).optional(),
});

export type ValidatedSetTokenPayload = z.infer<typeof RemoteNodeSetTokenPayloadSchema>;
export type ValidatedIssuePairingPayload = z.infer<typeof RemoteNodeIssuePairingPayloadSchema>;
export type ValidatedRevokePayload = z.infer<typeof RemoteNodeRevokePayloadSchema>;
export type ValidatedRevokePairingPayload = z.infer<typeof RemoteNodeRevokePairingPayloadSchema>;
export type ValidatedGetPayload = z.infer<typeof RemoteNodeGetPayloadSchema>;
export type ValidatedStartServerPayload = z.infer<typeof RemoteNodeStartServerPayloadSchema>;
export type ValidatedServiceActionPayload = z.infer<typeof RemoteNodeServiceActionPayloadSchema>;
export type ValidatedProviderDiagnosePayload = z.infer<typeof RemoteNodeProviderDiagnosePayloadSchema>;
