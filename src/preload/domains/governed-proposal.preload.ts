import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

/**
 * WS-A4 memory promotion review inbox: list/get governed proposals (with
 * their audit trail) and submit James's approve/reject decisions.
 */
export function createGovernedProposalDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    governedProposalList: (payload?: {
      kind?: 'memory' | 'skill' | 'hook' | 'rule';
      status?: 'pending' | 'approved' | 'rejected' | 'superseded';
      sourceSessionId?: string;
      limit?: number;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.GOVERNED_PROPOSAL_LIST, payload),

    governedProposalGet: (id: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.GOVERNED_PROPOSAL_GET, { id }),

    governedProposalApprove: (payload: {
      id: string;
      editedText?: string;
      rationale?: string;
      actor: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.GOVERNED_PROPOSAL_APPROVE, payload),

    governedProposalReject: (payload: {
      id: string;
      rationale?: string;
      actor: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.GOVERNED_PROPOSAL_REJECT, payload),
  };
}
