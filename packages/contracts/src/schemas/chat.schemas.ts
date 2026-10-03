import { z } from 'zod';
import {
  FileAttachmentSchema,
  ModelIdSchema,
  RequiredModelIdSchema,
} from './common.schemas';

export const ChatProviderSchema = z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot']);
export const ChatReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'workflow']);
const ChatFileAttachmentSchema = FileAttachmentSchema.extend({
  data: z.string(),
});
const ChatIdStringSchema = z.string().min(1).max(200);

// ── Session-linked sidechats ──────────────────────────────────────────────────

/**
 * Wider than `ChatProviderSchema`: sidechats can target any session provider
 * with a working conversation runtime, including Cursor, Grok, OpenCode and
 * local models. Do not narrow this to the five-name chat schema.
 */
export const SideChatProviderSchema = z.enum([
  'claude', 'codex', 'gemini', 'antigravity', 'copilot',
  'cursor', 'grok', 'opencode', 'local-model',
]);

export const SideChatParentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), chatId: ChatIdStringSchema }),
  z.object({
    kind: z.literal('session'),
    historyThreadId: z.string().min(1).max(400),
    originNodeId: z.string().max(200).nullable(),
  }),
]);

export const ModelRuntimeTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cli'), provider: z.string().max(60).optional() }),
  z.object({
    kind: z.literal('local-model'),
    source: z.enum(['this-device', 'worker-node']),
    endpointProvider: z.enum(['ollama', 'openai-compatible']),
    endpointId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
    selectorId: z.string().min(1).max(200),
    nodeId: z.string().max(200).optional(),
    nodeName: z.string().max(200).optional(),
  }),
]);

export const SideChatCreatePayloadSchema = z.object({
  parent: SideChatParentRefSchema,
  name: z.string().max(160).optional(),
  selection: z.object({
    provider: SideChatProviderSchema,
    model: ModelIdSchema.nullable().optional(),
    reasoning: ChatReasoningEffortSchema.nullable().optional(),
    modelRuntimeTarget: ModelRuntimeTargetSchema.nullable().optional(),
  }),
  currentCwd: z.string().min(1).max(4096),
});

export const SideChatListPayloadSchema = z.object({
  parent: SideChatParentRefSchema,
});

export const SideChatMarkReadPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  throughSequence: z.number().int().nonnegative(),
});

export const SideChatSendPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  text: z.string().min(1).max(500000),
  allowStaleContext: z.boolean().optional(),
});

export type SideChatProvider = z.infer<typeof SideChatProviderSchema>;
export type SideChatParentRef = z.infer<typeof SideChatParentRefSchema>;
export type ModelRuntimeTargetPayload = z.infer<typeof ModelRuntimeTargetSchema>;
export type SideChatCreatePayload = z.infer<typeof SideChatCreatePayloadSchema>;
export type SideChatListPayload = z.infer<typeof SideChatListPayloadSchema>;
export type SideChatMarkReadPayload = z.infer<typeof SideChatMarkReadPayloadSchema>;
export type SideChatSendPayload = z.infer<typeof SideChatSendPayloadSchema>;

export const ChatListPayloadSchema = z.object({
  includeArchived: z.boolean().optional(),
}).optional();

export const ChatIdPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
});

export const ChatDeletePayloadSchema = ChatIdPayloadSchema.extend({
  confirmation: z.literal('delete'),
});

export const ChatCreatePayloadSchema = z.object({
  name: z.string().max(160).optional(),
  provider: ChatProviderSchema,
  model: ModelIdSchema.nullable().optional(),
  reasoningEffort: ChatReasoningEffortSchema.nullable().optional(),
  currentCwd: z.string().min(1).max(4096),
  parentChatId: ChatIdStringSchema.optional(),
  yolo: z.boolean().optional(),
});

export const ChatRenamePayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  name: z.string().min(1).max(160),
});

export const ChatSetCwdPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  cwd: z.string().min(1).max(4096),
});

export const ChatSetProviderPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  provider: ChatProviderSchema,
});

export const ChatSetModelPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  model: RequiredModelIdSchema.nullable(),
});

export const ChatSetReasoningPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  reasoningEffort: ChatReasoningEffortSchema.nullable(),
});

export const ChatSetYoloPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  yolo: z.boolean(),
});

export const ChatLoadOlderMessagesPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  beforeSequence: z.number().int().positive(),
  limit: z.number().int().positive().max(500).optional(),
});

export const ChatSendMessagePayloadSchema = z.object({
  chatId: ChatIdStringSchema,
  text: z.string().min(1).max(500000),
  attachments: z.array(ChatFileAttachmentSchema).max(10).optional(),
});

export const ChatUiStatePayloadSchema = z.object({
  selectedChatId: ChatIdStringSchema.nullable(),
  openChatIds: z.array(ChatIdStringSchema).max(20),
});

export type ChatListPayload = z.infer<typeof ChatListPayloadSchema>;
export type ChatIdPayload = z.infer<typeof ChatIdPayloadSchema>;
export type ChatDeletePayload = z.infer<typeof ChatDeletePayloadSchema>;
export type ChatCreatePayload = z.infer<typeof ChatCreatePayloadSchema>;
export type ChatRenamePayload = z.infer<typeof ChatRenamePayloadSchema>;
export type ChatSetCwdPayload = z.infer<typeof ChatSetCwdPayloadSchema>;
export type ChatSetProviderPayload = z.infer<typeof ChatSetProviderPayloadSchema>;
export type ChatSetModelPayload = z.infer<typeof ChatSetModelPayloadSchema>;
export type ChatSetReasoningPayload = z.infer<typeof ChatSetReasoningPayloadSchema>;
export type ChatSetYoloPayload = z.infer<typeof ChatSetYoloPayloadSchema>;
export type ChatLoadOlderMessagesPayload = z.infer<typeof ChatLoadOlderMessagesPayloadSchema>;
export type ChatSendMessagePayload = z.infer<typeof ChatSendMessagePayloadSchema>;
export type ChatUiStatePayload = z.infer<typeof ChatUiStatePayloadSchema>;
