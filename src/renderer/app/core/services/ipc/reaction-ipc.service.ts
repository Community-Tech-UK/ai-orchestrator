import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export interface ReactionConfigDto {
  enabled: boolean;
  pollIntervalMs: number;
}

function notInElectron(): IpcResponse {
  return { success: false, error: { message: 'Not in Electron' } };
}

@Injectable({ providedIn: 'root' })
export class ReactionIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async getConfig(): Promise<IpcResponse<ReactionConfigDto>> {
    if (!this.api) return notInElectron() as IpcResponse<ReactionConfigDto>;
    return (await this.api.reactionGetConfig()) as IpcResponse<ReactionConfigDto>;
  }

  async updateConfig(payload: { enabled?: boolean; pollIntervalMs?: number }): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.reactionUpdateConfig(payload);
  }

  async setArmed(instanceId: string, armed: boolean): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.reactionSetArmed({ instanceId, armed });
  }

  /**
   * Opt an instance into (or out of) auto-merge. Destructive: the main process
   * additionally requires the instance to be armed and the PR to pass live
   * precondition checks before it will actually merge. Returns the effective
   * state (a no-op when the instance is not armed).
   */
  async setAutoMergeAllowed(instanceId: string, allowed: boolean): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.reactionSetAutoMerge({ instanceId, allowed });
  }

  async getState(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.reactionGetState({ instanceId });
  }

  onReactionEvent(cb: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onReactionEvent(cb);
  }
}
