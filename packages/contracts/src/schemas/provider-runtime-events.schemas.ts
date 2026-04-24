import { z } from 'zod';

export const ProviderNameSchema = z.enum(['claude', 'codex', 'gemini', 'copilot', 'anthropic-api', 'cursor']);

const ProviderRuntimeAttachmentSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
  data: z.string(),
});

const ProviderRuntimeThinkingContentSchema = z.object({
  id: z.string(),
  content: z.string(),
  format: z.enum(['structured', 'xml', 'bracket', 'header', 'sdk', 'unknown']),
  timestamp: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
});

const ProviderOutputEventSchema = z.object({
  kind: z.literal('output'),
  content: z.string(),
  messageType: z.string().optional(),
  messageId: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(ProviderRuntimeAttachmentSchema).optional(),
  thinking: z.array(ProviderRuntimeThinkingContentSchema).optional(),
  thinkingExtracted: z.boolean().optional(),
});

const ProviderToolUseEventSchema = z.object({
  kind: z.literal('tool_use'),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const ProviderToolResultEventSchema = z.object({
  kind: z.literal('tool_result'),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  output: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});

const ProviderStatusEventSchema = z.object({
  kind: z.literal('status'),
  status: z.string(),
});

const ProviderContextEventSchema = z.object({
  kind: z.literal('context'),
  used: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percentage: z.number().optional(),
});

const ProviderErrorEventSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  recoverable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ProviderExitEventSchema = z.object({
  kind: z.literal('exit'),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});

const ProviderSpawnedEventSchema = z.object({
  kind: z.literal('spawned'),
  pid: z.number().int().nonnegative(),
});

const ProviderCompleteEventSchema = z.object({
  kind: z.literal('complete'),
  tokensUsed: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const ProviderRuntimeEventSchema = z.discriminatedUnion('kind', [
  ProviderOutputEventSchema,
  ProviderToolUseEventSchema,
  ProviderToolResultEventSchema,
  ProviderStatusEventSchema,
  ProviderContextEventSchema,
  ProviderErrorEventSchema,
  ProviderExitEventSchema,
  ProviderSpawnedEventSchema,
  ProviderCompleteEventSchema,
]);

export const ProviderRuntimeEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  provider: ProviderNameSchema,
  instanceId: z.string().min(1),
  sessionId: z.string().optional(),
  adapterGeneration: z.number().int().nonnegative().optional(),
  turnId: z.string().optional(),
  event: ProviderRuntimeEventSchema,
});
