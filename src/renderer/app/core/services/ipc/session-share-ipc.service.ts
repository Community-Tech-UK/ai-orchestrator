import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class SessionShareIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async previewForInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionSharePreview({ instanceId });
  }

  async previewForHistory(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionSharePreview({ entryId });
  }

  async saveForInstance(instanceId: string, filePath?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionShareSave({ instanceId, filePath });
  }

  async saveForHistory(entryId: string, filePath?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionShareSave({ entryId, filePath });
  }

  async loadBundle(filePath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionShareLoad({ filePath });
  }

  async replayBundle(
    filePath: string,
    workingDirectory: string,
    displayName?: string,
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sessionShareReplay({ filePath, workingDirectory, displayName });
  }
}

