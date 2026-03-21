/**
 * Channel IPC Service - Discord/WhatsApp channel management
 */
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class ChannelIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async connect(platform: string, token?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelConnect({ platform, token });
  }

  async disconnect(platform: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelDisconnect({ platform });
  }

  async getStatus(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetStatus();
  }

  async getMessages(platform: string, chatId: string, limit?: number, before?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetMessages({ platform, chatId, limit, before });
  }

  async sendMessage(platform: string, chatId: string, content: string, replyTo?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSendMessage({ platform, chatId, content, replyTo });
  }

  async pairSender(platform: string, code: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelPairSender({ platform, code });
  }

  async getAccessPolicy(platform: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetAccessPolicy({ platform });
  }

  async setAccessPolicy(platform: string, mode: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSetAccessPolicy({ platform, mode });
  }

  // Event listeners — return cleanup functions
  onStatusChanged(callback: (data: unknown) => void): (() => void) | null {
    if (!this.api) return null;
    return this.api.onChannelStatusChanged(callback);
  }

  onMessageReceived(callback: (data: unknown) => void): (() => void) | null {
    if (!this.api) return null;
    return this.api.onChannelMessageReceived(callback);
  }

  onResponseSent(callback: (data: unknown) => void): (() => void) | null {
    if (!this.api) return null;
    return this.api.onChannelResponseSent(callback);
  }

  onError(callback: (data: unknown) => void): (() => void) | null {
    if (!this.api) return null;
    return this.api.onChannelError(callback);
  }
}
