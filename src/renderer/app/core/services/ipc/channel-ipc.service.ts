/**
 * Channel IPC Service - Discord/WhatsApp channel operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { ChannelPlatform } from '../../../../../shared/types/channels';

@Injectable({ providedIn: 'root' })
export class ChannelIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async channelConnect(platform: ChannelPlatform, token?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelConnect({ platform, token });
  }

  async channelDisconnect(platform: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelDisconnect({ platform });
  }

  async channelGetStatus(platform?: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetStatus(platform ? { platform } : undefined);
  }

  async channelGetMessages(platform: ChannelPlatform, chatId: string, limit?: number, before?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetMessages({ platform, chatId, limit, before });
  }

  async channelSendMessage(platform: ChannelPlatform, chatId: string, content: string, replyTo?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSendMessage({ platform, chatId, content, replyTo });
  }

  async channelPairSender(platform: ChannelPlatform, code: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelPairSender({ platform, code });
  }

  async channelGetAccessPolicy(platform: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetAccessPolicy({ platform });
  }

  async channelSetAccessPolicy(platform: ChannelPlatform, mode: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSetAccessPolicy({ platform, mode });
  }

  // Push event listeners
  onStatusChanged(callback: (data: unknown) => void): void {
    if (!this.api) return;
    this.api.channelOnStatusChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  onMessageReceived(callback: (data: unknown) => void): void {
    if (!this.api) return;
    this.api.channelOnMessageReceived((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  onResponseSent(callback: (data: unknown) => void): void {
    if (!this.api) return;
    this.api.channelOnResponseSent((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  onError(callback: (data: unknown) => void): void {
    if (!this.api) return;
    this.api.channelOnError((data) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
