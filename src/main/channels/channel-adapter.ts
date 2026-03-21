import { EventEmitter } from 'events';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  ChannelConfig,
  ChannelSendOptions,
  ChannelSentMessage,
  InboundChannelMessage,
  AccessPolicy,
  PairedSender,
} from '../../shared/types/channels';

export interface ChannelAdapterEvents {
  'message': (msg: InboundChannelMessage) => void;
  'status': (status: ChannelConnectionStatus) => void;
  'error': (error: Error) => void;
  'qr': (qrData: string) => void;
}

export abstract class BaseChannelAdapter extends EventEmitter {
  abstract readonly platform: ChannelPlatform;
  abstract status: ChannelConnectionStatus;

  abstract connect(config: ChannelConfig): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract sendMessage(chatId: string, content: string, options?: ChannelSendOptions): Promise<ChannelSentMessage>;
  abstract sendFile(chatId: string, filePath: string, caption?: string): Promise<ChannelSentMessage>;
  abstract editMessage(chatId: string, messageId: string, content: string): Promise<void>;
  abstract addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;

  abstract getAccessPolicy(): AccessPolicy;
  abstract setAccessPolicy(policy: AccessPolicy): void;
  abstract pairSender(code: string): Promise<PairedSender>;

  override emit<K extends keyof ChannelAdapterEvents>(
    event: K,
    ...args: Parameters<ChannelAdapterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ChannelAdapterEvents>(
    event: K,
    listener: ChannelAdapterEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
