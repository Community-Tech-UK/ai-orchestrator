import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import { LoopScorecardResponseSchema } from '@contracts/schemas/loop-spend';
import type { LoopScorecard } from '../../../../../shared/types/loop-spend.types';
@Injectable({providedIn:'root'})
export class LoopScorecardService {
  private readonly base = inject(ElectronIpcService);
  async get(loopRunId: string): Promise<LoopScorecard | null> {
    const api = this.base.getApi();
    if (!api) return null;
    const response = await api.getLoopScorecard(loopRunId);
    if (!response.success) throw new Error(response.error?.message ?? 'Scorecard could not be loaded');
    return LoopScorecardResponseSchema.parse(response.data).scorecard;
  }
}
