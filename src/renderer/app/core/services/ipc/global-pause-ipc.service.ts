import { Injectable, inject } from '@angular/core';
import { GlobalPauseStateSchema, type GlobalPauseState } from '@contracts/schemas/global-pause';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export type GlobalPauseCommand = 'hold' | 'release' | 'restart' | 'skip-notes' | 'resume' | 'discard' | 'pick-up';

@Injectable({ providedIn: 'root' })
export class GlobalPauseIpcService {
  private readonly base = inject(ElectronIpcService);

  getState(): Promise<IpcResponse<GlobalPauseState>> {
    return this.base.invoke('global-pause:get-state');
  }

  command(command: GlobalPauseCommand, payload?: unknown): Promise<IpcResponse<GlobalPauseState>> {
    return this.base.invoke(`global-pause:${command}`, payload);
  }

  onStateChanged(callback: (state: GlobalPauseState) => void): () => void {
    return this.base.on('global-pause:state-changed', payload => {
      const parsed = GlobalPauseStateSchema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    });
  }

  quit(): Promise<IpcResponse> {
    return this.base.invoke('global-pause:quit');
  }
}
