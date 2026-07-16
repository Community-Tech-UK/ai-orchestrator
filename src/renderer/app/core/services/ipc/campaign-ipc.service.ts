import { Injectable, inject } from '@angular/core';
import type { CampaignRunDto, CampaignSpec } from '../../../../../shared/types/campaign.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

function notInElectron(): IpcResponse {
  return { success: false, error: { message: 'Not in Electron' } };
}

@Injectable({ providedIn: 'root' })
export class CampaignIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }
  private get zone() { return this.base.getNgZone(); }

  async validate(spec: CampaignSpec): Promise<IpcResponse<{ valid: boolean; errors: string[] }>> {
    if (!this.api) return notInElectron() as IpcResponse<{ valid: boolean; errors: string[] }>;
    return (await this.api.campaignValidate(spec)) as IpcResponse<{ valid: boolean; errors: string[] }>;
  }

  /** WS8: build a campaign preview from a configured repository plan. */
  async importPlanPreview(params: {
    workspaceCwd: string;
    planFile: string;
    baseLoop: { verifyCommand: string; provider?: string; maxCostCents?: number; maxTurnsPerIteration?: number };
  }): Promise<IpcResponse<{
    spec: CampaignSpec;
    sourceDigest: string;
    aggregateMaxCostCents: number;
    assessment: { disposition: string; reasons: string[]; workstreams: { id: string; title: string }[] };
  }>> {
    if (!this.api) return notInElectron() as never;
    return (await (this.api as unknown as {
      campaignImportPlanPreview: (p: unknown) => Promise<unknown>;
    }).campaignImportPlanPreview(params)) as never;
  }

  async start(spec: CampaignSpec): Promise<IpcResponse<{ campaign: CampaignRunDto }>> {
    if (!this.api) return notInElectron() as IpcResponse<{ campaign: CampaignRunDto }>;
    return (await this.api.campaignStart(spec)) as IpcResponse<{ campaign: CampaignRunDto }>;
  }

  async get(campaignId: string): Promise<IpcResponse<{ campaign: CampaignRunDto | null }>> {
    if (!this.api) return notInElectron() as IpcResponse<{ campaign: CampaignRunDto | null }>;
    return (await this.api.campaignGet(campaignId)) as IpcResponse<{ campaign: CampaignRunDto | null }>;
  }

  async list(limit?: number): Promise<IpcResponse<{ campaigns: CampaignRunDto[] }>> {
    if (!this.api) return notInElectron() as IpcResponse<{ campaigns: CampaignRunDto[] }>;
    return (await this.api.campaignList(limit)) as IpcResponse<{ campaigns: CampaignRunDto[] }>;
  }

  async halt(campaignId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.campaignHalt(campaignId);
  }

  async resume(campaignId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.campaignResume(campaignId);
  }

  onStateChanged(cb: (data: { event: string; campaignId?: string; campaign: CampaignRunDto | null }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCampaignStateChanged((payload) => {
      this.zone.run(() => cb(payload as { event: string; campaignId?: string; campaign: CampaignRunDto | null }));
    });
  }
}
