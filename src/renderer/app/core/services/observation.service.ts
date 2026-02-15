/**
 * Observation Service - Frontend bridge for observation memory system
 * Wraps IPC calls to the main process observation subsystem
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './ipc/electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class ObservationService {
  private ipc = inject(ElectronIpcService);

  async getStats(): Promise<IpcResponse> {
    return this.ipc.invoke('observation:get-stats');
  }

  async getReflections(options?: { minConfidence?: number; limit?: number }): Promise<IpcResponse> {
    return this.ipc.invoke('observation:get-reflections', options);
  }

  async getObservations(options?: { since?: number; limit?: number }): Promise<IpcResponse> {
    return this.ipc.invoke('observation:get-observations', options);
  }

  async configure(config: Record<string, unknown>): Promise<IpcResponse> {
    return this.ipc.invoke('observation:configure', config);
  }

  async getConfig(): Promise<IpcResponse> {
    return this.ipc.invoke('observation:get-config');
  }

  async forceReflect(): Promise<IpcResponse> {
    return this.ipc.invoke('observation:force-reflect');
  }

  async cleanup(): Promise<IpcResponse> {
    return this.ipc.invoke('observation:cleanup');
  }
}
