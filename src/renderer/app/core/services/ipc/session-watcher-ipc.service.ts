import { Injectable, inject } from '@angular/core';
import {
  SessionWatcherFlagListSchema,
  type SessionWatcherAnswerYesPayload,
  type SessionWatcherFlagPayload,
  type SessionWatcherSetMutedPayload,
  type SessionWatcherTypingHoldPayload,
} from '@contracts/schemas/session-watcher';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class SessionWatcherIpcService {
  private readonly base = inject(ElectronIpcService);

  listFlags(): Promise<IpcResponse<SessionWatcherFlagPayload[]>> {
    return this.base.invoke('session-watcher:list-flags');
  }

  answerYes(payload: SessionWatcherAnswerYesPayload): Promise<IpcResponse> {
    return this.base.invoke('session-watcher:answer-yes', payload);
  }

  setMuted(payload: SessionWatcherSetMutedPayload): Promise<IpcResponse> {
    return this.base.invoke('session-watcher:set-muted', payload);
  }

  reportTyping(payload: SessionWatcherTypingHoldPayload): Promise<IpcResponse> {
    return this.base.invoke('session-watcher:typing-hold', payload);
  }

  /** The full list of flagged sessions, sent by main on every change. */
  onFlagsChanged(callback: (flags: SessionWatcherFlagPayload[]) => void): () => void {
    return this.base.on('session-watcher:flags-changed', (payload) => {
      const parsed = SessionWatcherFlagListSchema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    });
  }
}
