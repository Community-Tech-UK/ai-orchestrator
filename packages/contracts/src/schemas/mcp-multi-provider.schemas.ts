import { z } from 'zod';

export const supportedProviderEnum = z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'grok', 'opencode']);
export const injectionProviderEnum = z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor', 'grok', 'opencode']);
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

const envRecordSchema = z.record(z.string(), z.string()).optional();
const headersRecordSchema = z.record(z.string(), z.string()).optional();

const baseMcpServerShape = {
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  transport: transportEnum,
  command: z.string().max(2000).optional(),
  args: z.array(z.string().max(1000)).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  headers: headersRecordSchema,
  env: envRecordSchema,
};

export const BaseMcpServerUpsertSchema = z.object(baseMcpServerShape).refine((value) => {
  if (value.id && value.transport !== 'stdio' && !value.url) {
    return true;
  }
  if (value.transport === 'stdio') return Boolean(value.command);
  return Boolean(value.url);
}, {
  message: 'stdio servers require command; http/sse servers require url',
});

const connectorFields = {
  kind: z.enum(['local', 'remote', 'microsoft365']).optional(),
  authType: z.enum(['none', 'bearer', 'oauth']).optional(),
  clientMetadataUrl: z.string().url().max(2000).refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS address for the client metadata document.').optional(),
  accountId: z.string().min(1).max(300).optional(),
  mailEnabled: z.boolean().optional(),
};

function validConnector(value: { kind?: string; transport: string; accountId?: string; command?: string; id?: string; url?: string }): boolean {
  if (value.kind === 'microsoft365') return value.transport === 'stdio' && Boolean(value.accountId);
  if (value.kind === 'remote' && value.transport === 'stdio') return false;
  if (value.transport === 'stdio') return Boolean(value.command);
  return Boolean(value.url || value.id);
}

export const OrchestratorMcpServerSchema = z.object({
  ...baseMcpServerShape,
  ...connectorFields,
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use up to 64 letters, numbers or hyphens for the connector name.'),
  id: z.string().min(1).max(200),
  scope: orchestratorScopeEnum,
  envSecretsEncrypted: z.record(z.string(), z.string()).optional(),
  autoConnect: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).refine(validConnector, { message: 'Choose an account, program, or server address for this connector.' });

export const OrchestratorMcpServerUpsertSchema = z.object({
  ...baseMcpServerShape,
  ...connectorFields,
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use up to 64 letters, numbers or hyphens for the connector name.'),
  scope: orchestratorScopeEnum.default('orchestrator'),
  autoConnect: z.boolean().optional(),
  injectInto: z.array(injectionProviderEnum).optional(),
}).refine(validConnector, { message: 'Choose an account, program, or server address for this connector.' });

export const McpDeletePayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
});

export const McpConnectorAuthPayloadSchema = z.discriminatedUnion('action', [
  z.object({ serverId: z.string().min(1).max(200), action: z.literal('set-bearer'), bearerToken: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ serverId: z.string().min(1).max(200), action: z.enum(['sign-in', 'sign-out', 'test']) }).strict(),
]);

export const McpConnectorAddMicrosoft365Schema = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use up to 64 letters, numbers or hyphens for the connector name.'),
  mailEnabled: z.boolean().default(false),
  injectInto: z.array(injectionProviderEnum).optional(),
}).strict();

export const McpConnectorSetWritableSchema = z.object({
  serverId: z.string().min(1).max(200),
  allowed: z.boolean(),
}).strict();

export const McpInjectionTargetsPayloadSchema = z.object({
  serverId: z.string().min(1).max(200),
  providers: z.array(injectionProviderEnum),
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

export const WorkspaceMcpConnectorListSchema = z.object({
  workingDirectory: z.string().min(1).max(2000),
  provider: supportedProviderEnum.optional(),
});

export const WorkspaceMcpConnectorUpsertSchema = BaseMcpServerUpsertSchema.safeExtend({
  workingDirectory: z.string().min(1).max(2000),
  provider: supportedProviderEnum,
});

export const WorkspaceMcpConnectorDeleteSchema = z.object({
  id: z.string().min(1).max(200),
});


// ─────────────────────────────────────────────────────────────────────────────
// Renderer event payloads (main → renderer `mcp:*` pushes)
// ─────────────────────────────────────────────────────────────────────────────

/** RedactedMcpServerDto — scope is a wider union than the upsert enums
 *  (provider scopes included), so it stays a plain string here. */
const RedactedMcpServerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
  transport: transportEnum,
  autoConnect: z.boolean(),
  readOnly: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).passthrough();

/** `mcp:multi-provider-state-changed` — McpMultiProviderStateDto. */
export const McpMultiProviderStateChangedEventSchema = z.object({
  orchestrator: z.array(z.object({
    record: RedactedMcpServerDtoSchema,
    injectInto: z.array(injectionProviderEnum),
  }).passthrough()),
  providers: z.array(z.object({
    provider: supportedProviderEnum,
    cliAvailable: z.boolean(),
    servers: z.array(RedactedMcpServerDtoSchema),
  }).passthrough()),
  stateVersion: z.number(),
}).strict();

/** `mcp:server-status-changed`; the phase-lifecycle variant adds
 *  phase/phaseState, and `error` carries a caught unknown. */
export const McpServerStatusChangedEventSchema = z.object({
  serverId: z.string(),
  status: z.enum(['connected', 'disconnected', 'connecting', 'error']),
  error: z.unknown().optional(),
  phase: z.string().optional(),
  phaseState: z.enum(['running', 'succeeded', 'failed']).optional(),
}).strict();

export const McpStateChangedEventSchema = z.object({
  type: z.enum(['tools', 'resources', 'prompts']),
}).strict();
