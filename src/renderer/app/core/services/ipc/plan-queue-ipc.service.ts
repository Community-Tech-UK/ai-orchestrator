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
  PlanQueueLinearListResult,
} from '@contracts/schemas/plan-queue';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

/** Payload of the `plan-queue:state-changed` push event. */
export interface PlanQueueStateChangedPush {
  runId: string;
  itemId?: string;
  run: PlanQueueRunDto | null;
}

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

  onStateChanged(cb: (event: PlanQueueStateChangedPush) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPlanQueueStateChanged((payload) => {
      this.zone.run(() => cb(payload as PlanQueueStateChangedPush));
    });
  }
}
