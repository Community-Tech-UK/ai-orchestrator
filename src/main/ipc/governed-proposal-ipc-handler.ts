/**
 * IPC surface for the WS-A4 memory promotion review inbox: list/get governed
 * proposals (with their audit trail) and record James's approve/reject
 * decisions. Writes go through James-driven UI only — never an agent.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  GovernedProposalApprovePayloadSchema,
  GovernedProposalGetPayloadSchema,
  GovernedProposalListPayloadSchema,
  GovernedProposalRejectPayloadSchema,
} from '@contracts/schemas/knowledge';
import {
  getGovernedProposalStore,
  type GovernedProposalStore,
} from '../memory/governed-proposal-store';
import {
  GovernedProposalDecisionError,
  getGovernedProposalService,
  type GovernedProposalService,
} from '../memory/governed-proposal-service';
import { validatedHandler, type IpcResponse } from './validated-handler';

interface RegisterGovernedProposalHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  store?: GovernedProposalStore;
  service?: GovernedProposalService;
}

export function registerGovernedProposalHandlers(deps: RegisterGovernedProposalHandlersDeps = {}): void {
  const store = deps.store ?? getGovernedProposalStore();
  const service = deps.service ?? getGovernedProposalService();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  ipcMain.handle(
    IPC_CHANNELS.GOVERNED_PROPOSAL_LIST,
    validatedHandler(
      IPC_CHANNELS.GOVERNED_PROPOSAL_LIST,
      GovernedProposalListPayloadSchema,
      async (payload) => ({ success: true, data: store.list(payload ?? {}) }),
      options('GOVERNED_PROPOSAL_LIST_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.GOVERNED_PROPOSAL_GET,
    validatedHandler(
      IPC_CHANNELS.GOVERNED_PROPOSAL_GET,
      GovernedProposalGetPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const proposal = store.get(payload.id);
        if (!proposal) {
          return {
            success: false,
            error: { code: 'GOVERNED_PROPOSAL_NOT_FOUND', message: `Unknown proposal: ${payload.id}`, timestamp: Date.now() },
          };
        }
        return { success: true, data: { proposal, audit: store.getAuditTrail(payload.id) } };
      },
      options('GOVERNED_PROPOSAL_GET_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE,
    validatedHandler(
      IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE,
      GovernedProposalApprovePayloadSchema,
      async (payload): Promise<IpcResponse> => {
        try {
          const proposal = service.approve(payload.id, {
            editedText: payload.editedText,
            rationale: payload.rationale,
            actor: payload.actor,
          });
          return { success: true, data: proposal };
        } catch (err) {
          return decisionErrorResponse(err, 'GOVERNED_PROPOSAL_APPROVE_FAILED');
        }
      },
      options('GOVERNED_PROPOSAL_APPROVE_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.GOVERNED_PROPOSAL_REJECT,
    validatedHandler(
      IPC_CHANNELS.GOVERNED_PROPOSAL_REJECT,
      GovernedProposalRejectPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        try {
          const proposal = service.reject(payload.id, {
            rationale: payload.rationale,
            actor: payload.actor,
          });
          return { success: true, data: proposal };
        } catch (err) {
          return decisionErrorResponse(err, 'GOVERNED_PROPOSAL_REJECT_FAILED');
        }
      },
      options('GOVERNED_PROPOSAL_REJECT_FAILED'),
    ),
  );
}

function decisionErrorResponse(err: unknown, fallbackCode: string): IpcResponse {
  if (err instanceof GovernedProposalDecisionError) {
    return {
      success: false,
      error: { code: err.code, message: err.message, timestamp: Date.now() },
    };
  }
  return {
    success: false,
    error: {
      code: fallbackCode,
      message: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    },
  };
}
