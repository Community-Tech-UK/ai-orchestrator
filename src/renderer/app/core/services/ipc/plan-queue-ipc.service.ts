import { Injectable, inject } from '@angular/core';
import type {
  PlanQueueAlert,
  PlanQueueHealth,
  PlanQueueControlPayload,
  PlanQueueKind,
  PlanQueueRunDto,
  PlanQueuePreviewPayload,
  PlanQueueDiscoveryPreview,
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearIdentity,
  PlanQueueLinearLinksReading,
  PlanQueueLinearLinksSaveResult,
  PlanQueueLinearListResult,
  PlanQueueLinearPreview,
  PlanQueueLinearPreviewText,
  PlanQueueLinearProjectChoices,
  PlanQueueLinearStartPayload,
  PlanQueueLinearTeamChoices,
  PlanQueueLinearTeamsCheck,
  PlanQueueLinearTeamsSaveResult,
  PlanQueueStateChangedEvent,
} from '@contracts/schemas/plan-queue';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

function notInElectron<T>(): IpcResponse<T> {
  return { success: false, error: { message: 'Not in Electron' } };
}

/**
 * Thin renderer IPC wrapper for the Plan Queue panel. Mirrors CampaignIpcService:
 * every call goes through the typed preload API exposed at
 * `src/preload/domains/plan-queue.preload.ts`, and every response keeps the
 * caller's `IpcResponse` shape even when not running inside Electron.
 */
