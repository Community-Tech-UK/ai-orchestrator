import { Injectable, inject } from '@angular/core';
import type { HistoryRestoreResult } from '../../../../shared/types/history.types';
import { HistoryIpcService, type IpcResponse } from '../../core/services/ipc';

@Injectable({ providedIn: 'root' })
export class ResumeActionsService {
  private readonly historyIpc = inject(HistoryIpcService);

  resumeLatest(workingDirectory?: string): Promise<IpcResponse<HistoryRestoreResult>> {
    return this.historyIpc.resumeLatest(workingDirectory) as Promise<IpcResponse<HistoryRestoreResult>>;
  }

  resumeById(entryId: string): Promise<IpcResponse<HistoryRestoreResult>> {
    return this.historyIpc.resumeById(entryId) as Promise<IpcResponse<HistoryRestoreResult>>;
  }

  switchToLive(instanceId: string): Promise<IpcResponse<HistoryRestoreResult>> {
    return this.historyIpc.resumeSwitchToLive(instanceId) as Promise<IpcResponse<HistoryRestoreResult>>;
  }

  forkNew(entryId: string): Promise<IpcResponse<HistoryRestoreResult>> {
    return this.historyIpc.resumeForkNew(entryId) as Promise<IpcResponse<HistoryRestoreResult>>;
  }

  restoreFromFallback(entryId: string): Promise<IpcResponse<HistoryRestoreResult>> {
    return this.historyIpc.resumeRestoreFallback(entryId) as Promise<IpcResponse<HistoryRestoreResult>>;
  }
}
