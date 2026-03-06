import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { RemoteObserverStatus } from '../../../../../shared/types/remote-observer.types';

@Injectable({ providedIn: 'root' })
export class RemoteObserverIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async getStatus(): Promise<IpcResponse<RemoteObserverStatus>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.remoteObserverGetStatus() as Promise<IpcResponse<RemoteObserverStatus>>;
  }

  async start(host?: string, port?: number): Promise<IpcResponse<RemoteObserverStatus>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.remoteObserverStart({ host, port }) as Promise<IpcResponse<RemoteObserverStatus>>;
  }

  async stop(): Promise<IpcResponse<RemoteObserverStatus>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.remoteObserverStop() as Promise<IpcResponse<RemoteObserverStatus>>;
  }

  async rotateToken(): Promise<IpcResponse<RemoteObserverStatus>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.remoteObserverRotateToken() as Promise<IpcResponse<RemoteObserverStatus>>;
  }
}
