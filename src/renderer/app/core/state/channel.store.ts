/**
 * Channel Store - Signals-based state management for Discord/WhatsApp channels
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { ChannelIpcService } from '../services/ipc/channel-ipc.service';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  StoredChannelMessage,
  ChannelStatusEvent,
  ChannelErrorEvent,
  InboundChannelMessage,
  ChannelResponse,
} from '../../../../shared/types/channels';

interface ChannelState {
  platform: ChannelPlatform;
  status: ChannelConnectionStatus;
  botUsername?: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class ChannelStore {
  private ipcService = inject(ChannelIpcService);

  // State
  private _channels = signal<ChannelState[]>([
    { platform: 'discord', status: 'disconnected' },
  ]);
  private _messages = signal<StoredChannelMessage[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  // Selectors
  channels = this._channels.asReadonly();
  messages = this._messages.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();

  discordStatus = computed(() =>
    this._channels().find(c => c.platform === 'discord')?.status ?? 'disconnected'
  );

  isAnyConnected = computed(() =>
    this._channels().some(c => c.status === 'connected')
  );

  constructor() {
    this.listenForPushEvents();
  }

  async connect(platform: ChannelPlatform, token?: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this.updateChannelStatus(platform, 'connecting');
    try {
      const response = await this.ipcService.channelConnect(platform, token);
      if (!response.success) {
        const errorMsg = response.error?.message ?? 'Connection failed';
        this._error.set(errorMsg);
        this.updateChannelStatus(platform, 'error');
      }
    } catch (err) {
      this._error.set((err as Error).message);
      this.updateChannelStatus(platform, 'error');
    } finally {
      this._loading.set(false);
    }
  }

  async disconnect(platform: ChannelPlatform): Promise<void> {
    try {
      await this.ipcService.channelDisconnect(platform);
      this.updateChannelStatus(platform, 'disconnected');
    } catch (err) {
      this._error.set((err as Error).message);
    }
  }

  async loadMessages(platform: ChannelPlatform, chatId: string): Promise<void> {
    this._loading.set(true);
    try {
      const response = await this.ipcService.channelGetMessages(platform, chatId);
      if (response.success && response.data) {
        this._messages.set(response.data as StoredChannelMessage[]);
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  async pairSender(platform: ChannelPlatform, code: string): Promise<boolean> {
    try {
      const response = await this.ipcService.channelPairSender(platform, code);
      return response.success;
    } catch {
      return false;
    }
  }

  private updateChannelStatus(platform: ChannelPlatform, status: ChannelConnectionStatus, extra?: Partial<ChannelState>): void {
    this._channels.update(channels =>
      channels.map(c =>
        c.platform === platform ? { ...c, status, ...extra } : c
      )
    );
  }

  private listenForPushEvents(): void {
    this.ipcService.onStatusChanged((data) => {
      const event = data as ChannelStatusEvent;
      this.updateChannelStatus(event.platform, event.status, {
        botUsername: event.botUsername,
      });
    });

    this.ipcService.onError((data) => {
      const event = data as ChannelErrorEvent;
      this._error.set(event.error);
      if (!event.recoverable) {
        this.updateChannelStatus(event.platform, 'error', { error: event.error });
      }
    });

    this.ipcService.onMessageReceived((data) => {
      const msg = data as InboundChannelMessage;
      this._messages.update(msgs => [...msgs, {
        id: msg.id,
        platform: msg.platform,
        chatId: msg.chatId,
        messageId: msg.messageId,
        threadId: msg.threadId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        direction: 'inbound' as const,
        timestamp: msg.timestamp,
        createdAt: Math.floor(Date.now() / 1000),
      }]);
    });

    this.ipcService.onResponseSent((data) => {
      const response = data as ChannelResponse;
      this._messages.update(msgs => [...msgs, {
        id: crypto.randomUUID(),
        platform: 'discord' as ChannelPlatform,
        chatId: '',
        messageId: '',
        senderId: 'orchestrator',
        senderName: 'Orchestrator',
        content: response.content,
        direction: 'outbound' as const,
        instanceId: response.instanceId,
        timestamp: Date.now(),
        createdAt: Math.floor(Date.now() / 1000),
      }]);
    });
  }
}
