import { Injectable, inject, signal } from '@angular/core';
import type {
  RecoverSessionResult,
  SessionRecoveryCandidate,
} from '../../../../shared/types/session-recovery.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

const UNAVAILABLE_MESSAGE = 'Session recovery is not available in this environment';
const RECOVERY_FAILED_MESSAGE = 'Session recovery failed';

function errorMessage(error: unknown, fallback = RECOVERY_FAILED_MESSAGE): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

@Injectable({ providedIn: 'root' })
export class SessionRecoveryStore {
  private readonly electronIpc = inject(ElectronIpcService);

  private readonly _candidates = signal<SessionRecoveryCandidate[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _recoveringKey = signal<string | null>(null);

  private refreshRequestId = 0;

  readonly candidates = this._candidates.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly recoveringKey = this._recoveringKey.asReadonly();

  async refresh(): Promise<void> {
    const requestId = ++this.refreshRequestId;
    this._loading.set(true);
    this._error.set(null);

    const api = this.electronIpc.getApi();
    if (!api) {
      this.applyRefreshFailure(requestId, UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const candidates = await api.listRecoveryCandidates();
      if (requestId !== this.refreshRequestId) {
        return;
      }

      this._candidates.set(candidates);
      this._error.set(null);
    } catch (error) {
      this.applyRefreshFailure(requestId, errorMessage(error, UNAVAILABLE_MESSAGE));
    } finally {
      if (requestId === this.refreshRequestId) {
        this._loading.set(false);
      }
    }
  }

  async recover(recoveryKey: string): Promise<RecoverSessionResult | null> {
    if (this._recoveringKey()) {
      return null;
    }

    const api = this.electronIpc.getApi();
    if (!api) {
      this._error.set(UNAVAILABLE_MESSAGE);
      return null;
    }

    this._recoveringKey.set(recoveryKey);
    this._error.set(null);

    try {
      const result = await api.recoverSession({ recoveryKey });
      this.removeCandidate(recoveryKey);
      this.refreshAfterRecovery();
      return result;
    } catch (error) {
      this._error.set(errorMessage(error));
      return null;
    } finally {
      this._recoveringKey.set(null);
    }
  }

  private removeCandidate(recoveryKey: string): void {
    this._candidates.update((candidates) =>
      candidates.filter((candidate) => candidate.recoveryKey !== recoveryKey)
    );
  }

  private refreshAfterRecovery(): void {
    void this.refresh().catch((error) => {
      this._error.set(errorMessage(error));
    });
  }

  private applyRefreshFailure(requestId: number, message: string): void {
    if (requestId !== this.refreshRequestId) {
      return;
    }

    this._error.set(message);
    this._loading.set(false);
  }
}
