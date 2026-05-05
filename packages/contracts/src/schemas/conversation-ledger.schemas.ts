import { z } from 'zod';

export const ConversationProviderSchema = z.enum([
  'orchestrator',
  'codex',
  'claude',
  'gemini',
  'copilot',
  'unknown',
]);

export const ConversationSourceKindSchema = z.enum([
  'orchestrator',
  'provider-native',
  'imported-file',
  'history-archive',
]);

export const ConversationSyncStatusSchema = z.enum([
  'never-synced',
  'synced',
  'imported',
  'dirty',
  'conflict',
  'error',
]);

export const ConversationLedgerListPayloadSchema = z.object({
  provider: ConversationProviderSchema.optional(),
  workspacePath: z.string().min(1).optional(),
  sourceKind: ConversationSourceKindSchema.optional(),
  syncStatus: ConversationSyncStatusSchema.optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const ConversationLedgerThreadIdPayloadSchema = z.object({
  threadId: z.string().min(1),
});

export const ConversationLedgerDiscoverPayloadSchema = z.object({
  provider: ConversationProviderSchema.optional(),
  workspacePath: z.string().min(1).optional(),
  sourceKinds: z.array(z.string().min(1)).optional(),
  includeChildThreads: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const ConversationLedgerStartCommonPayloadSchema = {
  model: z.string().min(1).nullable().optional(),
  title: z.string().min(1).nullable().optional(),
  ephemeral: z.boolean().optional(),
  approvalPolicy: z.string().min(1).nullable().optional(),
  sandbox: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  personality: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const ConversationLedgerStartPayloadSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('codex'),
    workspacePath: z.string().min(1),
    ...ConversationLedgerStartCommonPayloadSchema,
  }),
  z.object({
    provider: z.literal('orchestrator'),
    workspacePath: z.string().min(1).nullable().optional(),
    ...ConversationLedgerStartCommonPayloadSchema,
  }),
]);

export const ConversationInputItemSchema = z.object({
  type: z.enum(['text', 'image', 'localImage', 'skill', 'mention']),
  text: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
});

export const ConversationLedgerSendTurnPayloadSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().min(1),
  inputItems: z.array(ConversationInputItemSchema).optional(),
  model: z.string().min(1).nullable().optional(),
  approvalPolicy: z.string().min(1).nullable().optional(),
  sandbox: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ConversationLedgerListPayload = z.infer<typeof ConversationLedgerListPayloadSchema>;
export type ConversationLedgerDiscoverPayload = z.infer<typeof ConversationLedgerDiscoverPayloadSchema>;
export type ConversationLedgerStartPayload = z.infer<typeof ConversationLedgerStartPayloadSchema>;
export type ConversationLedgerSendTurnPayload = z.infer<typeof ConversationLedgerSendTurnPayloadSchema>;
