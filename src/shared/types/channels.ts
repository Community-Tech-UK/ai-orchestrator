/**
 * Channel Types - Shared between main process and renderer
 */

export type ChannelPlatform = 'discord' | 'whatsapp';
export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChannelConfig {
  platform: ChannelPlatform;
  token?: string;
  allowedSenders: string[];
  allowedChats: string[];
}

export interface InboundChannelMessage {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  threadId?: string;
  senderId: string;
  senderName: string;
  content: string;
  attachments: ChannelAttachment[];
  isGroup: boolean;
  isDM: boolean;
  replyTo?: string;
  timestamp: number;
}

export interface ChannelResponse {
  channelMessageId: string;
  instanceId: string;
  content: string;
  files?: string[];
  status: 'streaming' | 'complete' | 'error';
}

export interface SendOptions {
  replyTo?: string;
  splitAt?: number;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
  timestamp: number;
}

export interface PairedSender {
  senderId: string;
  senderName: string;
  platform: ChannelPlatform;
  pairedAt: number;
}

export interface AccessPolicy {
  mode: 'pairing' | 'allowlist' | 'disabled';
  allowedSenders: string[];
  pendingPairings: PendingPairing[];
  maxPending: number;
  codeExpiryMs: number;
}

export interface PendingPairing {
  code: string;
  senderId: string;
  senderName: string;
  expiresAt: number;
}

export interface ChannelAttachment {
  name: string;
  type: string;
  size: number;
  url?: string;
  localPath?: string;
}

export interface ChannelStatusEvent {
  platform: ChannelPlatform;
  status: ChannelConnectionStatus;
  botUsername?: string;
  phoneNumber?: string;
}

export interface ChannelErrorEvent {
  platform: ChannelPlatform;
  error: string;
  recoverable: boolean;
}

export interface ChannelMessageRow {
  id: string;
  platform: string;
  chat_id: string;
  message_id: string;
  thread_id: string | null;
  sender_id: string;
  sender_name: string;
  content: string;
  direction: 'inbound' | 'outbound';
  instance_id: string | null;
  reply_to_message_id: string | null;
  timestamp: number;
  created_at: number;
}
