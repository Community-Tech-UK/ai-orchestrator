import { z } from 'zod';
import { FileAttachmentSchema } from './common.schemas';

export const ChatProviderSchema = z.enum(['claude', 'codex', 'gemini', 'copilot']);
const ChatFileAttachmentSchema = FileAttachmentSchema.extend({
  data: z.string(),
});

export const ChatListPayloadSchema = z.object({
  includeArchived: z.boolean().optional(),
}).optional();

export const ChatIdPayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
});

export const ChatCreatePayloadSchema = z.object({
  name: z.string().max(160).optional(),
  provider: ChatProviderSchema,
  model: z.string().max(160).nullable().optional(),
  currentCwd: z.string().min(1).max(4096),
  yolo: z.boolean().optional(),
});

export const ChatRenamePayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  name: z.string().min(1).max(160),
});

export const ChatSetCwdPayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
});

export const ChatSetProviderPayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  provider: ChatProviderSchema,
});

export const ChatSetModelPayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  model: z.string().min(1).max(160).nullable(),
});

export const ChatSetYoloPayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  yolo: z.boolean(),
});

export const ChatSendMessagePayloadSchema = z.object({
  chatId: z.string().min(1).max(200),
  text: z.string().min(1).max(500000),
  attachments: z.array(ChatFileAttachmentSchema).max(10).optional(),
});

export type ChatListPayload = z.infer<typeof ChatListPayloadSchema>;
export type ChatIdPayload = z.infer<typeof ChatIdPayloadSchema>;
export type ChatCreatePayload = z.infer<typeof ChatCreatePayloadSchema>;
export type ChatRenamePayload = z.infer<typeof ChatRenamePayloadSchema>;
export type ChatSetCwdPayload = z.infer<typeof ChatSetCwdPayloadSchema>;
export type ChatSetProviderPayload = z.infer<typeof ChatSetProviderPayloadSchema>;
export type ChatSetModelPayload = z.infer<typeof ChatSetModelPayloadSchema>;
export type ChatSetYoloPayload = z.infer<typeof ChatSetYoloPayloadSchema>;
export type ChatSendMessagePayload = z.infer<typeof ChatSendMessagePayloadSchema>;
