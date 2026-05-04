import { Injectable } from '@angular/core';
import {
  ElectronIpcService,
  type IpcResponse,
} from './electron-ipc.service';
import type {
  VoiceStatus,
  VoiceTranscriptionSession,
  VoiceTtsResult,
} from '@contracts/schemas/voice';

@Injectable({ providedIn: 'root' })
export class VoiceIpcService extends ElectronIpcService {
  async getStatus(): Promise<VoiceStatus> {
    return this.unwrap<VoiceStatus>(
      await this.requireApi().getVoiceStatus() as IpcResponse<VoiceStatus>
    );
  }

  async setTemporaryOpenAiKey(apiKey: string): Promise<VoiceStatus> {
    return this.unwrap<VoiceStatus>(
      await this.requireApi().setTemporaryOpenAiVoiceKey(apiKey) as IpcResponse<VoiceStatus>
    );
  }

  async clearTemporaryOpenAiKey(): Promise<VoiceStatus> {
    return this.unwrap<VoiceStatus>(
      await this.requireApi().clearTemporaryOpenAiVoiceKey() as IpcResponse<VoiceStatus>
    );
  }

  async createTranscriptionSession(
    payload: { model?: string; language?: string; providerId?: string } = {}
  ): Promise<VoiceTranscriptionSession> {
    return this.unwrap<VoiceTranscriptionSession>(
      await this.requireApi().createVoiceTranscriptionSession(payload) as IpcResponse<VoiceTranscriptionSession>
    );
  }

  async closeTranscriptionSession(sessionId: string): Promise<boolean> {
    const response = this.unwrap<{ closed: boolean }>(
      await this.requireApi().closeVoiceTranscriptionSession(sessionId) as IpcResponse<{ closed: boolean }>
    );
    return response.closed;
  }

  async synthesizeSpeech(payload: {
    requestId: string;
    input: string;
    model?: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    providerId?: string;
  }): Promise<VoiceTtsResult> {
    return this.unwrap<VoiceTtsResult>(
      await this.requireApi().synthesizeVoiceSpeech(payload) as IpcResponse<VoiceTtsResult>
    );
  }

  async cancelSpeech(requestId: string): Promise<boolean> {
    const response = this.unwrap<{ cancelled: boolean }>(
      await this.requireApi().cancelVoiceSpeech(requestId) as IpcResponse<{ cancelled: boolean }>
    );
    return response.cancelled;
  }

  private requireApi() {
    const api = this.getApi();
    if (!api) throw new Error('Electron API not available');
    return api;
  }

  private unwrap<T>(response: IpcResponse<T>): T {
    if (response.success) return response.data as T;
    throw new Error(response.error?.message || 'Voice IPC request failed');
  }
}
