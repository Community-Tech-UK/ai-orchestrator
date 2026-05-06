import { z } from 'zod';

export const supportedProviderEnum = z.enum(['claude', 'codex', 'gemini', 'copilot']);
export const transportEnum = z.enum(['stdio', 'sse', 'http']);
export const orchestratorScopeEnum = z.enum([
  'orchestrator',
  'orchestrator-bootstrap',
  'orchestrator-codemem',
]);
export const providerScopeEnum = z.enum([
  'user',
  'project',
  'local',
  'workspace',
  'managed',
  'system',
]);
export const driftStateEnum = z.enum(['in-sync', 'drifted', 'missing', 'not-installed']);

const envRecordSchema = z.record(z.string(), z.string()).optional();
const headersRecordSchema = z.record(z.string(), z.string()).optional();

export const BaseMcpServerUpsertSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  transport: transportEnum,
  command: z.string().max(2000).optional(),
  args: z.array(z.string().max(1000)).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  headers: headersRecordSchema,
  env: envRecordSchema,
}).refine((value) => {
  if (value.id && value.transport !== 'stdio' && !value.url) {
    return true;
  }
  if (value.transport === 'stdio') return Boolean(value.command);
  return Boolean(value.url);
}, {
  message: 'stdio servers require command; http/sse servers require url',
});

export const OrchestratorMcpServerSchema = BaseMcpServerUpsertSchema.safeExtend({
  id: z.string().min(1).max(200),
  scope: orchestratorScopeEnum,
  envSecretsEncrypted: z.record(z.string(), z.string()).optional(),
  autoConnect: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const OrchestratorMcpServerUpsertSchema = BaseMcpServerUpsertSchema.safeExtend({
  scope: orchestratorScopeEnum.default('orchestrator'),
  autoConnect: z.boolean().optional(),
  injectInto: z.array(supportedProviderEnum).optional(),
});

export const SharedMcpServerUpsertSchema = BaseMcpServerUpsertSchema.safeExtend({
  targets: z.array(supportedProviderEnum).min(1),
});

export const McpDeletePayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
});

export const McpFanOutPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  providers: z.array(supportedProviderEnum).min(1).optional(),
});

export const McpResolveDriftPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  provider: supportedProviderEnum,
  action: z.enum(['overwrite-target', 'adopt-target', 'untrack-target']),
});

export const McpInjectionTargetsPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  providers: z.array(supportedProviderEnum),
});

export const McpProviderScopePayloadSchema = z.object({
  provider: supportedProviderEnum,
  scope: providerScopeEnum,
});

export const McpProviderUserUpsertPayloadSchema = BaseMcpServerUpsertSchema.safeExtend({
  provider: supportedProviderEnum,
});

export const McpProviderUserDeletePayloadSchema = z.object({
  provider: supportedProviderEnum,
  serverId: z.string().min(1).max(200),
});

export const McpDriftQuerySchema = z.object({
  serverId: z.string().min(1).max(200),
});
