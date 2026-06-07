/**
 * App IPC Service - Application-level operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { StartupCapabilityReport } from '../../../../../shared/types/startup-capability.types';
import type { StateSyncSnapshot } from '../../../../../shared/types/thin-client-event.types';

@Injectable({ providedIn: 'root' })
export class AppIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  /**
   * Signal app ready
   */
  async appReady(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.appReady();
  }

  /**
   * Get app version
   */
  async getVersion(): Promise<string> {
    if (!this.api) return '0.0.0-browser';
    const response = await this.api.getVersion();
    return response.success ? (response.data as string) : '0.0.0';
  }

  /**
   * Absolute path to the scratch directory used by general (no-workspace)
   * chats. Returns null when not running inside Electron.
   */
  async getScratchDirectory(): Promise<string | null> {
    if (!this.api) return null;
    const response = await this.api.getScratchDirectory();
    return response.success ? (response.data as string) : null;
  }

  async getStartupCapabilities(): Promise<StartupCapabilityReport | null> {
    if (!this.api) return null;
    const response = await this.api.getStartupCapabilities();
    return response.success ? (response.data as StartupCapabilityReport) : null;
  }

  async stateResync(): Promise<IpcResponse<StateSyncSnapshot>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.stateResync() as Promise<IpcResponse<StateSyncSnapshot>>;
  }

  onStartupCapabilities(callback: (report: StartupCapabilityReport) => void): () => void {
    if (!this.api) return () => void 0;
    return this.api.onStartupCapabilities((report) => {
      callback(report as StartupCapabilityReport);
    });
  }
}
