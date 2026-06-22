import type { ChannelPlatform } from '@shared/types/channels';

export interface ChannelConnectPayload {
  platform: ChannelPlatform;
  token?: string;
}

export interface ChannelDisconnectPayload {
  platform: ChannelPlatform;
}

export interface ChannelGetMessagesPayload {
  platform: ChannelPlatform;
  chatId: string;
  limit?: number;
  before?: number;
}

export interface ChannelSendMessagePayload {
  platform: ChannelPlatform;
  chatId: string;
  content: string;
  replyTo?: string;
}

export interface ChannelPairSenderPayload {
  platform: ChannelPlatform;
  code: string;
}

export interface ChannelSetAccessPolicyPayload {
  platform: ChannelPlatform;
  mode: 'pairing' | 'allowlist' | 'disabled';
}

export interface ChannelGetAccessPolicyPayload {
  platform: ChannelPlatform;
}
