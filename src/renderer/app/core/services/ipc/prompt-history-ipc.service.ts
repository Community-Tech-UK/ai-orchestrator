import { Injectable, inject } from '@angular/core';
import type {
  PromptHistoryDelta,
  PromptHistoryEntry,
  PromptHistoryRecord,
  PromptHistorySnapshot,
} from '../../../../../shared/types/prompt-history.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class PromptHistoryIpcService {
  private readonly base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async getSnapshot(): Promise<IpcResponse<PromptHistorySnapshot>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.promptHistoryGetSnapshot() as Promise<IpcResponse<PromptHistorySnapshot>>;
  }

  async record(
    instanceId: string,
    entry: PromptHistoryEntry,
  ): Promise<IpcResponse<PromptHistoryRecord>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.promptHistoryRecord({ instanceId, entry }) as Promise<IpcResponse<PromptHistoryRecord>>;
  }

  async clearInstance(instanceId: string): Promise<IpcResponse<PromptHistoryRecord>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.promptHistoryClearInstance({ instanceId }) as Promise<IpcResponse<PromptHistoryRecord>>;
  }

  onDelta(callback: (delta: PromptHistoryDelta) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPromptHistoryDelta((delta) => {
      this.base.getNgZone().run(() => callback(delta));
    });
  }
}
