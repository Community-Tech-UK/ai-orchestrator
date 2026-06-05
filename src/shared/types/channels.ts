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
  /**
   * Human-friendly name for this machine's bot instance (e.g. "Mac Bot").
   * Applied as the per-guild Discord nickname and used to tag DM replies so
   * you can tell which machine is currently driving the shared bot token.
   * When empty, the adapter falls back to the machine hostname.
   */
  displayName?: string;
}

export interface InboundChannelMessage {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  guildId?: string;
  threadId?: string;
  senderId: string;
  senderName: string;
  senderIsAdmin?: boolean;
  content: string;
  attachments: ChannelAttachment[];
  isGroup: boolean;
  isDM: boolean;
  replyTo?: string;
  timestamp: number;
}

/**
 * Per-chat inbound intake state for a channel adapter (B6). Drives idempotent
 * delivery: the adapter records recently-seen message ids so a platform replay
 * or reconnect cannot re-route a message that was already handled, and tracks a
 * watermark (the highest accepted timestamp = the ack position) for diagnostics.
 */
export interface ChannelInboundWatermark {
  chatId: string;
  /** Recently-accepted message ids, FIFO-bounded, used for dedup. */
  recentIds: string[];
  /** Highest accepted inbound timestamp for this chat (the ack position). */
  lastTimestamp: number;
  /** Message id at the watermark, if any. */
  lastMessageId?: string;
  /** Count of accepted (non-duplicate) inbound messages for this chat. */
  processedCount: number;
}

export interface ChannelResponse {
  channelMessageId: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  instanceId: string;
  content: string;
  files?: string[];
  status: 'streaming' | 'complete' | 'error';
  replyToMessageId?: string;
  timestamp: number;
}

export interface SendOptions {
  replyTo?: string;
  splitAt?: number;
  actions?: ChannelMessageAction[];
}

export type ChannelActionStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface ChannelMessageAction {
  id: string;
  label: string;
  style?: ChannelActionStyle;
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
  qrCode?: string;
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