@Injectable({ providedIn: 'root' })
export class PlanQueueIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }
  private get zone() { return this.base.getNgZone(); }

  async preview(payload: PlanQueuePreviewPayload): Promise<IpcResponse<PlanQueueDiscoveryPreview>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueuePreview(payload)) as IpcResponse<PlanQueueDiscoveryPreview>;
  }

  async list(limit?: number): Promise<IpcResponse<{ runs: PlanQueueRunDto[]; alerts: PlanQueueAlert[]; health: PlanQueueHealth | null }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueList(limit ? { limit } : undefined)) as IpcResponse<{
      runs: PlanQueueRunDto[];
      alerts: PlanQueueAlert[];
      health: PlanQueueHealth | null;
    }>;
  }

  async get(runId: string): Promise<IpcResponse<{ run: PlanQueueRunDto | null }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueGet({ runId })) as IpcResponse<{ run: PlanQueueRunDto | null }>;
  }

  async alerts(): Promise<IpcResponse<{ alerts: PlanQueueAlert[] }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueAlerts()) as IpcResponse<{ alerts: PlanQueueAlert[] }>;
  }

  async diffstat(itemId: string): Promise<IpcResponse<{ diffstat: string }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueDiffstat({ itemId })) as IpcResponse<{ diffstat: string }>;
  }

  async startSetAsideAgent(workspaceCwd: string): Promise<IpcResponse<{ instanceId: string }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueStartSetAsideAgent({ workspaceCwd })) as IpcResponse<{ instanceId: string }>;
  }

  async start(payload: {
    parentInstanceId: string;
    kind: PlanQueueKind;
    workspaceCwd: string;
    glob?: string;
    config?: { keepOnThisMac?: boolean };
  }): Promise<IpcResponse<{ run: PlanQueueRunDto; excluded: string[] }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueStart(payload)) as IpcResponse<{ run: PlanQueueRunDto; excluded: string[] }>;
  }

  async answer(itemId: string, optionId: string): Promise<IpcResponse<null>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueAnswer({ itemId, optionId })) as IpcResponse<null>;
  }

  async control(payload: PlanQueueControlPayload): Promise<IpcResponse<null>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueControl(payload)) as IpcResponse<null>;
  }

  /** The Harness connectors at Linear's address, with the saved connection's state. */
  async linearList(): Promise<IpcResponse<PlanQueueLinearListResult>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearList()) as IpcResponse<PlanQueueLinearListResult>;
  }

  /** Who a chosen connector signs in as. Saves nothing. */
  async linearIdentify(connectorId: string): Promise<IpcResponse<PlanQueueLinearIdentity>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearIdentify({ connectorId })) as IpcResponse<PlanQueueLinearIdentity>;
  }

  /** Saves the connection, if the connector still signs in as the user that was shown. */
  async linearConfirm(connectorId: string, userId: string): Promise<IpcResponse<PlanQueueLinearConnectionSnapshot>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearConfirm({ connectorId, userId })) as IpcResponse<PlanQueueLinearConnectionSnapshot>;
  }

  /** Clears the saved connection. */
  async linearForget(): Promise<IpcResponse<PlanQueueLinearConnectionSnapshot>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearForget()) as IpcResponse<PlanQueueLinearConnectionSnapshot>;
  }

  /** Checks the saved connection now. */
  async linearCheck(): Promise<IpcResponse<PlanQueueLinearConnectionSnapshot>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearCheck()) as IpcResponse<PlanQueueLinearConnectionSnapshot>;
  }

  /** Linear's teams and their projects, names only, for the folder-link editor. */
  async linearProjects(): Promise<IpcResponse<PlanQueueLinearProjectChoices>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearProjects()) as IpcResponse<PlanQueueLinearProjectChoices>;
  }

  /** The saved folder links, each re-checked against its folder on disk. */
  async linearLinks(): Promise<IpcResponse<PlanQueueLinearLinksReading>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearLinks()) as IpcResponse<PlanQueueLinearLinksReading>;
  }

  /** Checks every row of the list in the main process and saves all of it or none of it. */
  async linearLinksSave(links: readonly unknown[]): Promise<IpcResponse<PlanQueueLinearLinksSaveResult>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearLinksSave({ links: [...links] })) as IpcResponse<PlanQueueLinearLinksSaveResult>;
  }

  /** The teams with a linked project or saved rules, with their statuses and what is offered for each. */
  async linearTeamChoices(): Promise<IpcResponse<PlanQueueLinearTeamChoices>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearTeamChoices()) as IpcResponse<PlanQueueLinearTeamChoices>;
  }

  /** Checks every saved team against Linear now. */
  async linearTeamsCheck(): Promise<IpcResponse<PlanQueueLinearTeamsCheck>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearTeamsCheck()) as IpcResponse<PlanQueueLinearTeamsCheck>;
  }

  /** Saves the whole team list, or nothing, with a reason for each refused row. */
  async linearTeamsSave(teams: readonly unknown[]): Promise<IpcResponse<PlanQueueLinearTeamsSaveResult>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearTeamsSave({ teams: [...teams] })) as IpcResponse<PlanQueueLinearTeamsSaveResult>;
  }

  /** The Start preview for a folder: its Linear tickets, built from their basic fields only. */
  async linearPreviewLoad(folder: string): Promise<IpcResponse<PlanQueueLinearPreview>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearPreviewLoad({ folder })) as IpcResponse<PlanQueueLinearPreview>;
  }

  /** One ticket's description and comments from a preview, as plain strings. */
  async linearPreviewText(previewId: string, linearId: string): Promise<IpcResponse<PlanQueueLinearPreviewText>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearPreviewText({ previewId, linearId })) as IpcResponse<PlanQueueLinearPreviewText>;
  }

  /** Starts a Linear run from the ticked tickets of a preview. */
  async linearStart(payload: PlanQueueLinearStartPayload): Promise<IpcResponse<{ run: PlanQueueRunDto; excluded: string[] }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueLinearStart(payload)) as IpcResponse<{ run: PlanQueueRunDto; excluded: string[] }>;
  }

  onStateChanged(cb: (event: PlanQueueStateChangedEvent) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPlanQueueStateChanged((payload) => {
      this.zone.run(() => cb(payload as PlanQueueStateChangedEvent));
    });
  }
}
