/**
 * Channel Store - Signal-based state for Discord/WhatsApp channels
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import type {
  ChannelConnectionStatus,
  ChannelErrorEvent,
  ChannelPlatform,
  ChannelResponse,
  ChannelStatusEvent,
  InboundChannelMessage,
} from '../../../../shared/types/channels';
import { ChannelIpcService } from '../services/ipc/channel-ipc.service';

export type ChannelStatus = ChannelConnectionStatus | 'unregistered';

export interface ChannelState {
  status: ChannelStatus;
  botUsername?: string;
  phoneNumber?: string;
  error?: string;
  qrCode?: string;
}

export interface ChannelMessageItem {
  id: string;
  platform: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  direction: 'inbound' | 'outbound';
  instanceId?: string;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class ChannelStore implements OnDestroy {
  private ipcService = inject(ChannelIpcService);

  // State
  private _discord = signal<ChannelState>({ status: 'disconnected' });
  private _whatsapp = signal<ChannelState>({ status: 'disconnected' });
  private _messages = signal<ChannelMessageItem[]>([]);
  private _loading = signal(false);

  // Public read-only selectors
  discord = this._discord.asReadonly();
  whatsapp = this._whatsapp.asReadonly();
  messages = this._messages.asReadonly();
  loading = this._loading.asReadonly();

  // Computed
  anyConnected = computed(() =>
    this._discord().status === 'connected' || this._whatsapp().status === 'connected'
  );

  // Cleanup functions for event listeners
  private cleanups: (() => void)[] = [];

  constructor() {
    this.subscribeToEvents();
    void this.loadInitialStatus();
  }

  ngOnDestroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }

  private subscribeToEvents(): void {
    const statusCleanup = this.ipcService.onStatusChanged((data: unknown) => {
      const event = data as ChannelStatusEvent & { status: ChannelStatus };
      if (event.platform === 'discord') {
        this._discord.update(prev => ({
          ...prev,
          status: event.status,
          botUsername: event.botUsername ?? prev.botUsername,
          error: event.status === 'error' ? prev.error : undefined,
          qrCode: undefined,
        }));
      } else if (event.platform === 'whatsapp') {
        this._whatsapp.update(prev => ({
          ...prev,
          status: event.status,
          phoneNumber: event.phoneNumber ?? prev.phoneNumber,
          error: event.status === 'error' ? prev.error : undefined,
          qrCode: event.status === 'connecting' ? event.qrCode ?? prev.qrCode : undefined,
        }));
      }
    });
    if (statusCleanup) this.cleanups.push(statusCleanup);

    const messageCleanup = this.ipcService.onMessageReceived((data: unknown) => {
      const msg = data as InboundChannelMessage;
      this._messages.update(prev => [{
        id: msg.id,
        platform: msg.platform,
        chatId: msg.chatId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        direction: 'inbound',
        timestamp: msg.timestamp,
      }, ...prev]);
    });
    if (messageCleanup) this.cleanups.push(messageCleanup);

    const responseCleanup = this.ipcService.onResponseSent((data: unknown) => {
      const response = data as ChannelResponse;
      this._messages.update(prev => [{
        id: 'out-' + response.messageId,
        platform: response.platform,
        chatId: response.chatId,
        senderId: 'bot',
        senderName: 'Orchestrator',
        content: response.content,
        direction: 'outbound',
        instanceId: response.instanceId,
        timestamp: response.timestamp,
      }, ...prev]);
    });
    if (responseCleanup) this.cleanups.push(responseCleanup);

    const errorCleanup = this.ipcService.onError((data: unknown) => {
      const event = data as ChannelErrorEvent;
      if (event.platform === 'discord') {
        this._discord.update(prev => ({ ...prev, error: event.error }));
      } else if (event.platform === 'whatsapp') {
        this._whatsapp.update(prev => ({ ...prev, error: event.error, qrCode: undefined }));
      }
    });
    if (errorCleanup) this.cleanups.push(errorCleanup);
  }

  private async loadInitialStatus(): Promise<void> {
    const res = await this.ipcService.getStatus();
    if (res.success && res.data) {
      const statuses = res.data as Record<ChannelPlatform, ChannelStatus>;
      this._discord.update(prev => ({ ...prev, status: statuses.discord ?? 'disconnected' }));
      this._whatsapp.update(prev => ({ ...prev, status: statuses.whatsapp ?? 'disconnected' }));
    }
  }

  // Actions
  async connectDiscord(token: string): Promise<void> {
    this._loading.set(true);
    this._discord.update(prev => ({ ...prev, status: 'connecting', error: undefined }));
    try {
      const res = await this.ipcService.connect('discord', token);
      if (res.success === false) {
        this._discord.update(prev => ({ ...prev, status: 'error', error: res.error?.message ?? 'Connection failed' }));
      }
    } catch (err) {
      this._discord.update(prev => ({ ...prev, status: 'error', error: String(err) }));
    } finally {
      this._loading.set(false);
    }
  }

  async connectWhatsApp(): Promise<void> {
    this._loading.set(true);
    this._whatsapp.update(prev => ({ ...prev, status: 'connecting', error: undefined, qrCode: undefined }));
    try {
      const res = await this.ipcService.connect('whatsapp');
      if (res.success === false) {
        this._whatsapp.update(prev => ({ ...prev, status: 'error', error: res.error?.message ?? 'Connection failed' }));
      }
    } catch (err) {
      this._whatsapp.update(prev => ({ ...prev, status: 'error', error: String(err) }));
    } finally {
      this._loading.set(false);
    }
  }

  async disconnect(platform: ChannelPlatform): Promise<void> {
    this._loading.set(true);
    try {
      await this.ipcService.disconnect(platform);
    } finally {
      this._loading.set(false);
    }
  }

  async pairSender(platform: ChannelPlatform, code: string): Promise<boolean> {
    const res = await this.ipcService.pairSender(platform, code);
    return res.success;
  }
}
