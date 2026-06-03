/**
 * Compare IPC Service — multi-provider "Ask Council" compare (backlog #11 / E4).
 *
 * Wraps the two compare channels exposed by the infrastructure preload domain:
 *   compareListProviders  — which providers are currently installed
 *   compareRun            — fan out a prompt to N providers and return all answers
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class CompareIpcService {
  private readonly base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  /** Return the list of currently-installed provider names. */
  async compareListProviders(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareListProviders();
  }

  /** Fan out `prompt` to `providers` and return per-provider results. */
  async compareRun(payload: {
    prompt: string;
    providers: string[];
    workingDirectory?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareRun(payload);
  }
}
