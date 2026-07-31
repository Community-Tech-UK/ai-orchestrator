/**
 * IPC surface for the WS-B8 fail->fix correction scan: a manual trigger and a
 * status/last-result read. The scan itself only ever raises/reinforces
 * `pending` governed 'rule' proposals (via `GovernedProposalService`) — it
 * never writes to LessonStore or promotes anything on its own.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  LearningScanGetStatusPayloadSchema,
  LearningScanRunPayloadSchema,
} from '@contracts/schemas/session';
import { getLearningScanService, type LearningScanService } from '../learning/learning-scan-service';
import { validatedHandler, type IpcResponse } from './validated-handler';

interface RegisterLearningScanHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  service?: LearningScanService;
}

export function registerLearningScanHandlers(deps: RegisterLearningScanHandlersDeps = {}): void {
  const service = deps.service ?? getLearningScanService();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  ipcMain.handle(
    IPC_CHANNELS.LEARNING_SCAN_RUN,
    validatedHandler(
      IPC_CHANNELS.LEARNING_SCAN_RUN,
      LearningScanRunPayloadSchema,
      async (payload) => ({ success: true, data: await service.runScan(payload ?? {}) }),
      options('LEARNING_SCAN_RUN_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.LEARNING_SCAN_GET_STATUS,
    validatedHandler(
      IPC_CHANNELS.LEARNING_SCAN_GET_STATUS,
      LearningScanGetStatusPayloadSchema,
      async (payload) => ({ success: true, data: service.getStatus(payload?.workspaceId) }),
      options('LEARNING_SCAN_GET_STATUS_FAILED'),
    ),
  );
}
