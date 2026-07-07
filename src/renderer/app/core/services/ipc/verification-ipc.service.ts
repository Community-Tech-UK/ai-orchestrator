/**
 * Verification IPC Service - Verification and multi-model operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class VerificationIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // Verification
  // ============================================

  /**
   * Start CLI-based verification
   */
  async verificationStartCli(payload: {
    id: string;
    prompt: string;
    context?: string;
    config: {
      cliAgents?: string[];
      agentCount?: number;
      synthesisStrategy?: string;
      personalities?: string[];
      confidenceThreshold?: number;
      timeout?: number;
      maxDebateRounds?: number;
      fallbackToApi?: boolean;
      mixedMode?: boolean;
    };
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationStartCli(payload);
  }

  /**
   * Cancel an ongoing verification
   */
  async verificationCancel(verificationId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationCancel({ id: verificationId });
  }

}
