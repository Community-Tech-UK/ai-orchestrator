import { z } from 'zod';
import { FileAttachmentSchema } from './common.schemas';

export const ChatProviderSchema = z.enum(['claude', 'codex', 'gemini', 'copilot']);
export const ChatReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow']);
const ChatFileAttachmentSchema = FileAttachmentSchema.extend({
  data: z.string(),
});
const ChatIdStringSchema = z.string().min(1).max(200);

export const ChatListPayloadSchema = z.object({
  includeArchived: z.boolean().optional(),
}).optional();

export const ChatIdPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
});

export const ChatCreatePayloadSchema = z.object({
  name: z.string().max(160).optional(),
  provider: ChatProviderSchema,
  model: z.string().max(160).nullable().optional(),
  reasoningEffort: ChatReasoningEffortSchema.nullable().optional(),
  currentCwd: z.string().min(1).max(4096),
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
  model: z.string().min(1).max(160).nullable(),
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
