import { Injectable, inject } from '@angular/core';
import type { PauseDetectorEvent, PauseStatePayload } from '@contracts/schemas/pause';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class PauseIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async pauseGetState(): Promise<IpcResponse<PauseStatePayload>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pauseGetState() as Promise<IpcResponse<PauseStatePayload>>;
  }

  async pauseSetManual(paused: boolean): Promise<IpcResponse<PauseStatePayload>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pauseSetManual({ paused }) as Promise<IpcResponse<PauseStatePayload>>;
  }

  async pauseDetectorRecentEvents(): Promise<IpcResponse<{ events: PauseDetectorEvent[] }>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pauseDetectorRecentEvents() as Promise<
      IpcResponse<{ events: PauseDetectorEvent[] }>
    >;
  }

  async pauseDetectorResumeAfterError(): Promise<IpcResponse<PauseStatePayload>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pauseDetectorResumeAfterError() as Promise<IpcResponse<PauseStatePayload>>;
  }

  onPauseStateChanged(callback: (state: PauseStatePayload) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onPauseStateChanged((payload) => {
      this.ngZone.run(() => callback(payload as PauseStatePayload));
    });
  }
}
