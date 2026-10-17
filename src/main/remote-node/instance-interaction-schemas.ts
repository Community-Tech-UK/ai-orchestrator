import { z } from 'zod/v4';

export const InstanceSendRawParamsSchema = z.object({
  instanceId: z.string().min(1).max(200),
  response: z.string().max(1024 * 1024),
  permissionKey: z.string().min(1).max(512),
}).strict();
export const ProviderSessionSchema = z.object({ sessionId: z.string().min(1).max(512) });
export const NativeHistoryReplaySchema = z.object({
  sessionId: z.string().min(1).max(512),
  messages: z.array(z.object({ id: z.string().min(1).max(2000), timestamp: z.number().finite(),
    type: z.enum(['user', 'assistant']), content: z.string().max(32 * 1024 * 1024),
    metadata: z.object({ transport: z.literal('acp'), acpReplay: z.literal(true) }).strict(),
  }).strict()).max(10_000),
}).strict();
export const ProviderTurnSchema = z.object({ active: z.boolean(), activeToolCalls: z.boolean() }).strict().refine(value => !value.activeToolCalls || value.active);
export function interactionPayload(value: unknown, interactionId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  return envelope['interactionId'] === interactionId ? envelope['payload'] : undefined;
}
export const InputRequiredResolvedSchema = z.object({
  id: z.string().min(1).max(512), reason: z.enum(['timeout', 'auto_approved', 'decided', 'cancelled', 'exited']),
});
export const RemoteInputRequiredSchema = z.object({
  id: z.string().min(1).max(512), prompt: z.string().max(200_000), timestamp: z.number().finite().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(value => {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 512 * 1024; } catch { return false; }
});
const NativeCommandSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,100}$/), description: z.string().max(1000).optional() });
export type RemoteNativeCommand = z.infer<typeof NativeCommandSchema>;
export function boundedRemoteCommands(value: unknown): RemoteNativeCommand[] {
  return Array.isArray(value) ? value.slice(0, 128).flatMap(command => {
    const parsed = NativeCommandSchema.safeParse(command); return parsed.success ? [parsed.data] : [];
  }) : [];
}
export function inputNotPending(): Error {
  return Object.assign(new Error('No matching pending input request is waiting for a response.'), { code: 'INPUT_REQUIRED_NOT_PENDING' });
}
const ContextDetailsSchema = z.object({
  cumulativeTokens: z.number().finite().nonnegative().optional(), isEstimated: z.boolean().optional(),
  inputTokens: z.number().finite().nonnegative().optional(), outputTokens: z.number().finite().nonnegative().optional(),
  costEstimate: z.number().finite().nonnegative().optional(), source: z.string().max(100).optional(),
});
export function remoteContextDetails(value: unknown): z.infer<typeof ContextDetailsSchema> {
  const result = ContextDetailsSchema.safeParse(value); return result.success ? result.data : {};
}
