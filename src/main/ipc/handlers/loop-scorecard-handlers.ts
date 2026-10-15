import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { LoopScorecardRequestSchema, LoopScorecardResponseSchema } from '@contracts/schemas/loop-spend';
import { getLoopStoreService } from '../../orchestration/loop-store';
import { loadScorecardInputs } from '../../orchestration/loop-store-spend';
import { buildLoopScorecard } from '../../orchestration/loop-scorecard';
export function registerLoopScorecardHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LOOP_GET_SCORECARD, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const request = LoopScorecardRequestSchema.parse(payload);
      const db = getLoopStoreService().getDb();
      const inputs = db ? loadScorecardInputs(db, request.loopRunId) : null;
      return { success: true, data: LoopScorecardResponseSchema.parse({ scorecard: inputs ? buildLoopScorecard(inputs) : null }) };
    } catch (error) {
      return { success: false, error: { code: 'LOOP_GET_SCORECARD_FAILED', message: error instanceof Error ? error.message : String(error), timestamp: Date.now() } };
    }
  });
}
