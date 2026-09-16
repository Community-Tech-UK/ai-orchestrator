/**
 * Session admission IPC handlers.
 *
 * Extracted from session-handlers.ts (LOC ratchet). Registers the
 * SESSION_ADMISSIONS_LIST endpoint that surfaces recorded/suppressed/
 * delivered/failed/cancelled/expired admission-gated writes for a session.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { SessionAdmissionsListPayloadSchema } from '@contracts/schemas/session';
import { getSessionAdmissionService } from '../../session/session-admission-service';
import { registerValidatedIpcHandler } from '../validated-handler';

export interface SessionAdmissionHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerSessionAdmissionHandlers(deps: SessionAdmissionHandlersDeps): void {
  registerValidatedIpcHandler(
    IPC_CHANNELS.SESSION_ADMISSIONS_LIST,
    SessionAdmissionsListPayloadSchema,
    async (payload) => ({
      success: true,
      data: getSessionAdmissionService().listAdmissions({
        instanceId: payload?.instanceId,
        states: payload?.states,
      }),
    }),
    {
      ensureTrustedSender: deps.ensureTrustedSender,
      errorCode: 'SESSION_ADMISSIONS_LIST_FAILED',
    },
  );
}
