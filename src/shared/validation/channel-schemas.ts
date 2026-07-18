/**
 * Channel IPC Payload Validation Schemas
 */
import { z } from 'zod';

const ChannelPlatformSchema = z.enum(['discord', 'whatsapp']);
const ChannelConnectionStatusSchema = z.enum(['disconnected', 'connecting', 'connected', 'error']);

export const ChannelConnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  token: z.string().min(1).max(500).optional(),
  // Per-machine bot name (e.g. "Mac Bot"). Discord nicknames cap at 32 chars.
  displayName: z.string().trim().max(32).optional(),
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

const ChannelAttachmentSchema = z.object({
  name: z.string().min(1).max(1_000),
  type: z.string().max(500),
  size: z.number().int().nonnegative(),
  url: z.string().max(10_000).optional(),
  localPath: z.string().max(4_000).optional(),
}).strict();

export const ChannelStatusEventSchema = z.object({
  platform: ChannelPlatformSchema,
  status: ChannelConnectionStatusSchema,
  botUsername: z.string().max(500).optional(),
  phoneNumber: z.string().max(100).optional(),
  qrCode: z.string().max(1_000_000).optional(),
}).strict();

export const InboundChannelMessageEventSchema = z.object({
  id: z.string().min(1).max(500),
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(500),
  messageId: z.string().min(1).max(500),
  guildId: z.string().max(500).optional(),
  threadId: z.string().max(500).optional(),
  senderId: z.string().min(1).max(500),
  senderName: z.string().max(1_000),
  senderIsAdmin: z.boolean().optional(),
  content: z.string().max(100_000),
  attachments: z.array(ChannelAttachmentSchema).max(100),
  isGroup: z.boolean(),
  isDM: z.boolean(),
  replyTo: z.string().max(500).optional(),
  timestamp: z.number().int().nonnegative(),
}).strict();

export const ChannelResponseEventSchema = z.object({
  channelMessageId: z.string().min(1).max(500),
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(500),
  messageId: z.string().min(1).max(500),
  instanceId: z.string().min(1).max(500),
  content: z.string().max(100_000),
  files: z.array(z.string().max(4_000)).max(100).optional(),
  status: z.enum(['streaming', 'complete', 'error']),
  replyToMessageId: z.string().max(500).optional(),
  timestamp: z.number().int().nonnegative(),
}).strict();

export const ChannelErrorEventSchema = z.object({
  platform: ChannelPlatformSchema,
  error: z.string().min(1).max(10_000),
  recoverable: z.boolean(),
}).strict();

export type ValidatedChannelConnectPayload = z.infer<typeof ChannelConnectPayloadSchema>;
export type ValidatedChannelSendMessagePayload = z.infer<typeof ChannelSendMessagePayloadSchema>;
export type ValidatedChannelPairSenderPayload = z.infer<typeof ChannelPairSenderPayloadSchema>;
export type ValidatedChannelGetMessagesPayload = z.infer<typeof ChannelGetMessagesPayloadSchema>;
