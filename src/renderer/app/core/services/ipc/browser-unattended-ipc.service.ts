import { Injectable, inject } from '@angular/core';
import type {
  BrowserCampaign,
  BrowserCampaignDetail,
  BrowserCampaignListItem,
  BrowserCampaignStatus,
  BrowserEscalation,
  BrowserEscalationStatus,
  BrowserVaultStatus,
  BrowserVaultUnlockResult,
  CreateBrowserCampaignPayload,
  CreateCredentialAuthorizationPayload,
  CredentialAuthorization,
} from '../../../features/browser/browser-unattended.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

/**
 * Renderer IPC wrapper for the unattended browser-automation layer (vault,
 * standing credential authorizations, overnight campaigns, escalation
 * triage). Sibling to `BrowserGatewayIpcService` — kept separate so neither
 * file grows past the 700-line ratchet, and because these calls are a
 * distinct James-approved write surface (never invoked by an agent).
 *
 * Unlike the gateway action calls, these handlers return the payload
 * directly under `response.data` (no `BrowserGatewayResult` decision/outcome
 * wrapper) — see `src/main/ipc/handlers/browser-unattended-handlers.ts`.
 */
@Injectable({ providedIn: 'root' })
export class BrowserUnattendedIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async vaultUnlock(): Promise<IpcResponse<BrowserVaultUnlockResult>> {
    return this.call(() => this.api?.browserVaultUnlock());
  }

  async vaultLock(): Promise<IpcResponse<BrowserVaultStatus>> {
    return this.call(() => this.api?.browserVaultLock());
  }

  async vaultStatus(): Promise<IpcResponse<BrowserVaultStatus>> {
    return this.call(() => this.api?.browserVaultStatus());
  }

  async createCredentialAuthorization(
    payload: CreateCredentialAuthorizationPayload,
  ): Promise<IpcResponse<CredentialAuthorization>> {
    return this.call(() => this.api?.browserCreateCredentialAuthorization(payload));
  }

  async listCredentialAuthorizations(
    payload: { profileId?: string } = {},
  ): Promise<IpcResponse<CredentialAuthorization[]>> {
    return this.call(() => this.api?.browserListCredentialAuthorizations(payload));
  }

  async revokeCredentialAuthorization(
    payload: { authorizationId: string },
  ): Promise<IpcResponse<{ revoked: boolean }>> {
    return this.call(() => this.api?.browserRevokeCredentialAuthorization(payload));
  }

  async createCampaign(
    payload: CreateBrowserCampaignPayload,
  ): Promise<IpcResponse<BrowserCampaign>> {
    return this.call(() => this.api?.browserCreateCampaign(payload));
  }

  async listCampaigns(
    payload: { status?: BrowserCampaignStatus } = {},
  ): Promise<IpcResponse<BrowserCampaignListItem[]>> {
    return this.call(() => this.api?.browserListCampaigns(payload));
  }

  async getCampaign(payload: { campaignId: string }): Promise<IpcResponse<BrowserCampaignDetail>> {
    return this.call(() => this.api?.browserGetCampaign(payload));
  }

  async pauseCampaign(payload: { campaignId: string }): Promise<IpcResponse<BrowserCampaign>> {
    return this.call(() => this.api?.browserPauseCampaign(payload));
  }

  async resumeCampaign(payload: { campaignId: string }): Promise<IpcResponse<BrowserCampaign>> {
    return this.call(() => this.api?.browserResumeCampaign(payload));
  }

  async killCampaign(payload: { campaignId: string }): Promise<IpcResponse<BrowserCampaign>> {
    return this.call(() => this.api?.browserKillCampaign(payload));
  }

  async approveCampaignDeclaration(
    payload: { campaignId: string; declarationHash: string },
  ): Promise<IpcResponse<{ approved: boolean }>> {
    return this.call(() => this.api?.browserApproveCampaignDeclaration(payload));
  }

  async listEscalations(
    payload: {
      campaignId?: string;
      profileId?: string;
      status?: BrowserEscalationStatus;
    } = {},
  ): Promise<IpcResponse<BrowserEscalation[]>> {
    return this.call(() => this.api?.browserListEscalations(payload));
  }

  async resolveEscalation(
    payload: { escalationId: string; note?: string },
  ): Promise<IpcResponse<BrowserEscalation>> {
    return this.call(() => this.api?.browserResolveEscalation(payload));
  }

  async skipEscalation(
    payload: { escalationId: string; note?: string },
  ): Promise<IpcResponse<BrowserEscalation>> {
    return this.call(() => this.api?.browserSkipEscalation(payload));
  }

  private async call<T>(
    fn: () => Promise<IpcResponse> | undefined,
  ): Promise<IpcResponse<T>> {
    const response = await fn();
    return response ? (response as IpcResponse<T>) : this.notInElectron<T>();
  }

  private notInElectron<T>(): IpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
