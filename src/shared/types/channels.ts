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

export interface ChannelSendOptions {
  replyTo?: string;
  splitAt?: number;
}

export interface ChannelSentMessage {
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

export interface StoredChannelMessage {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  threadId?: string;
  senderId: string;
  senderName: string;
  content: string;
  direction: 'inbound' | 'outbound';
  instanceId?: string;
  replyToMessageId?: string;
  timestamp: number;
  createdAt: number;
}

/** Error codes for channel IPC responses */
export type ChannelErrorCode =
  | 'CHANNEL_CONNECT_FAILED'
  | 'CHANNEL_NOT_CONNECTED'
  | 'CHANNEL_ADAPTER_UNAVAILABLE'
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_PAIR_INVALID'
  | 'CHANNEL_PAIR_EXPIRED'
  | 'CHANNEL_UNAUTHORIZED'
  | 'CHANNEL_RATE_LIMITED';
