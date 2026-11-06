/**
 * Turn file-change IPC service: which files changed while one turn ran.
 *
 * The main process takes the snapshots (when a turn starts and when it
 * settles); this only asks for the answer. A malformed or failed answer is
 * `null`, which the transcript treats as "no count", never as zero.
 */

import { Injectable, inject } from '@angular/core';
import { readTurnBaselineResult, type TurnBaselineResult } from '../../../../../shared/types/turn-file-changes.types';
import { ElectronIpcService } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class TurnBaselineIpcService {
  private base = inject(ElectronIpcService);

  async getTurnFileChanges(instanceId: string, turnKey: string): Promise<TurnBaselineResult | null> {
    const api = this.base.getApi();
    if (!api?.vcsTurnFileChanges) return null;
    try {
      const response = await api.vcsTurnFileChanges({ instanceId, turnKey });
      return response.success ? readTurnBaselineResult(response.data) : null;
    } catch {
      return null;
    }
  }
}
