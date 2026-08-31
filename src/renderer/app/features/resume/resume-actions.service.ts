import { Injectable, inject } from '@angular/core';
import type { HistoryRestoreResult } from '../../../../shared/types/history.types';
import type { RecoverSessionResult, SessionRecoveryCandidate } from '../../../../shared/types/session-recovery.types';
import { HistoryIpcService, type IpcResponse } from '../../core/services/ipc';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';

export type ResumeActionSource = 'history' | 'live' | 'recovery';

export interface ResumeActionResponse extends IpcResponse<HistoryRestoreResult> {
  source?: ResumeActionSource;
  recoveredMessageCount?: number;
}

function newestRecoveryCandidate(candidates: readonly SessionRecoveryCandidate[]): SessionRecoveryCandidate | null {
  return [...candidates].sort((left, right) =>
    right.lastActivityAt - left.lastActivityAt || left.recoveryKey.localeCompare(right.recoveryKey)
  )[0] ?? null;
}

function recoverySuccessResponse(result: RecoverSessionResult): ResumeActionResponse {
  return {
    success: true,
    source: 'recovery',
    recoveredMessageCount: result.recoveredMessageCount,
    data: { success: true, instanceId: result.instanceId },
  };
}

@Injectable({ providedIn: 'root' })
export class ResumeActionsService {
  private readonly historyIpc = inject(HistoryIpcService);
  private readonly recoveryStore = inject(SessionRecoveryStore);

  async resumeLatest(workingDirectory?: string): Promise<ResumeActionResponse> {
    const candidate = newestRecoveryCandidate(this.recoveryStore.candidates());
    if (candidate) {
      return this.recoverAutosave(candidate.recoveryKey);
    }

    return this.historyIpc.resumeLatest(workingDirectory) as Promise<ResumeActionResponse>;
  }

  resumeById(entryId: string): Promise<ResumeActionResponse> {
    return this.historyIpc.resumeById(entryId) as Promise<ResumeActionResponse>;
  }

  switchToLive(instanceId: string): Promise<ResumeActionResponse> {
    return this.historyIpc.resumeSwitchToLive(instanceId) as Promise<ResumeActionResponse>;
  }

  forkNew(entryId: string): Promise<ResumeActionResponse> {
    return this.historyIpc.resumeForkNew(entryId) as Promise<ResumeActionResponse>;
  }

  restoreFromFallback(entryId: string): Promise<ResumeActionResponse> {
    return this.historyIpc.resumeRestoreFallback(entryId) as Promise<ResumeActionResponse>;
  }

  async recoverAutosave(recoveryKey: string): Promise<ResumeActionResponse> {
    const result = await this.recoveryStore.recover(recoveryKey);
    if (result) {
      return recoverySuccessResponse(result);
    }

    return {
      success: false,
      source: 'recovery',
      error: { message: this.recoveryStore.error() ?? 'Session recovery failed' },
    };
  }
}
