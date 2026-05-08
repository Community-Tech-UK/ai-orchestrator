import { Injectable, inject } from '@angular/core';
import type {
  ChatCreateInput,
  ChatDetail,
  ChatEvent,
  ChatProvider,
  ChatRecord,
} from '../../../../../shared/types/chat.types';
import type { ReasoningEffort } from '../../../../../shared/types/provider.types';
import type { FileAttachment } from '../../../../../shared/types/instance.types';
import {
  ElectronIpcService,
  type IpcResponse,
} from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class ChatIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async list(payload: { includeArchived?: boolean } = {}): Promise<IpcResponse<ChatRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatList(payload) as Promise<IpcResponse<ChatRecord[]>>;
  }

  async get(chatId: string): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatGet({ chatId }) as Promise<IpcResponse<ChatDetail>>;
  }

  async create(payload: ChatCreateInput): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatCreate(payload) as Promise<IpcResponse<ChatDetail>>;
  }

  async rename(chatId: string, name: string): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatRename({ chatId, name }) as Promise<IpcResponse<ChatDetail>>;
  }

  async archive(chatId: string): Promise<IpcResponse<ChatRecord>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatArchive({ chatId }) as Promise<IpcResponse<ChatRecord>>;
  }

  async setCwd(chatId: string, cwd: string): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSetCwd({ chatId, cwd }) as Promise<IpcResponse<ChatDetail>>;
  }

  async setProvider(chatId: string, provider: ChatProvider): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSetProvider({ chatId, provider }) as Promise<IpcResponse<ChatDetail>>;
  }

  async setModel(chatId: string, model: string | null): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSetModel({ chatId, model }) as Promise<IpcResponse<ChatDetail>>;
  }

  async setReasoning(chatId: string, reasoningEffort: ReasoningEffort | null): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSetReasoning({ chatId, reasoningEffort }) as Promise<IpcResponse<ChatDetail>>;
  }

  async setYolo(chatId: string, yolo: boolean): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSetYolo({ chatId, yolo }) as Promise<IpcResponse<ChatDetail>>;
  }

  async sendMessage(
    chatId: string,
    text: string,
    attachments?: FileAttachment[],
  ): Promise<IpcResponse<ChatDetail>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.chatSendMessage({ chatId, text, attachments }) as Promise<IpcResponse<ChatDetail>>;
  }

  onChatEvent(callback: (event: ChatEvent) => void): () => void {
    if (!this.api?.onChatEvent) {
      return () => { /* noop */ };
    }
    return this.api.onChatEvent((payload: unknown) => {
      this.base.getNgZone().run(() => callback(payload as ChatEvent));
    });
  }
}
