/**
 * Channel IPC Payload Validation Schemas
 */
import { z } from 'zod';

const ChannelPlatformSchema = z.enum(['discord', 'whatsapp']);

export const ChannelConnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  token: z.string().min(1).max(500).optional(),
});

export const ChannelDisconnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelGetMessagesPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional().default(50),
  before: z.number().int().optional(),
});

export const ChannelSendMessagePayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  content: z.string().min(1).max(65536),
  replyTo: z.string().max(200).optional(),
});

export const ChannelPairSenderPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  code: z.string().length(6).regex(/^[0-9a-fA-F]{6}$/),
});

export const ChannelSetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  mode: z.enum(['pairing', 'allowlist', 'disabled']),
});

export const ChannelGetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export type ValidatedChannelConnectPayload = z.infer<typeof ChannelConnectPayloadSchema>;
export type ValidatedChannelSendMessagePayload = z.infer<typeof ChannelSendMessagePayloadSchema>;
export type ValidatedChannelPairSenderPayload = z.infer<typeof ChannelPairSenderPayloadSchema>;
export type ValidatedChannelGetMessagesPayload = z.infer<typeof ChannelGetMessagesPayloadSchema>;
