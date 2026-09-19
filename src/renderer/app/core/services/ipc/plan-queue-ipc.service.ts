import { Injectable, inject } from '@angular/core';
import type {
  PlanQueueAlert,
  PlanQueueControlPayload,
  PlanQueueKind,
  PlanQueueRunDto,
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

  async list(limit?: number): Promise<IpcResponse<{ runs: PlanQueueRunDto[]; alerts: PlanQueueAlert[] }>> {
    if (!this.api) return notInElectron();
    return (await this.api.planQueueList(limit ? { limit } : undefined)) as IpcResponse<{
      runs: PlanQueueRunDto[];
      alerts: PlanQueueAlert[];
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

  async start(payload: {
    parentInstanceId: string;
    kind: PlanQueueKind;
    workspaceCwd: string;
    glob?: string;
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

  onStateChanged(cb: (event: PlanQueueStateChangedPush) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPlanQueueStateChanged((payload) => {
      this.zone.run(() => cb(payload as PlanQueueStateChangedPush));
    });
  }
}
