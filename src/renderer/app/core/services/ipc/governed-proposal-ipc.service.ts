import { Injectable, inject } from '@angular/core';
import type {
  GovernedProposal,
  GovernedProposalKind,
  GovernedProposalStatus,
  ProposalAuditEntry,
} from '../../../features/memory-review/memory-review.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

/**
 * Renderer IPC wrapper for the WS-A4 memory promotion review inbox: list/get
 * governed proposals (with their audit trail) and submit James's
 * approve/reject decisions. Writes go through James-driven UI only.
 */
@Injectable({ providedIn: 'root' })
export class GovernedProposalIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async list(query: {
    kind?: GovernedProposalKind;
    status?: GovernedProposalStatus;
    sourceSessionId?: string;
    limit?: number;
  } = {}): Promise<IpcResponse<GovernedProposal[]>> {
    return this.call(() => this.api?.governedProposalList(query));
  }

  async get(id: string): Promise<IpcResponse<{ proposal: GovernedProposal; audit: ProposalAuditEntry[] }>> {
    return this.call(() => this.api?.governedProposalGet(id));
  }

  async approve(payload: {
    id: string;
    editedText?: string;
    rationale?: string;
    actor: string;
  }): Promise<IpcResponse<GovernedProposal>> {
    return this.call(() => this.api?.governedProposalApprove(payload));
  }

  async reject(payload: {
    id: string;
    rationale?: string;
    actor: string;
  }): Promise<IpcResponse<GovernedProposal>> {
    return this.call(() => this.api?.governedProposalReject(payload));
  }

  private async call<T>(fn: () => Promise<IpcResponse> | undefined): Promise<IpcResponse<T>> {
    const response = await fn();
    return response ? (response as IpcResponse<T>) : this.notInElectron<T>();
  }

  private notInElectron<T>(): IpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
